// Bridges the shared lorebook repository (rl_lorebooks, server/node/lorebookApi.cjs)
// with a character's own globalLore. The shared repository is otherwise just a
// collaborative storage/versioning layer with no effect on prompts — this is the
// one-entry-at-a-time link that lets someone publish a globalLore entry for others
// to pull down, and later re-sync it after either side changes.
//
// One entry <-> one shared lorebook (content: [entry]). A local entry tracks its
// link via loreBook.source_lorebook_id / source_updated_at (see database.svelte.ts).
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
    const { source_lorebook_id, source_updated_at, source_synced_snapshot, ...rest } = entry
    return rest as loreBook
}

// The subset of fields that actually round-trip to the shared repo — used to
// fingerprint "does this entry still match what's on the server". Deliberately
// excludes alwaysActive/disabled (personal activation prefs, never uploaded),
// folder/mode/id (local bookkeeping) and the source_* link metadata itself.
const CONTENT_FIELDS = ['key', 'secondkey', 'comment', 'content', 'insertorder', 'selective', 'useRegex', 'activationPercent'] as const

export function contentFingerprint(entry: loreBook): string {
    const picked: Record<string, unknown> = {}
    for (const field of CONTENT_FIELDS) picked[field] = entry[field]
    return JSON.stringify(picked)
}

// True once a linked entry's content has been edited locally since the last
// upload/sync — this is what brings the "업로드" button back for an entry
// that's already linked. No snapshot yet (e.g. an entry linked before this
// tracking existed) is treated as "not dirty" rather than forcing a spurious
// upload prompt — see the one-time backfill in LoreBookData.svelte.
export function isEntryDirty(entry: loreBook): boolean {
    if (!entry.source_lorebook_id || entry.source_synced_snapshot === undefined) return false
    return contentFingerprint(entry) !== entry.source_synced_snapshot
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

// Publishes one globalLore entry to the shared repository: creates a new
// (global) shared lorebook if it isn't linked to one yet, or overwrites the
// linked one's sole entry otherwise. Mutates `entry` in place on success so
// the caller's bound globalLore item picks up the new link metadata.
export async function uploadEntryToSharedLorebook(entry: loreBook, existing: SharedLorebookDetail | null): Promise<void> {
    if (!entry.id) entry.id = v4()
    const content = stripLinkMeta(entry)

    if (existing) {
        const entryId = resolveUploadEntryId(existing, entry)
        await ns.lockSharedLorebookEntry(existing.id, entryId)
        const detail = await ns.saveSharedLorebookEntry(existing.id, entryId, content)
        entry.source_lorebook_id = detail.id
        entry.source_updated_at = detail.updated_at
    } else {
        const title = entry.comment || entry.key || '이름 없는 로어'
        const detail = await ns.createSharedLorebook(title, [content], 'global')
        entry.source_lorebook_id = detail.id
        entry.source_updated_at = detail.updated_at
    }
    entry.source_synced_snapshot = contentFingerprint(entry)
    await refreshLinkedBookIndex(true)
}

// Shared by "불러오기" (first import), "업데이트" (refresh an existing link),
// and version restore: replaces every local entry already linked to this book
// with the book's current content, then appends nothing extra — same
// operation in all three cases. Activation prefs (alwaysActive/disabled) are
// personal, not part of the shared content, so an entry that's already linked
// keeps its own local values instead of inheriting whatever the uploader had.
//
// A local entry with unpushed edits (isEntryDirty) is left untouched unless
// force is set — overwriting it here would silently discard whatever the user
// was in the middle of testing before they'd uploaded it. It stays linked and
// still shows as pending (source_updated_at isn't bumped), so the caller can
// surface the conflict instead of losing it quietly.
export async function syncEntriesFromSharedLorebook(character: character, bookId: string, opts: { force?: boolean } = {}): Promise<{ applied: number, skipped: number }> {
    const detail = await ns.getSharedLorebook(bookId)
    const existingById = new Map(
        character.globalLore.filter(e => e.source_lorebook_id === bookId && e.id).map(e => [e.id, e])
    )
    const untouched = character.globalLore.filter(e => e.source_lorebook_id !== bookId)
    let applied = 0, skipped = 0
    const resolved: loreBook[] = []
    for (const serverEntry of detail.content) {
        const prev = serverEntry.id ? existingById.get(serverEntry.id) : undefined
        if (prev && !opts.force && isEntryDirty(prev)) {
            resolved.push(prev)
            skipped++
            continue
        }
        const merged: loreBook = {
            ...serverEntry,
            alwaysActive: prev ? prev.alwaysActive : serverEntry.alwaysActive,
            disabled: prev ? prev.disabled : serverEntry.disabled,
            source_lorebook_id: bookId,
            source_updated_at: detail.updated_at,
        }
        merged.source_synced_snapshot = contentFingerprint(merged)
        resolved.push(merged)
        applied++
    }
    character.globalLore = [...untouched, ...resolved]
    linkedBookIndex[bookId] = detail
    return { applied, skipped }
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
export async function applyAllPending(character: character): Promise<{ newBooks: number, newEntries: number, updatedBooks: number, updatedEntries: number, skippedEntries: number }> {
    const pendingNew = getPendingNewBooks(character)
    const pendingUpdated = getPendingUpdatedBooks(character)
    let newEntries = 0, updatedEntries = 0, newBooks = 0, updatedBooks = 0, skippedEntries = 0
    for (const book of pendingNew) {
        try {
            const { applied } = await syncEntriesFromSharedLorebook(character, book.id)
            newEntries += applied
            newBooks++
        } catch { /* deleted or otherwise unreachable mid-flight — skip it */ }
    }
    for (const book of pendingUpdated) {
        try {
            // Never force here — a background bulk apply has no way to ask the
            // user about a conflict, so a dirty (unpushed) entry is skipped
            // rather than silently overwritten. See syncEntriesFromSharedLorebook.
            const { applied, skipped } = await syncEntriesFromSharedLorebook(character, book.id)
            updatedEntries += applied
            skippedEntries += skipped
            updatedBooks++
        } catch { /* same */ }
    }
    return { newBooks, newEntries, updatedBooks, updatedEntries, skippedEntries }
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
