// ── NodeOnly: server-side JWT ────────────────────────────────────────────────
// Upstream uses client-side ECDSA JWT (crypto.subtle) which requires Secure
// Context (HTTPS/localhost). NodeOnly needs HTTP remote access, so JWT
// signing is moved to the server. The client only caches and forwards
// server-issued tokens. If upstream changes its auth flow, sync manually.
// Server counterpart: server/node/server.cjs (createServerJwt, checkAuth,
// /api/login, /api/token/refresh)
import { language } from "src/lang"
import { alertInput, waitAlert, notifyError } from "../alert"
import { decodeRisuSave, encodeRisuSaveLegacy } from "./risuSave"
import { normalizeChat, type character, type ChatStub, type ChatFolder, type loreBook } from "./database.svelte"

// Custom error class for database conflict detection
export class ConflictError extends Error {
    currentEtag: string
    constructor(message: string, currentEtag: string) {
        super(message)
        this.name = 'ConflictError'
        this.currentEtag = currentEtag
    }
}

// Last known-good rl_chats.updated_at per chat, used as an optimistic
// concurrency token for saveChatContent's full-replace PUT. Module-level
// (not per-NodeStorage-instance) so every caller shares the same view
// regardless of how many NodeStorage instances exist in the app.
const chatUpdatedAtCache = new Map<string, number>()

// Thrown by saveChatContent when the same account already has a newer save
// for this chat (e.g. the same login open in two tabs/devices at once) —
// see the expected_updated_at comment on upsertChatFull in chatApi.cjs.
export class ChatConflictError extends Error {
    constructor(chatId: string) {
        super(`Chat ${chatId} was saved elsewhere more recently — not overwriting`)
        this.name = 'ChatConflictError'
    }
}

// Thrown by lockSharedLorebookEntry when someone else already holds the lock.
export class SharedLorebookLockedError extends Error {
    lockedByUsername: string | null
    lockedAt: number | null
    constructor(lockedByUsername: string | null, lockedAt: number | null) {
        super(`Entry locked by ${lockedByUsername ?? 'another user'}`)
        this.name = 'SharedLorebookLockedError'
        this.lockedByUsername = lockedByUsername
        this.lockedAt = lockedAt
    }
}

export interface SharedLorebookLock {
    locked_by: number
    locked_by_username: string | null
    locked_at: number
}

export type SharedLorebookScope = 'global' | 'private'

// Per-viewer activation preference for one entry of a global lorebook.
// Absent for an entry == 'trigger' (the default) — see PUT .../overrides.
export type SharedLorebookOverrideMode = 'always' | 'trigger' | 'disabled'

export interface SharedLorebookOverride {
    entry_id: string
    mode: SharedLorebookOverrideMode
}

export interface SharedLorebookSummary {
    id: string
    title: string
    scope: SharedLorebookScope
    owner_id: number | null
    updated_at: number
    updated_by: number
    updated_by_username: string | null
}

export interface SharedLorebookDetail extends SharedLorebookSummary {
    content: loreBook[]
    /** Only present for scope === 'global' — the requester's own overrides. */
    overrides?: SharedLorebookOverride[]
    /** Only present for scope === 'global' — live locks keyed by entry id. */
    locks?: Record<string, SharedLorebookLock>
}

export interface SharedLorebookVersion {
    id: string
    content: loreBook[]
    saved_at: number
    saved_by: number
    saved_by_username: string | null
}

// Warning the server attaches to /api/patch responses when the most recent
// debounced persist failed (Stage 1 visibility — see issues.md).
export interface PersistWarning {
    timestamp: number
    message: string
    attemptedSize: number | null
    source: string
}

export interface PatchItemResult {
    success: boolean
    etag?: string
    persistWarning?: PersistWarning
    /** Set when the server's chat-internal-field guard rejected the patch. */
    chatGuardRejected?: boolean
}

export class NodeStorage{
    private static readonly BULK_WRITE_CLIENT_BATCH = 20

    // Unique per page load — used for cross-device single-writer lock
    private static sessionId: string =
        crypto?.randomUUID?.() ?? (Date.now().toString(36) + Math.random().toString(36).slice(2))

    _lastDbEtag: string | null = null
    authChecked = false
    private cachedJwt: { token: string; expiresAt: number } | null = null
    private static sessionInitialized = false
    private static sessionPending: Promise<void> | null = null
    private refreshPending: Promise<string> | null = null

    async createAuth(){
        const now = Date.now()
        if (this.cachedJwt && this.cachedJwt.expiresAt - now > 30_000) {
            return this.cachedJwt.token
        }
        const token = await this._refreshToken()
        return token
    }

    // Called once after JWT auth is confirmed. Issues a session cookie so that
    // <img src="/api/asset/..."> can be served without JS-injected headers.
    private async initSession() {
        if (NodeStorage.sessionInitialized) return
        if (NodeStorage.sessionPending) return NodeStorage.sessionPending
        NodeStorage.sessionPending = this._doInitSession()
        return NodeStorage.sessionPending
    }

    private async _doInitSession() {
        try {
            const res = await fetch('/api/session', {
                method: 'POST',
                headers: {
                    'risu-auth': await this.createAuth(),
                    'x-session-id': NodeStorage.sessionId,
                },
            })
            if (res.ok) {
                NodeStorage.sessionInitialized = true
            }
            // Non-ok (400/401/500): will retry on next checkAuth() call.
        } catch {
            // Network error: will retry on next checkAuth() call.
        } finally {
            NodeStorage.sessionPending = null
        }
    }

    private async _refreshToken(): Promise<string> {
        if (this.refreshPending) return this.refreshPending
        this.refreshPending = this._doRefreshToken()
        try { return await this.refreshPending }
        finally { this.refreshPending = null }
    }

    private async _doRefreshToken(): Promise<string> {
        const res = await fetch('/api/token/refresh', {
            method: 'POST',
            headers: { 'risu-auth': this.cachedJwt?.token ?? '' }
        })
        if (res.ok) {
            const data = await res.json()
            this.cachedJwt = { token: data.token, expiresAt: Date.now() + 5 * 60 * 1000 }
            return data.token
        }
        return this.cachedJwt?.token ?? ''
    }

    private async loginWithPassword(password: string) {
        const response = await fetch('/api/login', {
            method: "POST",
            body: JSON.stringify({ password }),
            headers: {
                'content-type': 'application/json'
            }
        })

        if(response.status === 429){
            notifyError(`Too many attempts. Please wait and try again later.`)
            await waitAlert()
            throw new Error('Too many login attempts')
        }

        if(response.status < 200 || response.status >= 300){
            let message = 'Node login failed'
            try {
                const data = await response.json()
                message = data.error ?? message
            } catch {
                // noop
            }
            throw new Error(message)
        }

        const data = await response.json()
        if (data.token) {
            this.cachedJwt = { token: data.token, expiresAt: Date.now() + 5 * 60 * 1000 }
        }
        this.authChecked = true
    }

    private async shouldRetryAuth(response: Response) {
        if(response.status !== 400 && response.status !== 401){
            return false
        }

        try {
            const data = await response.clone().json()
            return [
                'No auth header',
                'Invalid Signature',
                'Token Expired'
            ].includes(data?.error)
        } catch {
            return false
        }
    }

    private async authFetch(input: RequestInfo | URL, init: RequestInit = {}, retry = true) {
        await this.checkAuth()
        const headers = new Headers(init.headers)
        headers.set('risu-auth', await this.createAuth())
        headers.set('x-session-id', NodeStorage.sessionId)

        const response = await fetch(input, {
            ...init,
            headers
        })

        if (response.status === 423) {
            window.dispatchEvent(new CustomEvent('risu-session-deactivated'))
        }

        if(retry && await this.shouldRetryAuth(response)){
            this.authChecked = false
            this.cachedJwt = null
            await this.checkAuth()
            return this.authFetch(input, init, false)
        }

        return response
    }

    async setItem(key:string, value:Uint8Array, etag?:string) {
        const headers: Record<string, string> = {
            'content-type': 'application/octet-stream',
            'file-path': Buffer.from(key, 'utf-8').toString('hex')
        }
        if (etag) {
            headers['x-if-match'] = etag
        }
        const da = await this.authFetch('/api/write', {
            method: "POST",
            body: value as any,
            headers
        })
        if(da.status === 409){
            const data = await da.json()
            throw new ConflictError(data.error, data.currentEtag)
        }
        if(da.status < 200 || da.status >= 300){
            throw "setItem Error"
        }
        const data = await da.json()
        if(data.error){
            throw data.error
        }
        const nextEtag = data.etag as string | undefined
        if (key === 'database/database.bin' && nextEtag) {
            this._lastDbEtag = nextEtag
        }
    }
    async getItem(key:string):Promise<Buffer> {
        const headers: Record<string, string> = {
            'file-path': Buffer.from(key, 'utf-8').toString('hex')
        }

        const da = await this.authFetch('/api/read', { method: "GET", headers })
        if(da.status < 200 || da.status >= 300){
            throw "getItem Error"
        }

        // Capture ETag for database.bin
        const etag = da.headers.get('x-db-etag')
        if (etag) {
            this._lastDbEtag = etag
        }

        const data = Buffer.from(await da.arrayBuffer())
        if (data.length === 0){
            return null
        }

        return data
    }
    async keys(prefix: string = ''):Promise<string[]>{
        const headers: Record<string, string> = {
        }
        if (prefix) {
            headers['key-prefix'] = prefix
        }
        const da = await this.authFetch('/api/list', {
            method: "GET",
            headers
        })
        if(da.status < 200 || da.status >= 300){
            throw "listItem Error"
        }
        const data = await da.json()
        if(data.error){
            throw data.error
        }
        return data.content
    }
    async removeItem(key:string){
        const da = await this.authFetch('/api/remove', {
            method: "GET",
            headers: {
                'file-path': Buffer.from(key, 'utf-8').toString('hex')
            }
        })
        if(da.status < 200 || da.status >= 300){
            throw "removeItem Error"
        }
        const data = await da.json()
        if(data.error){
            throw data.error
        }
    }

    private async checkAuth(){

        if(!this.authChecked){
            const data = await (await fetch('/api/test_auth',{
                headers: {
                    'risu-auth': this.cachedJwt?.token ?? ''
                }
            })).json()

            if(data.status === 'unset'){
                const input = await digestPassword(await alertInput(language.setNodePassword))
                const response = await fetch('/api/set_password',{
                    method: "POST",
                    body:JSON.stringify({
                        password: input 
                    }),
                    headers: {
                        'content-type': 'application/json'
                    }
                })

                if(response.status < 200 || response.status >= 300){
                    throw new Error('Failed to set node password')
                }

                await this.loginWithPassword(input)
                await this.initSession()
                return
            }
            else if(data.status === 'incorrect'){
                const input = await digestPassword(await alertInput(language.inputNodePassword))
                await this.loginWithPassword(input)
                await this.initSession()
                return
            }
            else{
                if (data.token) {
                    this.cachedJwt = { token: data.token, expiresAt: Date.now() + 5 * 60 * 1000 }
                }
                this.authChecked = true
            }
        }
        await this.initSession()
    }

    listItem = this.keys

    /** Set cached ETag for database.bin */
    setDbEtag(etag: string | null) {
        this._lastDbEtag = etag
    }

    async patchItem(key: string, patchData: { patch: any[], expectedHash: string }): Promise<PatchItemResult> {
        const da = await this.authFetch('/api/patch', {
            method: "POST",
            body: JSON.stringify(patchData),
            headers: {
                'content-type': 'application/json',
                'file-path': Buffer.from(key, 'utf-8').toString('hex')
            }
        })

        if (da.status === 409) {
            const data = await da.json()
            const currentEtag = data.currentEtag as string | undefined
            if (key === 'database/database.bin' && currentEtag) {
                this._lastDbEtag = currentEtag
            }
            // Server signals chat-guard rejection via explicit fields. The
            // error string fallback is kept for forward-compat with deployed
            // servers that haven't shipped the explicit fields yet.
            const rejectedByChatGuard = data.chatGuardRejected === true
                || data.code === 'CHAT_GUARD_REJECTED'
                || (typeof data.error === 'string' && data.error.includes('chat-internal field ops'))
            return { success: false, etag: currentEtag, chatGuardRejected: rejectedByChatGuard }
        }
        if (da.status < 200 || da.status >= 300) {
            return { success: false }
        }
        const data = await da.json()
        if (data.error) {
            return { success: false }
        }
        const nextEtag = data.etag as string | undefined
        if (key === 'database/database.bin' && nextEtag) {
            this._lastDbEtag = nextEtag
        }
        const persistWarning = data.persistWarning as PersistWarning | undefined
        return { success: true, etag: nextEtag, persistWarning }
    }

    // ── Bulk asset operations (3-2-B) ──────────────────────────────────────────
    async getItems(keys: string[]): Promise<{key: string, value: Buffer}[]> {
        const da = await this.authFetch('/api/assets/bulk-read', {
            method: 'POST',
            body: JSON.stringify(keys),
            headers: {
                'content-type': 'application/json',
                'accept': 'application/octet-stream'
            }
        })
        if (da.status < 200 || da.status >= 300) throw 'getItems Error'

        const ct = da.headers.get('content-type') || ''
        if (ct.includes('application/octet-stream')) {
            // Binary protocol: [count(4)] then per entry: [keyLen(4)][key][valLen(4)][value]
            const buf = Buffer.from(await da.arrayBuffer())
            let offset = 0
            const count = buf.readUInt32BE(offset); offset += 4
            const results: {key: string, value: Buffer}[] = []
            for (let i = 0; i < count; i++) {
                const keyLen = buf.readUInt32BE(offset); offset += 4
                const key = buf.subarray(offset, offset + keyLen).toString('utf-8'); offset += keyLen
                const valLen = buf.readUInt32BE(offset); offset += 4
                const value = buf.subarray(offset, offset + valLen) as Buffer; offset += valLen
                results.push({ key, value })
            }
            return results
        }

        // Fallback: JSON+base64
        const results: {key: string, value: string}[] = await da.json()
        return results.map(r => ({ key: r.key, value: Buffer.from(r.value, 'base64') }))
    }

    async setItems(entries: {key: string, value: Uint8Array}[]) {
        for (let i = 0; i < entries.length; i += NodeStorage.BULK_WRITE_CLIENT_BATCH) {
            const batch = entries.slice(i, i + NodeStorage.BULK_WRITE_CLIENT_BATCH)
            const body = batch.map(e => ({
                key: e.key,
                value: Buffer.from(e.value).toString('base64')
            }))
            const da = await this.authFetch('/api/assets/bulk-write', {
                method: 'POST',
                body: JSON.stringify(body),
                headers: {
                    'content-type': 'application/json'
                }
            })
            if (da.status < 200 || da.status >= 300) throw 'setItems Error'
        }
    }

    async exportBackup(opts?: { target?: 'upstream' }): Promise<Response> {
        const url = opts?.target === 'upstream'
            ? '/api/backup/export?target=upstream'
            : '/api/backup/export'
        const da = await this.authFetch(url)
        if (da.status < 200 || da.status >= 300) throw `backup export error: ${da.status}`
        return da
    }

    async prepareImport(size: number): Promise<void> {
        const da = await this.authFetch('/api/backup/import/prepare', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ size }),
        })
        if (da.status === 409) throw new Error('Another import is already in progress')
        if (da.status === 413) throw new Error('Backup file is too large')
        if (da.status === 507) {
            const body = await da.json().catch(() => ({}))
            const avail = body.available != null ? ` (available: ${Math.round(body.available / 1024 / 1024)} MB)` : ''
            throw new Error(`Insufficient disk space${avail}`)
        }
        if (da.status < 200 || da.status >= 300) throw new Error(`backup prepare error: ${da.status}`)
    }

    async importBackup(
        file: Blob,
        onProgress?: (loaded: number, total: number) => void
    ): Promise<{ok: boolean, assetsRestored: number, coldStorageFailed?: number}> {
        await this.prepareImport(file.size)
        const authHeader = await this.createAuth()

        return await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest()
            xhr.open('POST', '/api/backup/import')
            xhr.setRequestHeader('content-type', 'application/x-risu-backup')
            xhr.setRequestHeader('risu-auth', authHeader)
            xhr.setRequestHeader('x-session-id', NodeStorage.sessionId)
            // Opt into NDJSON streaming so the server keeps the response socket
            // alive during long post-upload work — prevents reverse-proxy 502s.
            xhr.setRequestHeader('accept', 'application/x-ndjson')

            let uploadComplete = false
            xhr.upload.onprogress = (event) => {
                if (event.lengthComputable) {
                    onProgress?.(event.loaded, event.total)
                }
            }
            xhr.upload.onload = () => { uploadComplete = true }

            let parsedIndex = 0
            let leftover = ''
            let result: {ok: boolean, assetsRestored: number, coldStorageFailed?: number} | null = null
            let serverErrorMsg: string | null = null

            const drainNdjson = () => {
                const text = xhr.responseText
                if (text.length <= parsedIndex) return
                leftover += text.slice(parsedIndex)
                parsedIndex = text.length
                const lines = leftover.split('\n')
                leftover = lines.pop() ?? ''
                for (const line of lines) {
                    if (!line) continue
                    let msg: any
                    try { msg = JSON.parse(line) } catch { continue }
                    if (msg.type === 'progress' && uploadComplete) {
                        // After upload finishes, surface server-side processing
                        // progress through the same callback for UI continuity.
                        onProgress?.(msg.bytes, msg.totalBytes)
                    } else if (msg.type === 'done') {
                        result = msg
                    } else if (msg.type === 'error') {
                        serverErrorMsg = typeof msg.message === 'string' ? msg.message : 'backup import failed'
                    }
                    // Ignore 'heartbeat' and unknown event types.
                }
            }

            xhr.onprogress = drainNdjson
            xhr.onerror = () => reject(new Error('backup import request failed'))
            xhr.onload = () => {
                if (xhr.status < 200 || xhr.status >= 300) {
                    let msg = `backup import error: ${xhr.status}`
                    try {
                        const body = JSON.parse(xhr.responseText)
                        if (body?.error) msg = String(body.error)
                    } catch {}
                    reject(new Error(msg))
                    return
                }
                drainNdjson()
                if (serverErrorMsg) reject(new Error(serverErrorMsg))
                else if (result) resolve(result)
                else reject(new Error('backup import: no result received'))
            }

            xhr.send(file)
        })
    }

    // ── Server-side backup ─────────────────────────────────────────────────────

    async saveServerBackup(
        onProgress?: (current: number, total: number, bytes: number, totalBytes: number) => void
    ): Promise<{ok: boolean, filename: string, size: number}> {
        const da = await this.authFetch('/api/backup/server/save', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-session-id': NodeStorage.sessionId,
            },
        })
        if (da.status < 200 || da.status >= 300) {
            const body = await da.json().catch(() => ({}))
            throw new Error(body.error || `server backup save error: ${da.status}`)
        }

        const reader = da.body!.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let result: {ok: boolean, filename: string, size: number} | null = null

        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop()!
            for (const line of lines) {
                if (!line) continue
                const msg = JSON.parse(line)
                if (msg.type === 'progress') {
                    onProgress?.(msg.current, msg.total, msg.bytes, msg.totalBytes)
                } else if (msg.type === 'done') {
                    result = msg
                } else if (msg.type === 'error') {
                    throw new Error(msg.message)
                }
            }
        }
        if (!result) throw new Error('Server backup: no result received')
        return result
    }

    async listServerBackups(): Promise<{backups: Array<{filename: string, size: number, createdAt: number}>}> {
        const da = await this.authFetch('/api/backup/server/list')
        if (da.status < 200 || da.status >= 300) throw new Error(`server backup list error: ${da.status}`)
        return da.json()
    }

    async restoreServerBackup(
        filename: string,
        onProgress?: (bytes: number, totalBytes: number) => void
    ): Promise<{ok: boolean, assetsRestored: number, coldStorageFailed?: number}> {
        const da = await this.authFetch('/api/backup/server/restore', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-session-id': NodeStorage.sessionId,
            },
            body: JSON.stringify({ filename }),
        })
        if (da.status === 404) throw new Error('Backup file not found')
        if (da.status === 409) throw new Error('Another import is already in progress')
        if (da.status < 200 || da.status >= 300) {
            const body = await da.json().catch(() => ({}))
            throw new Error(body.error || `server backup restore error: ${da.status}`)
        }

        const reader = da.body!.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let result: {ok: boolean, assetsRestored: number, coldStorageFailed?: number} | null = null

        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop()!
            for (const line of lines) {
                if (!line) continue
                const msg = JSON.parse(line)
                if (msg.type === 'progress') {
                    onProgress?.(msg.bytes, msg.totalBytes)
                } else if (msg.type === 'done') {
                    result = msg
                } else if (msg.type === 'error') {
                    throw new Error(msg.message)
                }
            }
        }
        if (!result) throw new Error('Server backup restore: no result received')
        return result
    }

    async deleteServerBackup(filename: string): Promise<void> {
        const da = await this.authFetch(`/api/backup/server/${encodeURIComponent(filename)}`, {
            method: 'DELETE',
        })
        if (da.status === 404) throw new Error('Backup file not found')
        if (da.status < 200 || da.status >= 300) throw new Error(`server backup delete error: ${da.status}`)
    }

    async downloadServerBackup(filename: string): Promise<Response> {
        const da = await this.authFetch(`/api/backup/server/download/${encodeURIComponent(filename)}`)
        if (da.status === 404) throw new Error('Backup file not found')
        if (da.status < 200 || da.status >= 300) throw new Error(`server backup download error: ${da.status}`)
        return da
    }

    // ── Chat content (runtime lazy load) ────────────────────────────────────

    async fetchChatContent(chaId: string, chatIndex: number, chatId: string): Promise<any | null> {
        // Try new rl_chats storage first
        const da = await this.authFetch(`/api/chats/${encodeURIComponent(chatId)}`)
        if (da.ok) {
            const json = await da.json()
            const messages = (json.messages ?? []).map((row: any) =>
                typeof row.content === 'string' ? JSON.parse(row.content) : row.content
            )
            const meta = json.chat_meta
                ? (typeof json.chat_meta === 'string' ? JSON.parse(json.chat_meta) : json.chat_meta)
                : {}
            if (typeof json.updated_at === 'number') chatUpdatedAtCache.set(chatId, json.updated_at)
            const chat = normalizeChat({ ...meta, id: json.id, name: json.title, message: messages })
            // folder_id is a dedicated column kept up to date by drag-and-drop
            // moves (PATCH /meta, PATCH /reorder) — those never touch
            // chat_meta, so meta.folderId can be stale. The column is always
            // authoritative when present.
            if (json.folder_id != null) {
                chat.folderId = json.folder_id
            } else {
                delete chat.folderId
            }
            return chat
        }
        if (da.status !== 404) throw new Error(`fetchChatContent error: ${da.status}`)

        // Fallback: old binary endpoint for chats not yet migrated
        const da2 = await this.authFetch(`/api/chat-content/${encodeURIComponent(chaId)}/${chatIndex}`, {
            headers: { 'x-chat-id': chatId },
        })
        if (da2.status === 404) return null
        if (!da2.ok) throw new Error(`fetchChatContent error: ${da2.status}`)
        const buffer = new Uint8Array(await da2.arrayBuffer())
        const chat = normalizeChat(await decodeRisuSave(buffer))
        // Migrate on first open — fire and forget
        this.saveChatContent(chaId, chatIndex, chatId, chat).catch(() => {})
        return chat
    }

    async saveChatContent(chaId: string, chatIndex: number, chatId: string, chat: any): Promise<void> {
        const { message: messages, name: title, id: _id, _placeholder: _ph, ...chatMeta } = chat
        const expectedUpdatedAt = chatUpdatedAtCache.get(chatId)
        const da = await this.authFetch(`/api/chats/${encodeURIComponent(chatId)}/full`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                character_id: chaId,
                title: title ?? '',
                chat_meta: chatMeta,
                messages: (messages ?? []).map((msg: any, idx: number) => ({
                    role: msg.role,
                    content: msg,
                    sort_order: idx,
                })),
                // Omitted (undefined) the first time we save a chat we never
                // fetched from the server — the server skips the check in
                // that case, same as x-session-id's "no version support" path.
                expected_updated_at: expectedUpdatedAt,
            }),
        })
        if (da.status === 409) {
            const data = await da.json().catch(() => ({}))
            // Someone else's save landed first — refresh our baseline so the
            // *next* attempt (after the user reloads, or edits again) checks
            // against current reality instead of repeating the same conflict.
            if (typeof data.updated_at === 'number') chatUpdatedAtCache.set(chatId, data.updated_at)
            throw new ChatConflictError(chatId)
        }
        if (!da.ok) throw new Error(`saveChatContent error: ${da.status}`)
        const result = await da.json().catch(() => ({}))
        if (typeof result.updated_at === 'number') chatUpdatedAtCache.set(chatId, result.updated_at)
    }

    async deleteChatContent(chatId: string): Promise<void> {
        const da = await this.authFetch(`/api/chats/${encodeURIComponent(chatId)}`, {
            method: 'DELETE',
        })
        chatUpdatedAtCache.delete(chatId)
        // 404 means already gone on server — not an error
        if (da.status !== 404 && !da.ok) {
            console.error(`[Chat] deleteChatContent failed: ${da.status}`)
        }
    }

    // ── Chat list (Phase 4) ───────────────────────────────────────────────────

    async loadChatListFromServer(): Promise<Map<string, ChatStub[]>> {
        const da = await this.authFetch('/api/chats')
        if (!da.ok) throw new Error(`loadChatListFromServer: ${da.status}`)
        const rows: Array<{
            id: string
            character_id: string
            title: string
            last_date: number | null
            folder_id: string | null
            modules: string[] | null
        }> = await da.json()

        const map = new Map<string, ChatStub[]>()
        for (const row of rows) {
            const stub: ChatStub = { id: row.id, name: row.title, _stub: true }
            if (row.last_date != null) stub.lastDate = row.last_date
            if (row.folder_id != null) stub.folderId = row.folder_id
            if (Array.isArray(row.modules)) stub.modules = row.modules
            const arr = map.get(row.character_id) ?? []
            arr.push(stub)
            map.set(row.character_id, arr)
        }
        return map
    }

    // Lightweight metadata patch (folder move / rename) — skips the full
    // title+messages PUT for a single-field change.
    async updateChatMeta(chatId: string, meta: { folderId?: string | null, position?: number, title?: string }): Promise<void> {
        const body: Record<string, unknown> = {}
        if ('folderId' in meta) body.folder_id = meta.folderId
        if ('position' in meta) body.position = meta.position
        if ('title' in meta) body.title = meta.title
        const da = await this.authFetch(`/api/chats/${encodeURIComponent(chatId)}/meta`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        })
        if (!da.ok) throw new Error(`updateChatMeta error: ${da.status}`)
    }

    // Bulk position/folder update for drag-and-drop reorder.
    async reorderChats(updates: { id: string, position: number, folderId?: string | null }[]): Promise<void> {
        const da = await this.authFetch('/api/chats/reorder', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(updates.map(u => ({ id: u.id, position: u.position, folder_id: u.folderId ?? null }))),
        })
        if (!da.ok) throw new Error(`reorderChats error: ${da.status}`)
    }

    // ── Chat folders ────────────────────────────────────────────────────────
    // rl_chat_folders (chatFolderApi.cjs) — scoped per account, unlike the old
    // character.chatFolders embedded in the shared database.bin.

    private static deserializeFolderRow(row: any): ChatFolder {
        const folder: ChatFolder = { id: row.id, folded: !!row.folded }
        if (row.name != null) folder.name = row.name
        if (row.color != null) folder.color = row.color
        folder.parentId = row.parent_id ?? null
        return folder
    }

    async loadChatFoldersFromServer(chaId: string): Promise<ChatFolder[]> {
        const da = await this.authFetch(`/api/chat-folders?character_id=${encodeURIComponent(chaId)}`)
        if (!da.ok) throw new Error(`loadChatFoldersFromServer: ${da.status}`)
        const rows: any[] = await da.json()
        return rows.map(NodeStorage.deserializeFolderRow)
    }

    async createChatFolder(chaId: string, folder: { id?: string, name?: string, color?: string, parentId?: string | null }): Promise<ChatFolder> {
        const da = await this.authFetch('/api/chat-folders', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                ...(folder.id ? { id: folder.id } : {}),
                character_id: chaId,
                name: folder.name ?? '',
                color: folder.color ?? null,
                parent_id: folder.parentId ?? null,
            }),
        })
        if (!da.ok) throw new Error(`createChatFolder error: ${da.status}`)
        return NodeStorage.deserializeFolderRow(await da.json())
    }

    async updateChatFolder(folderId: string, patch: { name?: string, color?: string, folded?: boolean, parentId?: string | null, position?: number }): Promise<ChatFolder> {
        const body: Record<string, unknown> = {}
        if ('name' in patch) body.name = patch.name
        if ('color' in patch) body.color = patch.color
        if ('folded' in patch) body.folded = patch.folded
        if ('parentId' in patch) body.parent_id = patch.parentId
        if ('position' in patch) body.position = patch.position
        const da = await this.authFetch(`/api/chat-folders/${encodeURIComponent(folderId)}`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        })
        if (!da.ok) throw new Error(`updateChatFolder error: ${da.status}`)
        return NodeStorage.deserializeFolderRow(await da.json())
    }

    async deleteChatFolder(folderId: string): Promise<void> {
        const da = await this.authFetch(`/api/chat-folders/${encodeURIComponent(folderId)}`, {
            method: 'DELETE',
        })
        if (da.status !== 404 && !da.ok) throw new Error(`deleteChatFolder error: ${da.status}`)
    }

    // ── Shared lorebook repository ──────────────────────────────────────────
    // rl_lorebooks / rl_lorebook_versions / rl_lorebook_locks / rl_lorebook_drafts
    // (server/node/lorebookApi.cjs) — separate from character.globalLore.
    // content is loreBook[], the same shape used there and by
    // importLoreBook/exportLoreBook in src/ts/process/lorebook.svelte.ts,
    // minus the {type,ver} file-interchange wrapper that only exists at the
    // file boundary.
    //
    // Locking is per ENTRY, not per book — a lorebook here is just a named,
    // scoped (global/private) grouping of entries, the same as a folder in
    // the character's own lorebook list. Reading is always lock-free.
    // Structural changes (add/delete/reorder/rename) are lock-free too; only
    // actually editing one entry's content needs its lock.

    async listSharedLorebooks(): Promise<SharedLorebookSummary[]> {
        const da = await this.authFetch('/api/lorebooks')
        if (!da.ok) throw new Error(`listSharedLorebooks error: ${da.status}`)
        return da.json()
    }

    async createSharedLorebook(title: string, content: loreBook[], scope: SharedLorebookScope = 'private'): Promise<SharedLorebookDetail> {
        const da = await this.authFetch('/api/lorebooks', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title, content, scope }),
        })
        if (!da.ok) throw new Error(`createSharedLorebook error: ${da.status}`)
        return da.json()
    }

    async getSharedLorebook(id: string): Promise<SharedLorebookDetail> {
        const da = await this.authFetch(`/api/lorebooks/${encodeURIComponent(id)}`)
        if (!da.ok) throw new Error(`getSharedLorebook error: ${da.status}`)
        return da.json()
    }

    // Title-only rename. No lock needed (metadata, not content).
    async renameSharedLorebook(id: string, title: string): Promise<SharedLorebookDetail> {
        const da = await this.authFetch(`/api/lorebooks/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title }),
        })
        if (!da.ok) throw new Error(`renameSharedLorebook error: ${da.status}`)
        return da.json()
    }

    // Owner only, one-way (private → global). There is no reverse endpoint.
    async convertSharedLorebookToGlobal(id: string): Promise<SharedLorebookDetail> {
        const da = await this.authFetch(`/api/lorebooks/${encodeURIComponent(id)}/to-global`, { method: 'POST' })
        if (!da.ok) throw new Error(`convertSharedLorebookToGlobal error: ${da.status}`)
        return da.json()
    }

    // Copies a global lorebook into a new private one owned by the caller —
    // entry ids are regenerated server-side, so the clone never shares
    // per-user overrides or locks with the source.
    async cloneSharedLorebook(id: string): Promise<SharedLorebookDetail> {
        const da = await this.authFetch(`/api/lorebooks/${encodeURIComponent(id)}/clone`, { method: 'POST' })
        if (!da.ok) throw new Error(`cloneSharedLorebook error: ${da.status}`)
        return da.json()
    }

    // Global requires admin; private requires ownership (enforced server-side).
    async deleteSharedLorebook(id: string): Promise<void> {
        const da = await this.authFetch(`/api/lorebooks/${encodeURIComponent(id)}`, { method: 'DELETE' })
        if (da.status !== 404 && !da.ok) throw new Error(`deleteSharedLorebook error: ${da.status}`)
    }

    // Replaces the caller's entire override set for a global lorebook in one
    // shot. No lock required — this is the viewer's own activation
    // preference, not a content edit.
    async saveSharedLorebookOverrides(id: string, overrides: SharedLorebookOverride[]): Promise<SharedLorebookOverride[]> {
        const da = await this.authFetch(`/api/lorebooks/${encodeURIComponent(id)}/overrides`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(overrides),
        })
        if (!da.ok) throw new Error(`saveSharedLorebookOverrides error: ${da.status}`)
        return (await da.json()).overrides
    }

    async listSharedLorebookVersions(id: string): Promise<SharedLorebookVersion[]> {
        const da = await this.authFetch(`/api/lorebooks/${encodeURIComponent(id)}/versions`)
        if (!da.ok) throw new Error(`listSharedLorebookVersions error: ${da.status}`)
        return da.json()
    }

    // No lock required — reverts the whole book, so there's no single entry
    // lock to hold. private requires ownership (enforced server-side).
    async restoreSharedLorebookVersion(id: string, versionId: string): Promise<SharedLorebookDetail> {
        const da = await this.authFetch(`/api/lorebooks/${encodeURIComponent(id)}/restore/${encodeURIComponent(versionId)}`, { method: 'POST' })
        if (!da.ok) throw new Error(`restoreSharedLorebookVersion error: ${da.status}`)
        return da.json()
    }

    // ── Shared lorebook entries ─────────────────────────────────────────────

    // Structural — no lock. private requires ownership.
    async addSharedLorebookEntry(id: string, entry: Partial<loreBook>): Promise<SharedLorebookDetail> {
        const da = await this.authFetch(`/api/lorebooks/${encodeURIComponent(id)}/entries`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(entry),
        })
        if (!da.ok) throw new Error(`addSharedLorebookEntry error: ${da.status}`)
        return da.json()
    }

    // Structural — no lock to hold, but the server 409s if someone else
    // currently holds the entry's lock (avoids yanking away a live edit).
    async deleteSharedLorebookEntry(id: string, entryId: string): Promise<SharedLorebookDetail> {
        const da = await this.authFetch(`/api/lorebooks/${encodeURIComponent(id)}/entries/${encodeURIComponent(entryId)}`, { method: 'DELETE' })
        if (!da.ok) throw new Error(`deleteSharedLorebookEntry error: ${da.status}`)
        return da.json()
    }

    // body = the full ordered list of entry ids. Pure ordering, no lock.
    async reorderSharedLorebookEntries(id: string, orderedEntryIds: string[]): Promise<SharedLorebookDetail> {
        const da = await this.authFetch(`/api/lorebooks/${encodeURIComponent(id)}/entries/reorder`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(orderedEntryIds),
        })
        if (!da.ok) throw new Error(`reorderSharedLorebookEntries error: ${da.status}`)
        return da.json()
    }

    // Acquires the pessimistic, non-expiring lock on one entry and returns the
    // editor's personal copy (freshly copied from the canonical entry, or the
    // requester's own still-preserved draft from an earlier cancelled
    // session). Throws SharedLorebookLockedError if another user currently
    // holds it. Global only — private has no lock endpoint.
    async lockSharedLorebookEntry(id: string, entryId: string): Promise<{ entry: loreBook, locked_at: number }> {
        const da = await this.authFetch(`/api/lorebooks/${encodeURIComponent(id)}/entries/${encodeURIComponent(entryId)}/lock`, { method: 'POST' })
        if (da.status === 409) {
            const data = await da.json().catch(() => ({}))
            throw new SharedLorebookLockedError(data.locked_by_username ?? null, data.locked_at ?? null)
        }
        if (!da.ok) throw new Error(`lockSharedLorebookEntry error: ${da.status}`)
        return da.json()
    }

    // Cancels editing: discards the personal copy and releases the lock,
    // leaving the canonical entry untouched.
    async cancelSharedLorebookEntryLock(id: string, entryId: string): Promise<void> {
        const da = await this.authFetch(`/api/lorebooks/${encodeURIComponent(id)}/entries/${encodeURIComponent(entryId)}/lock`, { method: 'DELETE' })
        if (da.status !== 404 && !da.ok) throw new Error(`cancelSharedLorebookEntryLock error: ${da.status}`)
    }

    // Requires the caller to currently hold the entry's lock (global) or own
    // the book (private) — enforced server-side. On success the lock is
    // released and the draft cleared.
    async saveSharedLorebookEntry(id: string, entryId: string, entry: loreBook): Promise<SharedLorebookDetail> {
        const da = await this.authFetch(`/api/lorebooks/${encodeURIComponent(id)}/entries/${encodeURIComponent(entryId)}`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(entry),
        })
        if (!da.ok) throw new Error(`saveSharedLorebookEntry error: ${da.status}`)
        return da.json()
    }

    // Persists in-progress edit content to the lock holder's personal draft
    // row (rl_lorebook_drafts) — does not touch the canonical entry. Requires
    // currently holding the lock. Meant to be called on a debounce while
    // editing so a reload doesn't lose work; failures are non-fatal (the
    // edit still lives in the editor's own browser memory either way).
    async saveSharedLorebookEntryDraft(id: string, entryId: string, entry: loreBook): Promise<void> {
        const da = await this.authFetch(`/api/lorebooks/${encodeURIComponent(id)}/entries/${encodeURIComponent(entryId)}/draft`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(entry),
        })
        if (!da.ok) throw new Error(`saveSharedLorebookEntryDraft error: ${da.status}`)
    }

    // ── Bulk chat migration (Phase 3) ─────────────────────────────────────────
    // Migrates every chat in every character from the old /api/chat-content/
    // storage to rl_chats/rl_messages. Placeholders are fetched first (the
    // fetchChatContent fallback path handles the actual save); hydrated chats
    // are written directly. Errors per chat are caught and counted so a single
    // failure doesn't abort the whole batch.

    async migrateChatsToServer(
        characters: character[],
        onProgress: (done: number, total: number) => void,
    ): Promise<{ succeeded: number; failed: number }> {
        type Task = { chaId: string; chatIndex: number; chatId: string; placeholder: boolean }
        const tasks: Task[] = []

        for (const char of characters) {
            if (!char?.chaId || !Array.isArray(char.chats)) continue
            for (let i = 0; i < char.chats.length; i++) {
                const chat = char.chats[i]
                if (!chat?.id) continue
                tasks.push({ chaId: char.chaId, chatIndex: i, chatId: chat.id, placeholder: !!chat._placeholder })
            }
        }

        let succeeded = 0
        let failed = 0

        for (let i = 0; i < tasks.length; i++) {
            onProgress(i, tasks.length)
            const { chaId, chatIndex, chatId, placeholder } = tasks[i]
            try {
                if (placeholder) {
                    // fetchChatContent: tries rl_chats first; on 404 falls back to
                    // old endpoint and auto-saves to rl_chats as a side effect.
                    await this.fetchChatContent(chaId, chatIndex, chatId)
                } else {
                    // Already in memory — write directly to rl_chats (upsert).
                    const chat = characters
                        .find(c => c.chaId === chaId)?.chats[chatIndex]
                    if (chat && !chat._placeholder) {
                        await this.saveChatContent(chaId, chatIndex, chatId, chat)
                    }
                }
                succeeded++
            } catch (e) {
                console.error(`[Migrate] ${chatId}:`, e)
                failed++
            }
        }

        onProgress(tasks.length, tasks.length)
        return { succeeded, failed }
    }

    // ── Save-folder migration ─────────────────────────────────────────────────

    async scanSaveFolder(folderPath?: string): Promise<{count: number, totalSize: number, hasDatabase: boolean}> {
        const da = await this.authFetch('/api/migrate/save-folder/scan', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: folderPath }),
        })
        if (da.status < 200 || da.status >= 300) {
            const body = await da.json().catch(() => ({}))
            throw new Error(body.error || `scan error: ${da.status}`)
        }
        return da.json()
    }

    async executeSaveFolderImport(folderPath?: string): Promise<{ok: boolean, imported: number}> {
        const da = await this.authFetch('/api/migrate/save-folder/execute', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: folderPath }),
        })
        if (da.status === 409) throw new Error('Another import is already in progress')
        if (da.status < 200 || da.status >= 300) {
            const body = await da.json().catch(() => ({}))
            throw new Error(body.error || `import error: ${da.status}`)
        }
        return da.json()
    }

    async uploadSaveFolderZip(
        file: Blob,
        onProgress?: (loaded: number, total: number) => void
    ): Promise<{ok: boolean, imported: number}> {
        const authHeader = await this.createAuth()

        return await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest()
            xhr.open('POST', '/api/migrate/save-folder/upload')
            xhr.setRequestHeader('content-type', 'application/zip')
            xhr.setRequestHeader('risu-auth', authHeader)
            xhr.setRequestHeader('x-session-id', NodeStorage.sessionId)

            xhr.upload.onprogress = (event) => {
                if (event.lengthComputable) {
                    onProgress?.(event.loaded, event.total)
                }
            }

            xhr.onerror = () => reject(new Error('zip upload failed'))
            xhr.onload = () => {
                if (xhr.status < 200 || xhr.status >= 300) {
                    let msg = `zip import error: ${xhr.status}`
                    try { msg = JSON.parse(xhr.responseText).error || msg } catch {}
                    reject(new Error(msg))
                    return
                }
                try {
                    resolve(JSON.parse(xhr.responseText))
                } catch (error) {
                    reject(error)
                }
            }

            xhr.send(file)
        })
    }

    async scanCleanup(): Promise<{count: number, totalSize: number}> {
        const da = await this.authFetch('/api/migrate/save-folder/cleanup/scan', {
            method: 'POST',
        })
        if (da.status < 200 || da.status >= 300) {
            const body = await da.json().catch(() => ({}))
            throw new Error(body.error || `cleanup scan error: ${da.status}`)
        }
        return da.json()
    }

    async executeCleanup(): Promise<{ok: boolean, removed: number, freedBytes: number}> {
        const da = await this.authFetch('/api/migrate/save-folder/cleanup/execute', {
            method: 'POST',
        })
        if (da.status < 200 || da.status >= 300) {
            const body = await da.json().catch(() => ({}))
            throw new Error(body.error || `cleanup error: ${da.status}`)
        }
        return da.json()
    }

}

async function digestPassword(message:string) {
    const res = await fetch('/api/crypto', {
        body: JSON.stringify({
            data: message
        }),
        headers: {
            'content-type': 'application/json'
        },
        method: "POST"
    })
    if(res.status < 200 || res.status >= 300){
        throw new Error(`Password hashing failed (${res.status})`)
    }
    return await res.text()
}
