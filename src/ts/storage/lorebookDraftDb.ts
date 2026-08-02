// Local-only autosave buffer for the shared-lorebook entry editor (see
// lorebookApi.cjs / nodeStorage.ts's SharedLorebookEntry* methods). Deliberately
// separate from the server-side personal copy (rl_lorebook_drafts): this one
// exists purely so an unexpected tab close/crash mid-edit doesn't lose
// keystrokes that were never PUT back to the server. Plain IndexedDB (no new
// dependency) since the only need is get/put/delete by key.
//
// Keyed per (lorebookId, entryId) — editing is per-entry now, not per-book,
// so each draft holds a single entry, not a whole content array.
import type { loreBook } from "./database.svelte"

const DB_NAME = 'pocketrisu-lorebook-drafts'
const STORE_NAME = 'drafts'
const DB_VERSION = 1

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
    if (dbPromise) return dbPromise
    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION)
        req.onupgradeneeded = () => {
            if (!req.result.objectStoreNames.contains(STORE_NAME)) {
                req.result.createObjectStore(STORE_NAME)
            }
        }
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
    })
    return dbPromise
}

function draftKey(lorebookId: string, entryId: string): string {
    return `${lorebookId}:${entryId}`
}

export async function saveLorebookEntryDraftLocal(lorebookId: string, entryId: string, entry: loreBook): Promise<void> {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite')
        tx.objectStore(STORE_NAME).put(entry, draftKey(lorebookId, entryId))
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
    })
}

export async function loadLorebookEntryDraftLocal(lorebookId: string, entryId: string): Promise<loreBook | null> {
    const db = await openDb()
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly')
        const req = tx.objectStore(STORE_NAME).get(draftKey(lorebookId, entryId))
        req.onsuccess = () => resolve(req.result ?? null)
        req.onerror = () => reject(req.error)
    })
}

export async function clearLorebookEntryDraftLocal(lorebookId: string, entryId: string): Promise<void> {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite')
        tx.objectStore(STORE_NAME).delete(draftKey(lorebookId, entryId))
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
    })
}
