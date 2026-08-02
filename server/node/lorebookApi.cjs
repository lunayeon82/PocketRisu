'use strict';

const { randomUUID } = require('crypto');
const { sharedDb, isAdmin } = require('./authGate.cjs');
const { resolveUserId } = require('./chatApi.cjs');

// Foreign-key constraints (CASCADE DELETE on versions/locks/drafts/overrides) require this per-connection.
sharedDb.pragma('foreign_keys = ON');

// Pessimistic, non-expiring lock: single-writer, exclusive, held until the
// same user either saves (PUT entries/:entryId) or explicitly cancels
// (DELETE .../lock) — no timeout. Whoever holds it blocks every other user's
// edit attempt on that entry until then.
const MAX_VERSIONS = 3;
const VALID_OVERRIDE_MODES = new Set(['always', 'trigger', 'disabled']);

// ─── Schema ───────────────────────────────────────────────────────────────────
// Shared lorebook repository: one canonical copy per lorebook (rl_lorebooks),
// content is JSON.stringify(loreBook[]) — the same shape as
// character.globalLore (see src/ts/storage/database.svelte.ts) and
// src/ts/process/lorebook.svelte.ts's import/export, minus the {type,ver}
// file-interchange wrapper, which only exists at the file boundary.
//
// scope='global' rows are visible/editable by anyone; scope='private' rows
// are owner_id-only, edited directly with no locking (a private lorebook has
// exactly one possible editor).
//
// Locking is per ENTRY, not per book. A "lorebook" here is just a named,
// scoped grouping of entries (what the client shows as a folder) — the
// entries are the actual unit of meaning, so two people editing different
// entries of the same shared lorebook shouldn't block each other. Only
// PUT .../entries/:entryId (an actual content edit) needs the lock; adding,
// deleting, and reordering entries are structural operations and go through
// unlocked, matching how the character's own lorebook list already works.
sharedDb.exec(`
  CREATE TABLE IF NOT EXISTS rl_lorebooks (
    id         TEXT    PRIMARY KEY,
    title      TEXT    NOT NULL DEFAULT '',
    content    TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by INTEGER NOT NULL REFERENCES rl_users(id)
  )
`);

// Added after the initial rollout — guard with table_info so existing
// deploys upgrade in place instead of erroring on re-run (mirrors
// rl_users/is_admin in authGate.cjs, rl_chats/folder_id in chatApi.cjs).
const rlLorebooksColumns = sharedDb.prepare(`PRAGMA table_info(rl_lorebooks)`).all();
if (!rlLorebooksColumns.some((c) => c.name === 'scope')) {
    sharedDb.exec(`ALTER TABLE rl_lorebooks ADD COLUMN scope TEXT NOT NULL DEFAULT 'global'`);
}
if (!rlLorebooksColumns.some((c) => c.name === 'owner_id')) {
    sharedDb.exec(`ALTER TABLE rl_lorebooks ADD COLUMN owner_id INTEGER REFERENCES rl_users(id)`);
}

sharedDb.exec(`
  CREATE TABLE IF NOT EXISTS rl_lorebook_versions (
    id          TEXT    PRIMARY KEY,
    lorebook_id TEXT    NOT NULL REFERENCES rl_lorebooks(id) ON DELETE CASCADE,
    content     TEXT    NOT NULL,
    saved_at    INTEGER NOT NULL,
    saved_by    INTEGER NOT NULL REFERENCES rl_users(id)
  )
`);
sharedDb.exec(`CREATE INDEX IF NOT EXISTS idx_rl_lorebook_versions_book ON rl_lorebook_versions(lorebook_id, saved_at)`);

// rl_lorebook_locks / rl_lorebook_drafts used to be keyed per (lorebook_id)
// — one lock for the whole book. Locking is now per entry instead (see the
// schema comment above), which changes the primary key shape entirely. These
// tables only ever hold transient editing state (never a lorebook's actual
// content, which lives in rl_lorebooks.content) so on upgrade it's safe to
// just drop and recreate them rather than migrate rows — any lock/draft
// still "live" under the old shape is meaningless under the new one anyway.
const lockColumns = sharedDb.prepare(`PRAGMA table_info(rl_lorebook_locks)`).all();
if (lockColumns.length > 0 && !lockColumns.some((c) => c.name === 'entry_id')) {
    sharedDb.exec(`DROP TABLE rl_lorebook_locks`);
}
const draftColumns = sharedDb.prepare(`PRAGMA table_info(rl_lorebook_drafts)`).all();
if (draftColumns.length > 0 && !draftColumns.some((c) => c.name === 'entry_id')) {
    sharedDb.exec(`DROP TABLE rl_lorebook_drafts`);
}

// One row per (lorebook, entry) — existence means that entry is locked.
// locked_at is refreshed on re-lock by the same holder; a different
// requester gets 409 for as long as the row exists (no expiry). Only ever
// created for entries belonging to scope='global' books.
sharedDb.exec(`
  CREATE TABLE IF NOT EXISTS rl_lorebook_locks (
    lorebook_id TEXT    NOT NULL REFERENCES rl_lorebooks(id) ON DELETE CASCADE,
    entry_id    TEXT    NOT NULL,
    locked_by   INTEGER NOT NULL REFERENCES rl_users(id),
    locked_at   INTEGER NOT NULL,
    PRIMARY KEY (lorebook_id, entry_id)
  )
`);

// Personal copy of a single entry, keyed per (lorebook, entry, user) so a
// past editor's abandoned draft can't collide with the current one. Only
// cleared by an explicit save or cancel.
sharedDb.exec(`
  CREATE TABLE IF NOT EXISTS rl_lorebook_drafts (
    lorebook_id TEXT    NOT NULL REFERENCES rl_lorebooks(id) ON DELETE CASCADE,
    entry_id    TEXT    NOT NULL,
    user_id     INTEGER NOT NULL REFERENCES rl_users(id),
    content     TEXT    NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (lorebook_id, entry_id, user_id)
  )
`);

// Per-viewer activation preference for a single entry of a global lorebook.
// Absence of a row means the default ('trigger') applies — saveOverrides()
// below only ever writes non-default rows, so this table stays small.
sharedDb.exec(`
  CREATE TABLE IF NOT EXISTS rl_lorebook_overrides (
    user_id     INTEGER NOT NULL REFERENCES rl_users(id),
    lorebook_id TEXT    NOT NULL REFERENCES rl_lorebooks(id) ON DELETE CASCADE,
    entry_id    TEXT    NOT NULL,
    mode        TEXT    NOT NULL,
    PRIMARY KEY (user_id, lorebook_id, entry_id)
  )
`);

// ─── Prepared statements ──────────────────────────────────────────────────────
const stmtListLorebooks = sharedDb.prepare(`
  SELECT * FROM rl_lorebooks WHERE scope = 'global' OR (scope = 'private' AND owner_id = ?) ORDER BY updated_at DESC
`);
const stmtGetLorebook = sharedDb.prepare(`SELECT * FROM rl_lorebooks WHERE id = ?`);
const stmtInsertLorebook = sharedDb.prepare(`
  INSERT INTO rl_lorebooks (id, title, content, scope, owner_id, created_at, updated_at, updated_by)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const stmtUpdateLorebook = sharedDb.prepare(`
  UPDATE rl_lorebooks SET title = ?, content = ?, updated_at = ?, updated_by = ? WHERE id = ?
`);
const stmtSetGlobal = sharedDb.prepare(`
  UPDATE rl_lorebooks SET scope = 'global', owner_id = NULL, content = ?, updated_at = ?, updated_by = ? WHERE id = ?
`);
const stmtDeleteLorebook = sharedDb.prepare(`DELETE FROM rl_lorebooks WHERE id = ?`);

const stmtGetUsername = sharedDb.prepare(`SELECT username FROM rl_users WHERE id = ?`);

const stmtGetLock = sharedDb.prepare(`SELECT * FROM rl_lorebook_locks WHERE lorebook_id = ? AND entry_id = ?`);
const stmtListLocksForBook = sharedDb.prepare(`SELECT * FROM rl_lorebook_locks WHERE lorebook_id = ?`);
const stmtUpsertLock = sharedDb.prepare(`
  INSERT INTO rl_lorebook_locks (lorebook_id, entry_id, locked_by, locked_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(lorebook_id, entry_id) DO UPDATE SET locked_by = excluded.locked_by, locked_at = excluded.locked_at
`);
const stmtDeleteLock = sharedDb.prepare(`DELETE FROM rl_lorebook_locks WHERE lorebook_id = ? AND entry_id = ?`);

const stmtGetDraft = sharedDb.prepare(`SELECT * FROM rl_lorebook_drafts WHERE lorebook_id = ? AND entry_id = ? AND user_id = ?`);
const stmtUpsertDraft = sharedDb.prepare(`
  INSERT INTO rl_lorebook_drafts (lorebook_id, entry_id, user_id, content, updated_at) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(lorebook_id, entry_id, user_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at
`);
const stmtDeleteDraft = sharedDb.prepare(`DELETE FROM rl_lorebook_drafts WHERE lorebook_id = ? AND entry_id = ? AND user_id = ?`);

const stmtInsertVersion = sharedDb.prepare(`
  INSERT INTO rl_lorebook_versions (id, lorebook_id, content, saved_at, saved_by) VALUES (?, ?, ?, ?, ?)
`);
const stmtCountVersions = sharedDb.prepare(`SELECT COUNT(*) AS n FROM rl_lorebook_versions WHERE lorebook_id = ?`);
const stmtOldestVersions = sharedDb.prepare(`
  SELECT id FROM rl_lorebook_versions WHERE lorebook_id = ? ORDER BY saved_at ASC LIMIT ?
`);
const stmtDeleteVersion = sharedDb.prepare(`DELETE FROM rl_lorebook_versions WHERE id = ?`);
const stmtListVersions = sharedDb.prepare(`
  SELECT * FROM rl_lorebook_versions WHERE lorebook_id = ? ORDER BY saved_at DESC
`);
const stmtGetVersion = sharedDb.prepare(`SELECT * FROM rl_lorebook_versions WHERE id = ? AND lorebook_id = ?`);

const stmtGetOverrides = sharedDb.prepare(`SELECT entry_id, mode FROM rl_lorebook_overrides WHERE user_id = ? AND lorebook_id = ?`);
const stmtDeleteOverridesForUser = sharedDb.prepare(`DELETE FROM rl_lorebook_overrides WHERE user_id = ? AND lorebook_id = ?`);
const stmtInsertOverride = sharedDb.prepare(`
  INSERT INTO rl_lorebook_overrides (user_id, lorebook_id, entry_id, mode) VALUES (?, ?, ?, ?)
`);

// ─── Helpers ────────────────────────────────────────────────────────────────
function getUsername(userId) {
    const row = stmtGetUsername.get(userId);
    return row ? row.username : null;
}

function isAdminUser(userId) {
    const username = getUsername(userId);
    return !!username && isAdmin(username);
}

// A private lorebook is visible only to its owner; global rows are open to
// any authenticated user. Used to turn "not visible to you" and "doesn't
// exist" into the same 404 so a private id can't be probed.
function canView(book, userId) {
    if (book.scope === 'global') return true;
    return book.owner_id === userId;
}

// Ensures every entry has a stable id — required for the entries API
// (PUT/DELETE .../entries/:entryId) to address a specific entry, and for
// rl_lorebook_overrides/rl_lorebook_locks to anchor to one. Only fills gaps
// (existing ids are kept); see cloneLorebook() for the "regenerate all ids"
// case used on copy.
function backfillEntryIds(content) {
    let changed = false;
    const result = content.map((entry) => {
        if (entry && entry.id) return entry;
        changed = true;
        return { ...entry, id: randomUUID() };
    });
    return { content: result, changed };
}

// Resolves the live lock for one entry. No expiry — a lock lives until its
// holder saves or explicitly cancels.
function getLockStatus(lorebookId, entryId) {
    return stmtGetLock.get(lorebookId, entryId) ?? null;
}

function serializeLockStatus(lorebookId, entryId) {
    const lock = getLockStatus(lorebookId, entryId);
    if (!lock) return null;
    return {
        locked_by: lock.locked_by,
        locked_by_username: getUsername(lock.locked_by),
        locked_at: lock.locked_at,
    };
}

function serializeLorebookSummary(row) {
    return {
        id: row.id,
        title: row.title,
        scope: row.scope,
        owner_id: row.owner_id,
        updated_at: row.updated_at,
        updated_by: row.updated_by,
        updated_by_username: getUsername(row.updated_by),
    };
}

// userId is the requester — needed to attach their own overrides, which are
// per-viewer and never shared between users.
function serializeLorebookDetail(row, userId) {
    const detail = {
        ...serializeLorebookSummary(row),
        content: JSON.parse(row.content),
    };
    if (row.scope === 'global') {
        detail.overrides = stmtGetOverrides.all(userId, row.id);
        const locks = {};
        for (const lock of stmtListLocksForBook.all(row.id)) {
            const status = serializeLockStatus(row.id, lock.entry_id);
            if (status) locks[lock.entry_id] = status;
        }
        detail.locks = locks;
    }
    return detail;
}

function serializeVersion(row) {
    return {
        id: row.id,
        content: JSON.parse(row.content),
        saved_at: row.saved_at,
        saved_by: row.saved_by,
        saved_by_username: getUsername(row.saved_by),
    };
}

// Trims rl_lorebook_versions down to MAX_VERSIONS for a given lorebook,
// dropping the oldest first. Called after every version insert.
function trimVersions(lorebookId) {
    const { n } = stmtCountVersions.get(lorebookId);
    if (n <= MAX_VERSIONS) return;
    const excess = stmtOldestVersions.all(lorebookId, n - MAX_VERSIONS);
    for (const v of excess) stmtDeleteVersion.run(v.id);
}

// Archives the lorebook's current (pre-change) content as a version
// attributed to whoever last wrote it, then trims to MAX_VERSIONS. Called
// before every change to content (single-entry save, add, delete) so
// "최근 3버전" always has something to restore to.
function archiveCurrentContent(book, now) {
    stmtInsertVersion.run(randomUUID(), book.id, book.content, now, book.updated_by);
    trimVersions(book.id);
}

function findEntryIndex(content, entryId) {
    return content.findIndex((e) => e.id === entryId);
}

// ─── Route handlers — lorebooks ────────────────────────────────────────────────

// GET /api/lorebooks — every global lorebook plus the requester's own private ones.
function listLorebooks(req, res) {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const rows = stmtListLorebooks.all(userId);
    return res.json(rows.map(serializeLorebookSummary));
}

// POST /api/lorebooks — scope defaults to 'private' (opt-in publish, not opt-out).
function createLorebook(req, res) {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { title = '', content, scope = 'private' } = req.body || {};
    if (!Array.isArray(content)) return res.status(400).json({ error: 'content must be an array' });
    if (scope !== 'global' && scope !== 'private') return res.status(400).json({ error: "scope must be 'global' or 'private'" });

    const id = req.body.id || randomUUID();
    const now = Date.now();
    const ownerId = scope === 'private' ? userId : null;
    // Every entry needs a stable id regardless of scope — the entries API
    // (PUT/DELETE .../entries/:entryId) addresses entries by id whether or
    // not the book is ever locked.
    const finalContent = backfillEntryIds(content).content;

    try {
        stmtInsertLorebook.run(id, String(title), JSON.stringify(finalContent), scope, ownerId, now, now, userId);
    } catch (e) {
        if (/UNIQUE/.test(e.message)) return res.status(409).json({ error: 'Lorebook id already exists' });
        throw e;
    }

    return res.status(201).json(serializeLorebookDetail(stmtGetLorebook.get(id), userId));
}

// GET /api/lorebooks/:id
function getLorebook(req, res) {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const book = stmtGetLorebook.get(req.params.id);
    if (!book || !canView(book, userId)) return res.status(404).json({ error: 'Not found' });
    return res.json(serializeLorebookDetail(book, userId));
}

// PATCH /api/lorebooks/:id — title-only rename. Metadata, not content, so it
// follows the same "structural, no lock" rule as add/delete/reorder entries.
function renameLorebook(req, res) {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const book = stmtGetLorebook.get(req.params.id);
    if (!book || !canView(book, userId)) return res.status(404).json({ error: 'Not found' });
    if (book.scope === 'private' && book.owner_id !== userId) {
        return res.status(403).json({ error: 'Not the owner' });
    }

    const { title } = req.body || {};
    if (typeof title !== 'string') return res.status(400).json({ error: 'title must be a string' });

    stmtUpdateLorebook.run(title, book.content, Date.now(), userId, req.params.id);
    return res.json(serializeLorebookDetail(stmtGetLorebook.get(req.params.id), userId));
}

// POST /api/lorebooks/:id/to-global — owner only, one-way. There is no
// reverse (global → private) endpoint by design.
function toGlobal(req, res) {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const book = stmtGetLorebook.get(req.params.id);
    if (!book || !canView(book, userId)) return res.status(404).json({ error: 'Not found' });
    if (book.scope !== 'private' || book.owner_id !== userId) {
        return res.status(403).json({ error: 'Only the owner can share a private lorebook' });
    }

    const now = Date.now();
    const { content } = backfillEntryIds(JSON.parse(book.content));
    stmtSetGlobal.run(JSON.stringify(content), now, userId, req.params.id);

    return res.json(serializeLorebookDetail(stmtGetLorebook.get(req.params.id), userId));
}

// POST /api/lorebooks/:id/clone — copies a global lorebook into a new private
// one owned by the requester. Every entry id is regenerated (not just
// backfilled) so the clone can never inherit the source's per-user overrides
// or locks, or accidentally alias entries with it.
function cloneLorebook(req, res) {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const book = stmtGetLorebook.get(req.params.id);
    if (!book || book.scope !== 'global') return res.status(404).json({ error: 'Not found' });

    const now = Date.now();
    const newId = randomUUID();
    const clonedContent = JSON.parse(book.content).map((entry) => ({ ...entry, id: randomUUID() }));

    stmtInsertLorebook.run(newId, book.title, JSON.stringify(clonedContent), 'private', userId, now, now, userId);
    return res.status(201).json(serializeLorebookDetail(stmtGetLorebook.get(newId), userId));
}

// DELETE /api/lorebooks/:id — global requires admin; private requires ownership.
// Cascades to versions/locks/drafts/overrides via ON DELETE CASCADE.
function deleteLorebook(req, res) {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const book = stmtGetLorebook.get(req.params.id);
    if (!book || !canView(book, userId)) return res.status(404).json({ error: 'Not found' });

    if (book.scope === 'global') {
        if (!isAdminUser(userId)) return res.status(403).json({ error: 'Only admins can delete global lorebooks' });
    } else if (book.owner_id !== userId) {
        return res.status(403).json({ error: 'Not the owner' });
    }

    stmtDeleteLorebook.run(req.params.id);
    return res.status(204).end();
}

// PUT /api/lorebooks/:id/overrides — replaces the requester's entire override
// set for this lorebook in one shot. No lock needed: this is purely the
// viewer's own activation preference, not a content edit, and never affects
// what anyone else sees.
function saveOverrides(req, res) {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const book = stmtGetLorebook.get(req.params.id);
    if (!book || !canView(book, userId)) return res.status(404).json({ error: 'Not found' });
    if (book.scope !== 'global') return res.status(400).json({ error: 'Overrides only apply to global lorebooks' });

    const overrides = req.body;
    if (!Array.isArray(overrides)) return res.status(400).json({ error: 'Expected an array' });
    for (const o of overrides) {
        if (!o || typeof o.entry_id !== 'string' || !VALID_OVERRIDE_MODES.has(o.mode)) {
            return res.status(400).json({ error: 'Each entry needs entry_id (string) and a valid mode' });
        }
    }

    sharedDb.transaction(() => {
        stmtDeleteOverridesForUser.run(userId, req.params.id);
        for (const o of overrides) {
            // 'trigger' is the implicit default (see rl_lorebook_overrides
            // comment) — skip writing a row for it so the table only ever
            // holds actual overrides.
            if (o.mode !== 'trigger') stmtInsertOverride.run(userId, req.params.id, o.entry_id, o.mode);
        }
    })();

    return res.json({ overrides: stmtGetOverrides.all(userId, req.params.id) });
}

// GET /api/lorebooks/:id/versions
function listVersions(req, res) {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const book = stmtGetLorebook.get(req.params.id);
    if (!book || !canView(book, userId)) return res.status(404).json({ error: 'Not found' });

    const rows = stmtListVersions.all(req.params.id);
    return res.json(rows.map(serializeVersion));
}

// POST /api/lorebooks/:id/restore/:versionId — reverts the whole book to a
// past snapshot. Structural, like add/delete/reorder below: global requires
// no particular entry lock (any authenticated user may restore — reverting
// doesn't target one entry, so there's no single lock to hold), private
// requires ownership.
function restoreVersion(req, res) {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const book = stmtGetLorebook.get(req.params.id);
    if (!book || !canView(book, userId)) return res.status(404).json({ error: 'Not found' });
    if (book.scope === 'private' && book.owner_id !== userId) {
        return res.status(403).json({ error: 'Not the owner' });
    }

    const version = stmtGetVersion.get(req.params.versionId, req.params.id);
    if (!version) return res.status(404).json({ error: 'Version not found' });

    const now = Date.now();
    const restoredContent = JSON.stringify(backfillEntryIds(JSON.parse(version.content)).content);

    const updated = sharedDb.transaction(() => {
        archiveCurrentContent(book, now);
        stmtUpdateLorebook.run(book.title, restoredContent, now, userId, req.params.id);
        return stmtGetLorebook.get(req.params.id);
    })();

    return res.json(serializeLorebookDetail(updated, userId));
}

// ─── Route handlers — entries ───────────────────────────────────────────────

// POST /api/lorebooks/:id/entries — add a new entry. Structural, no lock:
// global allows any authenticated user (this is the "shared, collaborative"
// contribution path), private requires ownership.
function createEntry(req, res) {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const book = stmtGetLorebook.get(req.params.id);
    if (!book || !canView(book, userId)) return res.status(404).json({ error: 'Not found' });
    if (book.scope === 'private' && book.owner_id !== userId) {
        return res.status(403).json({ error: 'Not the owner' });
    }

    const entry = req.body && typeof req.body === 'object' ? req.body : {};
    const newEntry = { ...entry, id: randomUUID() };
    const now = Date.now();

    const updated = sharedDb.transaction(() => {
        archiveCurrentContent(book, now);
        const content = JSON.parse(book.content);
        content.push(newEntry);
        stmtUpdateLorebook.run(book.title, JSON.stringify(content), now, userId, req.params.id);
        return stmtGetLorebook.get(req.params.id);
    })();

    return res.status(201).json(serializeLorebookDetail(updated, userId));
}

// DELETE /api/lorebooks/:id/entries/:entryId — structural, no lock to hold,
// but refuses while someone else has that entry locked (avoids yanking
// content out from under an in-progress edit).
function deleteEntry(req, res) {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const book = stmtGetLorebook.get(req.params.id);
    if (!book || !canView(book, userId)) return res.status(404).json({ error: 'Not found' });
    if (book.scope === 'private' && book.owner_id !== userId) {
        return res.status(403).json({ error: 'Not the owner' });
    }

    const lock = getLockStatus(req.params.id, req.params.entryId);
    if (lock && lock.locked_by !== userId) {
        return res.status(409).json({ error: 'Entry is being edited by another user', locked_by_username: getUsername(lock.locked_by) });
    }

    const content = JSON.parse(book.content);
    const idx = findEntryIndex(content, req.params.entryId);
    if (idx === -1) return res.status(404).json({ error: 'Entry not found' });

    const now = Date.now();
    const updated = sharedDb.transaction(() => {
        archiveCurrentContent(book, now);
        content.splice(idx, 1);
        stmtUpdateLorebook.run(book.title, JSON.stringify(content), now, userId, req.params.id);
        stmtDeleteLock.run(req.params.id, req.params.entryId);
        return stmtGetLorebook.get(req.params.id);
    })();

    return res.json(serializeLorebookDetail(updated, userId));
}

// PATCH /api/lorebooks/:id/entries/reorder — body: array of entry ids in the
// new order. Pure ordering, no content touched, no lock needed, no version
// snapshot (versions protect content, not order).
function reorderEntries(req, res) {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const book = stmtGetLorebook.get(req.params.id);
    if (!book || !canView(book, userId)) return res.status(404).json({ error: 'Not found' });
    if (book.scope === 'private' && book.owner_id !== userId) {
        return res.status(403).json({ error: 'Not the owner' });
    }

    const order = req.body;
    if (!Array.isArray(order) || order.some((id) => typeof id !== 'string')) {
        return res.status(400).json({ error: 'Expected an array of entry ids' });
    }

    const content = JSON.parse(book.content);
    const byId = new Map(content.map((e) => [e.id, e]));
    if (order.length !== content.length || !order.every((id) => byId.has(id))) {
        return res.status(400).json({ error: 'Order must include exactly the current entry ids' });
    }
    const reordered = order.map((id) => byId.get(id));

    const now = Date.now();
    stmtUpdateLorebook.run(book.title, JSON.stringify(reordered), now, userId, req.params.id);
    return res.json(serializeLorebookDetail(stmtGetLorebook.get(req.params.id), userId));
}

// POST /api/lorebooks/:id/entries/:entryId/lock — global only; private has
// exactly one possible editor (the owner) so locking is meaningless there.
function lockEntry(req, res) {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const book = stmtGetLorebook.get(req.params.id);
    if (!book || !canView(book, userId)) return res.status(404).json({ error: 'Not found' });
    if (book.scope === 'private') return res.status(400).json({ error: 'Private lorebooks do not use locks' });

    const content = JSON.parse(book.content);
    const entry = content.find((e) => e.id === req.params.entryId);
    if (!entry) return res.status(404).json({ error: 'Entry not found' });

    const now = Date.now();
    const lock = getLockStatus(req.params.id, req.params.entryId);

    if (lock) {
        if (lock.locked_by !== userId) {
            return res.status(409).json({
                error: 'Locked by another user',
                locked_by: lock.locked_by,
                locked_by_username: getUsername(lock.locked_by),
                locked_at: lock.locked_at,
            });
        }
        // Same holder refreshing (e.g. page reload) — extend the lock, keep
        // whatever draft they already have untouched.
        stmtUpsertLock.run(req.params.id, req.params.entryId, userId, now);
        const draft = stmtGetDraft.get(req.params.id, req.params.entryId, userId);
        return res.json({ entry: JSON.parse(draft.content), locked_at: now });
    }

    // No live lock: acquire it. If this requester already has a leftover
    // draft of their own for this entry, keep it; only start from the
    // canonical entry when they have no draft yet.
    const draft = sharedDb.transaction(() => {
        stmtUpsertLock.run(req.params.id, req.params.entryId, userId, now);
        let d = stmtGetDraft.get(req.params.id, req.params.entryId, userId);
        if (!d) {
            stmtUpsertDraft.run(req.params.id, req.params.entryId, userId, JSON.stringify(entry), now);
            d = stmtGetDraft.get(req.params.id, req.params.entryId, userId);
        }
        return d;
    })();

    return res.json({ entry: JSON.parse(draft.content), locked_at: now });
}

// DELETE /api/lorebooks/:id/entries/:entryId/lock — cancel: discard the
// personal copy, release the lock, leave the canonical entry untouched.
function cancelEntryLock(req, res) {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const book = stmtGetLorebook.get(req.params.id);
    if (!book || !canView(book, userId)) return res.status(404).json({ error: 'Not found' });
    if (book.scope === 'private') return res.status(400).json({ error: 'Private lorebooks do not use locks' });

    const lock = getLockStatus(req.params.id, req.params.entryId);
    if (!lock || lock.locked_by !== userId) return res.status(403).json({ error: 'Lock not held by you' });

    sharedDb.transaction(() => {
        stmtDeleteDraft.run(req.params.id, req.params.entryId, userId);
        stmtDeleteLock.run(req.params.id, req.params.entryId);
    })();

    return res.status(204).end();
}

// PUT /api/lorebooks/:id/entries/:entryId — the only operation that actually
// needs the lock: global requires holding it, private requires ownership only.
function saveEntry(req, res) {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const book = stmtGetLorebook.get(req.params.id);
    if (!book || !canView(book, userId)) return res.status(404).json({ error: 'Not found' });

    if (book.scope === 'global') {
        const lock = getLockStatus(req.params.id, req.params.entryId);
        if (!lock || lock.locked_by !== userId) return res.status(403).json({ error: 'Lock not held by you' });
    } else if (book.owner_id !== userId) {
        return res.status(403).json({ error: 'Not the owner' });
    }

    const entry = req.body;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return res.status(400).json({ error: 'Body must be a single entry object' });
    }

    const content = JSON.parse(book.content);
    const idx = findEntryIndex(content, req.params.entryId);
    if (idx === -1) return res.status(404).json({ error: 'Entry not found' });

    const now = Date.now();
    const updated = sharedDb.transaction(() => {
        archiveCurrentContent(book, now);
        content[idx] = { ...entry, id: req.params.entryId };
        stmtUpdateLorebook.run(book.title, JSON.stringify(content), now, userId, req.params.id);
        stmtDeleteDraft.run(req.params.id, req.params.entryId, userId);
        stmtDeleteLock.run(req.params.id, req.params.entryId);
        return stmtGetLorebook.get(req.params.id);
    })();

    return res.json(serializeLorebookDetail(updated, userId));
}

// ─── Mount ────────────────────────────────────────────────────────────────────
function mountLorebookApi(app) {
    app.get('/api/lorebooks', listLorebooks);
    app.post('/api/lorebooks', createLorebook);
    app.get('/api/lorebooks/:id', getLorebook);
    app.patch('/api/lorebooks/:id', renameLorebook);
    app.post('/api/lorebooks/:id/to-global', toGlobal);
    app.post('/api/lorebooks/:id/clone', cloneLorebook);
    app.delete('/api/lorebooks/:id', deleteLorebook);
    app.put('/api/lorebooks/:id/overrides', saveOverrides);
    app.get('/api/lorebooks/:id/versions', listVersions);
    app.post('/api/lorebooks/:id/restore/:versionId', restoreVersion);

    app.post('/api/lorebooks/:id/entries', createEntry);
    app.patch('/api/lorebooks/:id/entries/reorder', reorderEntries);
    app.post('/api/lorebooks/:id/entries/:entryId/lock', lockEntry);
    app.delete('/api/lorebooks/:id/entries/:entryId/lock', cancelEntryLock);
    app.put('/api/lorebooks/:id/entries/:entryId', saveEntry);
    app.delete('/api/lorebooks/:id/entries/:entryId', deleteEntry);
}

module.exports = { mountLorebookApi };
