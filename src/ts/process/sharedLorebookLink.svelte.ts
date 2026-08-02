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
    const { source_lorebook_id, source_updated_at, ...rest } = entry
    return rest as loreBook
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
        const entryId = existing.content.find(e => e.id === entry.id)?.id ?? existing.content[0]?.id ?? entry.id
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
    await refreshLinkedBookIndex(true)
}

// Shared by both "불러오기" (first import) and "업데이트" (refresh an existing
// link): replaces every local entry already linked to this book with the
// book's current content, then appends nothing extra — same operation either way.
export async function syncEntriesFromSharedLorebook(character: character, bookId: string): Promise<number> {
    const detail = await ns.getSharedLorebook(bookId)
    const kept = character.globalLore.filter(e => e.source_lorebook_id !== bookId)
    const fresh = detail.content.map(entry => ({
        ...entry,
        source_lorebook_id: bookId,
        source_updated_at: detail.updated_at,
    }))
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
