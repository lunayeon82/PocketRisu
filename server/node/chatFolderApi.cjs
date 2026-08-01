'use strict';

const { randomUUID } = require('crypto');
const { sharedDb } = require('./authGate.cjs');
const { resolveUserId } = require('./chatApi.cjs');

// ─── Schema ───────────────────────────────────────────────────────────────────
// Chat folders used to live on character.chatFolders inside the shared
// database.bin blob (see CLAUDE.md / chatApi.cjs's rl_chats history) — every
// account saw the same folder list. This table scopes folders per account,
// mirroring rl_chats. parent_id supports exactly one level of nesting
// (depth 2): a folder whose own parent_id is non-null can't be used as a
// parent itself — enforced in createFolder/updateFolder below, not in SQL.
sharedDb.exec(`
  CREATE TABLE IF NOT EXISTS rl_chat_folders (
    id           TEXT    PRIMARY KEY,
    user_id      INTEGER NOT NULL,
    character_id TEXT    NOT NULL,
    name         TEXT    NOT NULL DEFAULT '',
    color        TEXT,
    folded       INTEGER NOT NULL DEFAULT 0,
    parent_id    TEXT,
    position     INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  )
`);
sharedDb.exec(`CREATE INDEX IF NOT EXISTS idx_rl_chat_folders_user ON rl_chat_folders(user_id, character_id, parent_id, position)`);

// ─── Prepared statements ──────────────────────────────────────────────────────
const stmtListFolders = sharedDb.prepare(`
  SELECT * FROM rl_chat_folders WHERE user_id = ? AND character_id = ? ORDER BY position ASC
`);

const stmtGetFolder = sharedDb.prepare(`SELECT * FROM rl_chat_folders WHERE id = ? AND user_id = ?`);

const stmtHasChildren = sharedDb.prepare(`
  SELECT 1 FROM rl_chat_folders WHERE parent_id = ? AND user_id = ? LIMIT 1
`);

const stmtInsertFolder = sharedDb.prepare(`
  INSERT INTO rl_chat_folders (id, user_id, character_id, name, color, folded, parent_id, position, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const stmtUpdateFolder = sharedDb.prepare(`
  UPDATE rl_chat_folders SET name = ?, color = ?, folded = ?, parent_id = ?, position = ?, updated_at = ?
  WHERE id = ? AND user_id = ?
`);

const stmtDeleteFolder = sharedDb.prepare(`DELETE FROM rl_chat_folders WHERE id = ? AND user_id = ?`);

const stmtPromoteChildrenToRoot = sharedDb.prepare(`
  UPDATE rl_chat_folders SET parent_id = NULL WHERE parent_id = ? AND user_id = ?
`);

const stmtClearChatsFolderId = sharedDb.prepare(`
  UPDATE rl_chats SET folder_id = NULL WHERE folder_id = ? AND user_id = ?
`);

const stmtNextPosition = sharedDb.prepare(`
  SELECT COALESCE(MAX(position), -1) AS max_position FROM rl_chat_folders
  WHERE user_id = ? AND character_id = ?
    AND ((parent_id IS NULL AND ? IS NULL) OR parent_id = ?)
`);

function nextPosition(userId, characterId, parentId) {
    const row = stmtNextPosition.get(userId, characterId, parentId, parentId);
    return (row?.max_position ?? -1) + 1;
}

function serializeFolderRow(row) {
    return {
        id: row.id,
        character_id: row.character_id,
        name: row.name,
        color: row.color,
        folded: !!row.folded,
        parent_id: row.parent_id,
        position: row.position,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}

// ─── Route handlers ───────────────────────────────────────────────────────────

// GET /api/chat-folders?character_id=xxx
function listFolders(req, res) {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const { character_id } = req.query;
    if (!character_id) return res.status(400).json({ error: 'character_id required' });
    const rows = stmtListFolders.all(userId, character_id);
    return res.json(rows.map(serializeFolderRow));
}

// POST /api/chat-folders
function createFolder(req, res) {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { character_id, name = '', color = null, parent_id = null } = req.body || {};
    if (!character_id) return res.status(400).json({ error: 'character_id required' });

    if (parent_id != null) {
        const parent = stmtGetFolder.get(parent_id, userId);
        if (!parent) return res.status(404).json({ error: 'Parent folder not found' });
        if (parent.parent_id != null) {
            return res.status(400).json({ error: 'Max folder depth (2) exceeded' });
        }
    }

    // Accepts a client-supplied id (bootstrap-time migration from the legacy
    // database.bin-embedded chatFolders passes the original folder id through
    // so existing chat.folderId references don't orphan) — falls back to a
    // fresh uuid for normal folder creation.
    const id = req.body.id || randomUUID();
    const now = Date.now();
    const position = nextPosition(userId, character_id, parent_id);
    try {
        stmtInsertFolder.run(id, userId, character_id, name, color, 0, parent_id, position, now, now);
    } catch (e) {
        if (/UNIQUE/.test(e.message)) return res.status(409).json({ error: 'Folder id already exists' });
        throw e;
    }

    return res.status(201).json(serializeFolderRow(stmtGetFolder.get(id, userId)));
}

// PUT /api/chat-folders/:id
function updateFolder(req, res) {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const existing = stmtGetFolder.get(req.params.id, userId);
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const body = req.body || {};
    const hasParentId = Object.prototype.hasOwnProperty.call(body, 'parent_id');
    const newParentId = hasParentId ? (body.parent_id == null ? null : String(body.parent_id)) : existing.parent_id;

    if (hasParentId && newParentId != null) {
        if (newParentId === existing.id) {
            return res.status(400).json({ error: 'A folder cannot be its own parent' });
        }
        const parent = stmtGetFolder.get(newParentId, userId);
        if (!parent) return res.status(404).json({ error: 'Parent folder not found' });
        if (parent.parent_id != null) {
            return res.status(400).json({ error: 'Max folder depth (2) exceeded' });
        }
        if (stmtHasChildren.get(existing.id, userId)) {
            return res.status(400).json({ error: 'Cannot nest a folder that already has subfolders' });
        }
    }

    const newName = body.name !== undefined ? String(body.name) : existing.name;
    const newColor = body.color !== undefined ? body.color : existing.color;
    const newFolded = body.folded !== undefined ? (body.folded ? 1 : 0) : existing.folded;
    const newPosition = body.position !== undefined ? Number(body.position) : existing.position;
    const now = Date.now();

    stmtUpdateFolder.run(newName, newColor, newFolded, newParentId, newPosition, now, req.params.id, userId);
    return res.json(serializeFolderRow(stmtGetFolder.get(req.params.id, userId)));
}

// DELETE /api/chat-folders/:id
// Does not cascade-delete contents: child folders are promoted to root, and
// any chat pointing at this folder is unassigned (folder_id = NULL) — same
// as the prior client-side behavior when chatFolders lived in database.bin.
function deleteFolder(req, res) {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const existing = stmtGetFolder.get(req.params.id, userId);
    if (!existing) return res.status(404).json({ error: 'Not found' });

    sharedDb.transaction(() => {
        stmtPromoteChildrenToRoot.run(req.params.id, userId);
        stmtClearChatsFolderId.run(req.params.id, userId);
        stmtDeleteFolder.run(req.params.id, userId);
    })();

    return res.status(204).end();
}

// ─── Mount ────────────────────────────────────────────────────────────────────
function mountChatFolderApi(app) {
    app.get('/api/chat-folders', listFolders);
    app.post('/api/chat-folders', createFolder);
    app.put('/api/chat-folders/:id', updateFolder);
    app.delete('/api/chat-folders/:id', deleteFolder);
}

module.exports = { mountChatFolderApi };
