// Bridges the shared lorebook repository (rl_lorebooks, server/node/lorebookApi.cjs)
// with a character's own globalLore. The shared repository is otherwise just a
// collaborative storage/versioning layer with no effect on prompts — this is the
// one-entry-at-a-time link that lets someone publish a globalLore entry for others
// to pull down, and later re-sync it after either side changes.
//
// One entry <-> one shared lorebook (content: [entry]). A local entry tracks its
// link via loreBook.source_lorebook_id / source_updated_at (see database.svelte.ts).
//
// character.globalLore is NOT per-account isolated — the whole deployment shares
// one database.bin (see CLAUDE.md), autosaved ~500ms after every edit. So a linked
// entry's `value` must only ever reflect the last-known canonical (uploaded/synced)
// content, never an in-progress edit — otherwise a WIP change would broadcast to
// the entire deployment before it's ever published. In-progress edits live in a
// separate local `editDraft` (LoreBookData.svelte) backed by the lock holder's
// per-user server-side draft (rl_lorebook_drafts), which is what makes them
// genuinely private until upload.
import { v4 } from "uuid"
import { NodeStorage, type SharedLorebookDetail, type SharedLorebookSummary } from "src/ts/storage/nodeStorage"
import type { character, loreBook } from "src/ts/storage/database.svelte"

const ns = new NodeStorage()

export const linkedBookIndex = $state<Record<string, SharedLorebookSummary>>({})

let lastIndexFetch = 0
const INDEX_TTL_MS = 10000

export async function refreshLinkedBookIndex(force = false) {
    if (!force && Date.now() - lastIndexFetch < INDEX_TTL_MS) return
    lastIndexFetch = Date.now()
    const list = await ns.listSharedLorebooks()
    for (const key of Object.keys(linkedBookIndex)) delete linkedBookIndex[key]
    for (const book of list) linkedBookIndex[book.id] = book
}

// content sent to the shared repo should never carry this local-only linking
// metadata — it's meaningless (and stale) once it's someone else's copy.
function stripLinkMeta(entry: loreBook): loreBook {
    const { source_lorebook_id, source_updated_at, ...rest } = entry
    return rest as loreBook
}

// Which entry inside a shared book's content array corresponds to a local
// entry — normally just id equality, falling back to "the book's only entry"
// for the entry-level 1:1 model this feature actually uses.
export function resolveUploadEntryId(existing: SharedLorebookDetail, entry: loreBook): string {
    return existing.content.find(e => e.id === entry.id)?.id ?? existing.content[0]?.id ?? entry.id
}

// Looks up the entry's currently-linked shared lorebook, if any. Returns null
// both when there's no link yet and when the linked book was since deleted —
// both cases mean "treat the next upload as a brand new registration".
export async function checkUploadTarget(entry: loreBook): Promise<SharedLorebookDetail | null> {
    if (!entry.source_lorebook_id) return null
    try {
        return await ns.getSharedLorebook(entry.source_lorebook_id)
    } catch {
        return null
    }
}

// Publishes an entry to the shared repository: creates a new (global) shared
// lorebook if `target` isn't linked to one yet, or overwrites the linked one's
// sole entry otherwise. `content` is what actually gets published — separate
// from `target` so a locked, in-progress edit (LoreBookData.svelte's local
// editDraft) can be the content source while `target` (the character's own
// globalLore entry) only receives the resulting link metadata and the newly
// published fields, never the WIP object itself. For an unlinked entry being
// registered for the first time, `content` and `target` are simply the same
// object — there's no draft in play yet.
export async function uploadEntryToSharedLorebook(target: loreBook, content: loreBook, existing: SharedLorebookDetail | null): Promise<void> {
    if (!target.id) target.id = v4()
    const payload = stripLinkMeta({ ...content, id: target.id })

    let detail: SharedLorebookDetail
    if (existing) {
        const entryId = resolveUploadEntryId(existing, target)
        await ns.lockSharedLorebookEntry(existing.id, entryId)
        detail = await ns.saveSharedLorebookEntry(existing.id, entryId, payload)
    } else {
        const title = payload.comment || payload.key || '이름 없는 로어'
        detail = await ns.createSharedLorebook(title, [payload], 'global')
    }

    // Content fields only — alwaysActive/disabled/folder are personal and stay untouched.
    target.comment = payload.comment
    target.key = payload.key
    target.secondkey = payload.secondkey
    target.content = payload.content
    target.insertorder = payload.insertorder
    target.selective = payload.selective
    target.useRegex = payload.useRegex
    target.activationPercent = payload.activationPercent
    target.source_lorebook_id = detail.id
    target.source_updated_at = detail.updated_at
    await refreshLinkedBookIndex(true)
}

// Shared by "불러오기" (first import), "업데이트" (refresh an existing link),
// and version restore: replaces every local entry already linked to this book
// with the book's current content. Activation prefs (alwaysActive/disabled)
// are personal, not part of the shared content, so an entry that's already
// linked keeps its own local values instead of inheriting whatever the
// uploader had. Safe to always apply unconditionally — a linked entry's
// `value` never holds unpublished WIP (that lives in the lock holder's
// editDraft/server draft instead), so there's nothing here to lose.
export async function syncEntriesFromSharedLorebook(character: character, bookId: string): Promise<number> {
    const detail = await ns.getSharedLorebook(bookId)
    const existingById = new Map(
        character.globalLore.filter(e => e.source_lorebook_id === bookId && e.id).map(e => [e.id, e])
    )
    const kept = character.globalLore.filter(e => e.source_lorebook_id !== bookId)
    const fresh = detail.content.map(entry => {
        const prev = entry.id ? existingById.get(entry.id) : undefined
        return {
            ...entry,
            alwaysActive: prev ? prev.alwaysActive : entry.alwaysActive,
            disabled: prev ? prev.disabled : entry.disabled,
            source_lorebook_id: bookId,
            source_updated_at: detail.updated_at,
        }
    })
    character.globalLore = [...kept, ...fresh]
    linkedBookIndex[bookId] = detail
    return fresh.length
}

export function isCharacterLinkedToBook(character: character, bookId: string): boolean {
    return character.globalLore.some(e => e.source_lorebook_id === bookId)
}

// Global books nobody on this character has pulled down yet.
export function getPendingNewBooks(character: character): SharedLorebookSummary[] {
    const linkedIds = new Set(character.globalLore.map(e => e.source_lorebook_id).filter(Boolean))
    return Object.values(linkedBookIndex).filter(b => b.scope === 'global' && !linkedIds.has(b.id))
}

// Books this character already pulled from, whose shared copy has since moved on.
export function getPendingUpdatedBooks(character: character): SharedLorebookSummary[] {
    const staleIds = new Set<string>()
    for (const e of character.globalLore) {
        if (!e.source_lorebook_id) continue
        const linked = linkedBookIndex[e.source_lorebook_id]
        if (linked && linked.updated_at > (e.source_updated_at ?? 0)) staleIds.add(e.source_lorebook_id)
    }
    return [...staleIds].map(id => linkedBookIndex[id])
}

// Pulls every pending new/updated book into globalLore in one shot. Sequential,
// not parallel — syncEntriesFromSharedLorebook reassigns character.globalLore
// from a snapshot, so concurrent calls would clobber each other.
export async function applyAllPending(character: character): Promise<{ newBooks: number, newEntries: number, updatedBooks: number, updatedEntries: number }> {
    const pendingNew = getPendingNewBooks(character)
    const pendingUpdated = getPendingUpdatedBooks(character)
    let newEntries = 0, updatedEntries = 0, newBooks = 0, updatedBooks = 0
    for (const book of pendingNew) {
        try {
            newEntries += await syncEntriesFromSharedLorebook(character, book.id)
            newBooks++
        } catch { /* deleted or otherwise unreachable mid-flight — skip it */ }
    }
    for (const book of pendingUpdated) {
        try {
            updatedEntries += await syncEntriesFromSharedLorebook(character, book.id)
            updatedBooks++
        } catch { /* same */ }
    }
    return { newBooks, newEntries, updatedBooks, updatedEntries }
}

// Background polling — keeps linkedBookIndex fresh while the character's
// lorebook screen is open, so the pending-new/pending-updated banner stays
// current without the user manually refreshing.
let pollTimer: ReturnType<typeof setInterval> | null = null
export function startBackgroundSync() {
    stopBackgroundSync()
    refreshLinkedBookIndex(true)
    pollTimer = setInterval(() => refreshLinkedBookIndex(true), 15000)
}
export function stopBackgroundSync() {
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = null
}
