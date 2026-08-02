'use strict';

const { randomUUID } = require('crypto');
const { sharedDb, isAdmin } = require('./authGate.cjs');
const { resolveUserId } = require('./chatApi.cjs');

// Foreign-key constraints (CASCADE DELETE on versions/locks/drafts/overrides) require this per-connection.
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
//
// scope='global' rows are visible/lockable by anyone; scope='private' rows
// are owner_id-only and never use locks (see canView/lockLorebook below) —
// a private lorebook has exactly one possible editor, so the whole
// lock-and-personal-copy dance that global rows need is pointless for them.
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

// One row per lorebook — existence means locked. locked_at is refreshed on
// re-lock by the same holder; a different requester gets 409 while it's
// live and not expired. Only ever created for scope='global' rows.
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

// Per-viewer activation preference for a single entry of a global lorebook.
// Absence of a row means the default ('trigger') applies — saveOverrides()
// below only ever writes non-default rows, so this table stays small.
// entry_id anchors to loreBook.id, which global-scope content is guaranteed
// to have on every entry (backfillEntryIds() fills gaps at every write path
// that can produce a global row: create, save, restore, to-global).
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
// Global rows are visible to everyone; private rows only to their owner.
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

const stmtGetOverrides = sharedDb.prepare(`SELECT entry_id, mode FROM rl_lorebook_overrides WHERE user_id = ? AND lorebook_id = ?`);
const stmtDeleteOverridesForUser = sharedDb.prepare(`DELETE FROM rl_lorebook_overrides WHERE user_id = ? AND lorebook_id = ?`);
const stmtInsertOverride = sharedDb.prepare(`
  INSERT INTO rl_lorebook_overrides (user_id, lorebook_id, entry_id, mode) VALUES (?, ?, ?, ?)
`);

const MAX_VERSIONS = 3;
const VALID_OVERRIDE_MODES = new Set(['always', 'trigger', 'disabled']);

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

// Ensures every entry has a stable id — required for rl_lorebook_overrides
// to anchor to a specific entry. Only fills gaps (existing ids are kept);
// see cloneLorebook() for the "regenerate all ids" case used on copy.
function backfillEntryIds(content) {
    let changed = false;
    const result = content.map((entry) => {
        if (entry && entry.id) return entry;
        changed = true;
        return { ...entry, id: randomUUID() };
    });
    return { content: result, changed };
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
        scope: row.scope,
        owner_id: row.owner_id,
        updated_at: row.updated_at,
        updated_by: row.updated_by,
        updated_by_username: getUsername(row.updated_by),
        // Private rows never have a lock row (lockLorebook rejects them), but
        // skip the lookup entirely rather than rely on that.
        lock: row.scope === 'global' ? serializeLockStatus(row.id) : null,
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

// Archives the lorebook's current (pre-overwrite) content as a version
// attributed to whoever last wrote it, then trims to MAX_VERSIONS. Shared by
// save and restore, which both replace rl_lorebooks.content wholesale.
function archiveCurrentContent(book, now) {
    stmtInsertVersion.run(randomUUID(), book.id, book.content, now, book.updated_by);
    trimVersions(book.id);
}

// ─── Route handlers ───────────────────────────────────────────────────────────

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
    const finalContent = scope === 'global' ? backfillEntryIds(content).content : content;

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

// POST /api/lorebooks/:id/lock — global only; private has exactly one
// possible editor (the owner) so locking is meaningless there.
function lockLorebook(req, res) {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const book = stmtGetLorebook.get(req.params.id);
    if (!book || !canView(book, userId)) return res.status(404).json({ error: 'Not found' });
    if (book.scope === 'private') return res.status(400).json({ error: 'Private lorebooks do not use locks' });

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

// PUT /api/lorebooks/:id — global requires the lock; private requires ownership only.
function saveLorebook(req, res) {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const book = stmtGetLorebook.get(req.params.id);
    if (!book || !canView(book, userId)) return res.status(404).json({ error: 'Not found' });

    if (book.scope === 'global') {
        const lock = getLockStatus(req.params.id);
        if (!lock || lock.locked_by !== userId) return res.status(403).json({ error: 'Lock not held by you' });
    } else if (book.owner_id !== userId) {
        return res.status(403).json({ error: 'Not the owner' });
    }

    const { content, title } = req.body || {};
    if (!Array.isArray(content)) return res.status(400).json({ error: 'content must be an array' });

    const now = Date.now();
    const newTitle = title !== undefined ? String(title) : book.title;
    const finalContent = book.scope === 'global' ? backfillEntryIds(content).content : content;

    const updated = sharedDb.transaction(() => {
        archiveCurrentContent(book, now);
        stmtUpdateLorebook.run(newTitle, JSON.stringify(finalContent), now, userId, req.params.id);
        // No-ops for private (no draft/lock rows ever exist for it).
        stmtDeleteDraft.run(req.params.id, userId);
        stmtDeleteLock.run(req.params.id);
        return stmtGetLorebook.get(req.params.id);
    })();

    return res.json(serializeLorebookDetail(updated, userId));
}

// DELETE /api/lorebooks/:id/lock — cancel: discard the personal copy, release
// the lock, leave the canonical content untouched. Global only (see lockLorebook).
function cancelLock(req, res) {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const book = stmtGetLorebook.get(req.params.id);
    if (!book || !canView(book, userId)) return res.status(404).json({ error: 'Not found' });
    if (book.scope === 'private') return res.status(400).json({ error: 'Private lorebooks do not use locks' });

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
    const book = stmtGetLorebook.get(req.params.id);
    if (!book || !canView(book, userId)) return res.status(404).json({ error: 'Not found' });

    const rows = stmtListVersions.all(req.params.id);
    return res.json(rows.map(serializeVersion));
}

// POST /api/lorebooks/:id/restore/:versionId — global requires the lock (like
// save); private requires ownership only. Behaves like a save whose new
// content comes from a past version: archives what's live right now (so
// restoring is itself undoable), then swaps it in. The client only surfaces
// this in the UI for global lorebooks, but the API allows it for a private
// owner too rather than arbitrarily forbidding it.
function restoreVersion(req, res) {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const book = stmtGetLorebook.get(req.params.id);
    if (!book || !canView(book, userId)) return res.status(404).json({ error: 'Not found' });

    if (book.scope === 'global') {
        const lock = getLockStatus(req.params.id);
        if (!lock || lock.locked_by !== userId) return res.status(403).json({ error: 'Lock not held by you' });
    } else if (book.owner_id !== userId) {
        return res.status(403).json({ error: 'Not the owner' });
    }

    const version = stmtGetVersion.get(req.params.versionId, req.params.id);
    if (!version) return res.status(404).json({ error: 'Version not found' });

    const now = Date.now();
    // Old versions predating this feature (or ones saved before an entry got
    // its first id) might still be missing ids — backfill again on restore.
    const restoredContent = book.scope === 'global'
        ? JSON.stringify(backfillEntryIds(JSON.parse(version.content)).content)
        : version.content;

    const updated = sharedDb.transaction(() => {
        archiveCurrentContent(book, now);
        stmtUpdateLorebook.run(book.title, restoredContent, now, userId, req.params.id);
        stmtDeleteDraft.run(req.params.id, userId);
        stmtDeleteLock.run(req.params.id);
        return stmtGetLorebook.get(req.params.id);
    })();

    return res.json(serializeLorebookDetail(updated, userId));
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
// or accidentally alias entries with it.
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
    app.post('/api/lorebooks/:id/to-global', toGlobal);
    app.post('/api/lorebooks/:id/clone', cloneLorebook);
    app.delete('/api/lorebooks/:id', deleteLorebook);
    app.put('/api/lorebooks/:id/overrides', saveOverrides);
}

module.exports = { mountLorebookApi };
