'use strict';

const { randomUUID } = require('crypto');
const { sharedDb } = require('./authGate.cjs');
const { resolveUserId } = require('./chatApi.cjs');

// Foreign-key constraints (CASCADE DELETE on versions/locks/drafts) require this per-connection.
sharedDb.pragma('foreign_keys = ON');

// Pessimistic-lock timeout. A lock older than this is treated as abandoned.
// On expiry only the lock row is dropped — the draft is intentionally kept
// (see rl_lorebook_drafts below) so a user who stepped away for over an hour
// doesn't come back to find their in-progress edits gone.
const LOCK_TTL_MS = 60 * 60 * 1000;

// ─── Schema ───────────────────────────────────────────────────────────────────
// Shared lorebook repository: one canonical copy per lorebook (rl_lorebooks),
// edited under a pessimistic lock (rl_lorebook_locks) via a per-editor personal
// copy (rl_lorebook_drafts) so concurrent GETs of the canonical row never see a
// half-typed edit. content columns store JSON.stringify(loreBook[]) — the same
// shape as character.globalLore (see src/ts/storage/database.svelte.ts) and
// src/ts/process/lorebook.svelte.ts's import/export, minus the {type,ver}
// file-interchange wrapper, which only exists at the file boundary.
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

// One row per lorebook — existence means locked. locked_at is refreshed on
// re-lock by the same holder; a different requester gets 409 while it's
// live and not expired.
sharedDb.exec(`
  CREATE TABLE IF NOT EXISTS rl_lorebook_locks (
    lorebook_id TEXT    PRIMARY KEY REFERENCES rl_lorebooks(id) ON DELETE CASCADE,
    locked_by   INTEGER NOT NULL REFERENCES rl_users(id),
    locked_at   INTEGER NOT NULL
  )
`);

// Personal copy, keyed per (lorebook, user) so a past editor's abandoned
// draft can't collide with the current one. Survives lock expiry by design
// (see LOCK_TTL_MS comment); only cleared by an explicit save or cancel.
sharedDb.exec(`
  CREATE TABLE IF NOT EXISTS rl_lorebook_drafts (
    lorebook_id TEXT    NOT NULL REFERENCES rl_lorebooks(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES rl_users(id),
    content     TEXT    NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (lorebook_id, user_id)
  )
`);

// ─── Prepared statements ──────────────────────────────────────────────────────
const stmtListLorebooks = sharedDb.prepare(`SELECT id, title, updated_at, updated_by FROM rl_lorebooks ORDER BY updated_at DESC`);
const stmtGetLorebook = sharedDb.prepare(`SELECT * FROM rl_lorebooks WHERE id = ?`);
const stmtInsertLorebook = sharedDb.prepare(`
  INSERT INTO rl_lorebooks (id, title, content, created_at, updated_at, updated_by)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const stmtUpdateLorebook = sharedDb.prepare(`
  UPDATE rl_lorebooks SET title = ?, content = ?, updated_at = ?, updated_by = ? WHERE id = ?
`);

const stmtGetUsername = sharedDb.prepare(`SELECT username FROM rl_users WHERE id = ?`);

const stmtGetLock = sharedDb.prepare(`SELECT * FROM rl_lorebook_locks WHERE lorebook_id = ?`);
const stmtUpsertLock = sharedDb.prepare(`
  INSERT INTO rl_lorebook_locks (lorebook_id, locked_by, locked_at) VALUES (?, ?, ?)
  ON CONFLICT(lorebook_id) DO UPDATE SET locked_by = excluded.locked_by, locked_at = excluded.locked_at
`);
const stmtDeleteLock = sharedDb.prepare(`DELETE FROM rl_lorebook_locks WHERE lorebook_id = ?`);

const stmtGetDraft = sharedDb.prepare(`SELECT * FROM rl_lorebook_drafts WHERE lorebook_id = ? AND user_id = ?`);
const stmtUpsertDraft = sharedDb.prepare(`
  INSERT INTO rl_lorebook_drafts (lorebook_id, user_id, content, updated_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(lorebook_id, user_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at
`);
const stmtDeleteDraft = sharedDb.prepare(`DELETE FROM rl_lorebook_drafts WHERE lorebook_id = ? AND user_id = ?`);

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

const MAX_VERSIONS = 3;

// ─── Helpers ────────────────────────────────────────────────────────────────
function getUsername(userId) {
    const row = stmtGetUsername.get(userId);
    return row ? row.username : null;
}

// Resolves the live lock for a lorebook, lazily clearing it if it has expired.
// The draft is deliberately left alone on expiry (see LOCK_TTL_MS comment).
function getLockStatus(lorebookId) {
    const lock = stmtGetLock.get(lorebookId);
    if (!lock) return null;
    if (Date.now() - lock.locked_at > LOCK_TTL_MS) {
        stmtDeleteLock.run(lorebookId);
        return null;
    }
    return lock;
}

function serializeLockStatus(lorebookId) {
    const lock = getLockStatus(lorebookId);
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
        updated_at: row.updated_at,
        updated_by: row.updated_by,
        updated_by_username: getUsername(row.updated_by),
        lock: serializeLockStatus(row.id),
    };
}

function serializeLorebookDetail(row) {
    return {
        ...serializeLorebookSummary(row),
        content: JSON.parse(row.content),
    };
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

// Archives the lorebook's current (pre-overwrite) content as a version
// attributed to whoever last wrote it, then trims to MAX_VERSIONS. Shared by
// save and restore, which both replace rl_lorebooks.content wholesale.
function archiveCurrentContent(book, now) {
    stmtInsertVersion.run(randomUUID(), book.id, book.content, now, book.updated_by);
    trimVersions(book.id);
}

// ─── Route handlers ───────────────────────────────────────────────────────────

// GET /api/lorebooks
function listLorebooks(req, res) {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const rows = stmtListLorebooks.all();
    return res.json(rows.map(serializeLorebookSummary));
}

// POST /api/lorebooks
function createLorebook(req, res) {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { title = '', content } = req.body || {};
    if (!Array.isArray(content)) return res.status(400).json({ error: 'content must be an array' });

    const id = req.body.id || randomUUID();
    const now = Date.now();
    try {
        stmtInsertLorebook.run(id, String(title), JSON.stringify(content), now, now, userId);
    } catch (e) {
        if (/UNIQUE/.test(e.message)) return res.status(409).json({ error: 'Lorebook id already exists' });
        throw e;
    }

    return res.status(201).json(serializeLorebookDetail(stmtGetLorebook.get(id)));
}

// GET /api/lorebooks/:id
function getLorebook(req, res) {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const book = stmtGetLorebook.get(req.params.id);
    if (!book) return res.status(404).json({ error: 'Not found' });
    return res.json(serializeLorebookDetail(book));
}

// POST /api/lorebooks/:id/lock
function lockLorebook(req, res) {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const book = stmtGetLorebook.get(req.params.id);
    if (!book) return res.status(404).json({ error: 'Not found' });

    const now = Date.now();
    const lock = getLockStatus(req.params.id); // lazily expires a stale lock

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
        stmtUpsertLock.run(req.params.id, userId, now);
        const draft = stmtGetDraft.get(req.params.id, userId);
        return res.json({ content: JSON.parse(draft.content), locked_at: now });
    }

    // No live lock: acquire it. If this requester already has a draft of
    // their own for this lorebook (left over from an expired lock they never
    // came back to finish, or cancel), keep it — that's the whole point of
    // preserving drafts across expiry. Only start from the canonical content
    // when they have no draft yet.
    const draft = sharedDb.transaction(() => {
        stmtUpsertLock.run(req.params.id, userId, now);
        let d = stmtGetDraft.get(req.params.id, userId);
        if (!d) {
            stmtUpsertDraft.run(req.params.id, userId, book.content, now);
            d = stmtGetDraft.get(req.params.id, userId);
        }
        return d;
    })();

    return res.json({ content: JSON.parse(draft.content), locked_at: now });
}

// PUT /api/lorebooks/:id — lock holder only
function saveLorebook(req, res) {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const book = stmtGetLorebook.get(req.params.id);
    if (!book) return res.status(404).json({ error: 'Not found' });

    const lock = getLockStatus(req.params.id);
    if (!lock || lock.locked_by !== userId) return res.status(403).json({ error: 'Lock not held by you' });

    const { content, title } = req.body || {};
    if (!Array.isArray(content)) return res.status(400).json({ error: 'content must be an array' });

    const now = Date.now();
    const newTitle = title !== undefined ? String(title) : book.title;

    const updated = sharedDb.transaction(() => {
        archiveCurrentContent(book, now);
        stmtUpdateLorebook.run(newTitle, JSON.stringify(content), now, userId, req.params.id);
        stmtDeleteDraft.run(req.params.id, userId);
        stmtDeleteLock.run(req.params.id);
        return stmtGetLorebook.get(req.params.id);
    })();

    return res.json(serializeLorebookDetail(updated));
}

// DELETE /api/lorebooks/:id/lock — cancel: discard the personal copy, release
// the lock, leave the canonical content untouched.
function cancelLock(req, res) {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    if (!stmtGetLorebook.get(req.params.id)) return res.status(404).json({ error: 'Not found' });

    const lock = getLockStatus(req.params.id);
    if (!lock || lock.locked_by !== userId) return res.status(403).json({ error: 'Lock not held by you' });

    sharedDb.transaction(() => {
        stmtDeleteDraft.run(req.params.id, userId);
        stmtDeleteLock.run(req.params.id);
    })();

    return res.status(204).end();
}

// GET /api/lorebooks/:id/versions
function listVersions(req, res) {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    if (!stmtGetLorebook.get(req.params.id)) return res.status(404).json({ error: 'Not found' });

    const rows = stmtListVersions.all(req.params.id);
    return res.json(rows.map(serializeVersion));
}

// POST /api/lorebooks/:id/restore/:versionId — lock holder only. Behaves like
// a save whose new content comes from a past version: archives what's live
// right now (so restoring is itself undoable), then swaps it in.
function restoreVersion(req, res) {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const book = stmtGetLorebook.get(req.params.id);
    if (!book) return res.status(404).json({ error: 'Not found' });

    const lock = getLockStatus(req.params.id);
    if (!lock || lock.locked_by !== userId) return res.status(403).json({ error: 'Lock not held by you' });

    const version = stmtGetVersion.get(req.params.versionId, req.params.id);
    if (!version) return res.status(404).json({ error: 'Version not found' });

    const now = Date.now();
    const updated = sharedDb.transaction(() => {
        archiveCurrentContent(book, now);
        stmtUpdateLorebook.run(book.title, version.content, now, userId, req.params.id);
        stmtDeleteDraft.run(req.params.id, userId);
        stmtDeleteLock.run(req.params.id);
        return stmtGetLorebook.get(req.params.id);
    })();

    return res.json(serializeLorebookDetail(updated));
}

// ─── Mount ────────────────────────────────────────────────────────────────────
function mountLorebookApi(app) {
    app.get('/api/lorebooks', listLorebooks);
    app.post('/api/lorebooks', createLorebook);
    app.get('/api/lorebooks/:id', getLorebook);
    app.post('/api/lorebooks/:id/lock', lockLorebook);
    app.put('/api/lorebooks/:id', saveLorebook);
    app.delete('/api/lorebooks/:id/lock', cancelLock);
    app.get('/api/lorebooks/:id/versions', listVersions);
    app.post('/api/lorebooks/:id/restore/:versionId', restoreVersion);
}

module.exports = { mountLorebookApi };
