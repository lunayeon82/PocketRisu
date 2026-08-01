'use strict';

const { randomUUID } = require('crypto');
const { sharedDb, getSession, getUserByUsername } = require('./authGate.cjs');

// Foreign-key constraints (CASCADE DELETE on rl_messages) require this per-connection.
sharedDb.pragma('foreign_keys = ON');

// ─── Schema ───────────────────────────────────────────────────────────────────
sharedDb.exec(`
  CREATE TABLE IF NOT EXISTS rl_chats (
    id           TEXT    PRIMARY KEY,
    user_id      INTEGER NOT NULL,
    character_id TEXT    NOT NULL,
    title        TEXT    NOT NULL DEFAULT '',
    chat_meta    TEXT,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  )
`);
sharedDb.exec(`CREATE INDEX IF NOT EXISTS idx_rl_chats_user ON rl_chats(user_id, updated_at)`);

// Added after the initial rl_chats rollout — guard with table_info so existing
// deploys upgrade in place instead of erroring on re-run (mirrors rl_users/is_admin
// in authGate.cjs). Backfills preserve what folder placement already existed in
// chat_meta and approximate ordering via created_at since no order was tracked before.
const rlChatsColumns = sharedDb.prepare(`PRAGMA table_info(rl_chats)`).all();
if (!rlChatsColumns.some((c) => c.name === 'folder_id')) {
    sharedDb.exec(`ALTER TABLE rl_chats ADD COLUMN folder_id TEXT`);
    const rows = sharedDb.prepare(`SELECT id, chat_meta FROM rl_chats WHERE chat_meta IS NOT NULL`).all();
    const backfillFolder = sharedDb.prepare(`UPDATE rl_chats SET folder_id = ? WHERE id = ?`);
    sharedDb.transaction(() => {
        for (const row of rows) {
            try {
                const meta = JSON.parse(row.chat_meta);
                if (meta.folderId != null) backfillFolder.run(meta.folderId, row.id);
            } catch {}
        }
    })();
}
if (!rlChatsColumns.some((c) => c.name === 'position')) {
    sharedDb.exec(`ALTER TABLE rl_chats ADD COLUMN position INTEGER NOT NULL DEFAULT 0`);
    const groups = sharedDb.prepare(`
        SELECT id, user_id, character_id, folder_id
        FROM rl_chats
        ORDER BY user_id, character_id, folder_id IS NOT NULL, folder_id, created_at ASC
    `).all();
    const backfillPosition = sharedDb.prepare(`UPDATE rl_chats SET position = ? WHERE id = ?`);
    sharedDb.transaction(() => {
        let prevKey = null;
        let pos = 0;
        for (const row of groups) {
            const key = `${row.user_id} ${row.character_id} ${row.folder_id ?? ''}`;
            pos = key === prevKey ? pos + 1 : 0;
            prevKey = key;
            backfillPosition.run(pos, row.id);
        }
    })();
}
sharedDb.exec(`CREATE INDEX IF NOT EXISTS idx_rl_chats_folder ON rl_chats(user_id, character_id, folder_id, position)`);

sharedDb.exec(`
  CREATE TABLE IF NOT EXISTS rl_messages (
    id         TEXT    PRIMARY KEY,
    chat_id    TEXT    NOT NULL REFERENCES rl_chats(id) ON DELETE CASCADE,
    role       TEXT    NOT NULL,
    content    TEXT    NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )
`);
sharedDb.exec(`CREATE INDEX IF NOT EXISTS idx_rl_messages_chat ON rl_messages(chat_id, sort_order)`);

// ─── Prepared statements ──────────────────────────────────────────────────────
const stmtListChats = sharedDb.prepare(`
  SELECT c.id, c.character_id, c.title, c.chat_meta, c.folder_id, c.position, c.created_at, c.updated_at,
         (SELECT COUNT(*) FROM rl_messages m WHERE m.chat_id = c.id) AS message_count
  FROM rl_chats c
  WHERE c.user_id = ?
  ORDER BY c.position ASC, c.updated_at DESC
`);

const stmtGetChat = sharedDb.prepare(`
  SELECT id, character_id, title, chat_meta, folder_id, position, created_at, updated_at
  FROM rl_chats WHERE id = ? AND user_id = ?
`);

const stmtOwnsChat = sharedDb.prepare(`SELECT 1 FROM rl_chats WHERE id = ? AND user_id = ?`);

const stmtInsertChat = sharedDb.prepare(`
  INSERT INTO rl_chats (id, user_id, character_id, title, chat_meta, folder_id, position, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const stmtUpdateChat = sharedDb.prepare(`
  UPDATE rl_chats SET title = ?, chat_meta = ?, folder_id = ?, updated_at = ?
  WHERE id = ? AND user_id = ?
`);

const stmtDeleteChat = sharedDb.prepare(`DELETE FROM rl_chats WHERE id = ? AND user_id = ?`);

const stmtTouchChat = sharedDb.prepare(`UPDATE rl_chats SET updated_at = ? WHERE id = ?`);

const stmtNextPosition = sharedDb.prepare(`
  SELECT COALESCE(MAX(position), -1) AS max_position FROM rl_chats
  WHERE user_id = ? AND character_id = ?
    AND ((folder_id IS NULL AND ? IS NULL) OR folder_id = ?)
`);

// Metadata-only patch (folder move / reorder / rename). Takes final resolved
// values (not COALESCE) since folder_id legitimately needs to become NULL
// (moved out of any folder) — COALESCE can't distinguish "clear it" from
// "leave it alone" when both mean passing null. The handler resolves
// "field omitted" vs "field explicitly null" before calling this.
const stmtPatchMeta = sharedDb.prepare(`
  UPDATE rl_chats SET folder_id = ?, position = ?, title = ?
  WHERE id = ? AND user_id = ?
`);

const stmtPatchMetaTouch = sharedDb.prepare(`
  UPDATE rl_chats SET folder_id = ?, position = ?, title = ?, updated_at = ?
  WHERE id = ? AND user_id = ?
`);

const stmtReorderOne = sharedDb.prepare(`
  UPDATE rl_chats SET position = ?, folder_id = ? WHERE id = ? AND user_id = ?
`);

const stmtGetMessages = sharedDb.prepare(`
  SELECT id, role, content, sort_order, created_at
  FROM rl_messages WHERE chat_id = ? ORDER BY sort_order ASC
`);

const stmtGetMessage = sharedDb.prepare(`
  SELECT id, chat_id, role, content, sort_order, created_at
  FROM rl_messages WHERE id = ? AND chat_id = ?
`);

const stmtInsertMessage = sharedDb.prepare(`
  INSERT INTO rl_messages (id, chat_id, role, content, sort_order, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const stmtUpdateMessage = sharedDb.prepare(`
  UPDATE rl_messages SET role = ?, content = ? WHERE id = ? AND chat_id = ?
`);

const stmtDeleteMessage = sharedDb.prepare(`DELETE FROM rl_messages WHERE id = ? AND chat_id = ?`);

const stmtMaxSortOrder = sharedDb.prepare(`
  SELECT COALESCE(MAX(sort_order), -1) AS max_order FROM rl_messages WHERE chat_id = ?
`);

const stmtDeleteChatMessages = sharedDb.prepare(`DELETE FROM rl_messages WHERE chat_id = ?`);

const stmtListChatsByCharacter = sharedDb.prepare(`
  SELECT c.id, c.character_id, c.title, c.chat_meta, c.folder_id, c.position, c.created_at, c.updated_at,
         (SELECT COUNT(*) FROM rl_messages m WHERE m.chat_id = c.id) AS message_count
  FROM rl_chats c
  WHERE c.user_id = ? AND c.character_id = ?
  ORDER BY c.position ASC, c.updated_at DESC
`);

// Bulk message insert — used by createChat and addMessage
const insertMsgsBatch = sharedDb.transaction((msgs, chatId, baseOrder, now) => {
    const inserted = [];
    for (let i = 0; i < msgs.length; i++) {
        const msg = msgs[i];
        const id = randomUUID();
        const role = msg.role || 'user';
        const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? msg);
        const sortOrder = msg.sort_order !== undefined ? msg.sort_order : baseOrder + 1 + i;
        stmtInsertMessage.run(id, chatId, role, content, sortOrder, now);
        inserted.push({ id, chat_id: chatId, role, content, sort_order: sortOrder, created_at: now });
    }
    return inserted;
});

// ─── Auth helper ──────────────────────────────────────────────────────────────
function resolveUserId(req) {
    const session = getSession(req);
    if (!session) return null;
    const user = getUserByUsername(session.username);
    return user ? user.id : null;
}

function toJSON(val) {
    return val !== undefined ? JSON.stringify(val) : null;
}

// folder_id is now a real column (see the migration block above); chat_meta.folderId
// is kept around for backward-compat clients but the column is the source of truth
// once set. Full-object writers (create/update/upsert) sync the column from
// chat_meta.folderId whenever chat_meta is present so the two can't drift.
function folderIdFromMeta(chat_meta) {
    return chat_meta && chat_meta.folderId != null ? String(chat_meta.folderId) : null;
}

function nextPosition(userId, characterId, folderId) {
    const row = stmtNextPosition.get(userId, characterId, folderId, folderId);
    return (row?.max_position ?? -1) + 1;
}

// ─── Route handlers ───────────────────────────────────────────────────────────

// Serialize a raw rl_chats row into the shape the client expects.
// Extracts stub-level fields from chat_meta so the client can build
// ChatStub objects without a separate full-chat fetch.
function serializeChatRow(row) {
    let meta = {};
    if (row.chat_meta) {
        try { meta = JSON.parse(row.chat_meta); } catch {}
    }
    return {
        id:           row.id,
        character_id: row.character_id,
        title:        row.title,
        chat_meta:    row.chat_meta,
        created_at:   row.created_at,
        updated_at:   row.updated_at,
        message_count: row.message_count,
        last_date:    meta.lastDate ?? null,
        folder_id:    row.folder_id ?? null,
        position:     row.position ?? 0,
        modules:      Array.isArray(meta.modules) ? meta.modules : null,
    };
}

// GET /api/chats[?character_id=xxx]
function listChats(req, res) {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const { character_id } = req.query;
    const rows = character_id
        ? stmtListChatsByCharacter.all(userId, character_id)
        : stmtListChats.all(userId);
    return res.json(rows.map(serializeChatRow));
}

// GET /api/chats/:id
function getChat(req, res) {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const chat = stmtGetChat.get(req.params.id, userId);
    if (!chat) return res.status(404).json({ error: 'Not found' });
    const messages = stmtGetMessages.all(req.params.id);
    return res.json({ ...chat, messages });
}

// POST /api/chats
function createChat(req, res) {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { character_id, title = '', chat_meta, messages } = req.body || {};
    if (!character_id) return res.status(400).json({ error: 'character_id required' });

    const id = req.body.id || randomUUID();
    const now = Date.now();
    const metaJson = toJSON(chat_meta);
    const folderId = folderIdFromMeta(chat_meta);

    try {
        sharedDb.transaction(() => {
            const position = nextPosition(userId, character_id, folderId);
            stmtInsertChat.run(id, userId, character_id, title, metaJson, folderId, position, now, now);
            if (Array.isArray(messages) && messages.length > 0) {
                insertMsgsBatch(messages, id, -1, now);
            }
        })();
    } catch (e) {
        if (/UNIQUE/.test(e.message)) return res.status(409).json({ error: 'Chat id already exists' });
        throw e;
    }

    return res.status(201).json({ id, character_id, title, chat_meta: metaJson, folder_id: folderId, created_at: now, updated_at: now });
}

// PUT /api/chats/:id
function updateChat(req, res) {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const chat = stmtGetChat.get(req.params.id, userId);
    if (!chat) return res.status(404).json({ error: 'Not found' });

    const { title, chat_meta } = req.body || {};
    const newTitle = title !== undefined ? title : chat.title;
    const newMeta = chat_meta !== undefined ? toJSON(chat_meta) : chat.chat_meta;
    const newFolderId = chat_meta !== undefined ? folderIdFromMeta(chat_meta) : chat.folder_id;
    const now = Date.now();

    stmtUpdateChat.run(newTitle, newMeta, newFolderId, now, req.params.id, userId);
    return res.json({ ...chat, title: newTitle, chat_meta: newMeta, folder_id: newFolderId, updated_at: now });
}

// PUT /api/chats/:id/full — upsert chat + atomically replace all messages
// Used by the frontend save path; mirrors what POST /api/chat-content/ used to do.
function upsertChatFull(req, res) {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const chatId = req.params.id;
    const { character_id, title = '', chat_meta, messages = [] } = req.body || {};
    if (!character_id) return res.status(400).json({ error: 'character_id required' });

    const now = Date.now();
    const metaJson = toJSON(chat_meta);
    const folderId = folderIdFromMeta(chat_meta);

    sharedDb.transaction(() => {
        const existing = stmtGetChat.get(chatId, userId);
        if (existing) {
            stmtUpdateChat.run(title, metaJson, folderId, now, chatId, userId);
        } else {
            const position = nextPosition(userId, character_id, folderId);
            stmtInsertChat.run(chatId, userId, character_id, title, metaJson, folderId, position, now, now);
        }
        stmtDeleteChatMessages.run(chatId);
        if (messages.length > 0) {
            insertMsgsBatch(messages, chatId, -1, now);
        }
    })();

    return res.json({ ok: true, id: chatId, updated_at: now });
}

// PATCH /api/chats/:id/meta — lightweight metadata patch for folder moves /
// manual reorder / rename that don't warrant a full title+messages PUT.
// folder_id/position-only patches skip the updated_at bump (a drag-drop
// shouldn't bump a chat to the top of a recency-sorted view); a title change
// counts as a real edit and bumps it, matching updateChat's behavior.
function patchChatMeta(req, res) {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const chat = stmtGetChat.get(req.params.id, userId);
    if (!chat) return res.status(404).json({ error: 'Not found' });

    const body = req.body || {};
    const hasFolderId = Object.prototype.hasOwnProperty.call(body, 'folder_id');
    const hasPosition = Object.prototype.hasOwnProperty.call(body, 'position');
    const hasTitle = Object.prototype.hasOwnProperty.call(body, 'title');
    if (!hasFolderId && !hasPosition && !hasTitle) {
        return res.status(400).json({ error: 'No fields to update' });
    }

    const newFolderId = hasFolderId ? (body.folder_id == null ? null : String(body.folder_id)) : chat.folder_id;
    const newPosition = hasPosition ? Number(body.position) : chat.position;
    const newTitle = hasTitle ? String(body.title) : chat.title;

    if (hasTitle) {
        const now = Date.now();
        stmtPatchMetaTouch.run(newFolderId, newPosition, newTitle, now, req.params.id, userId);
        return res.json({ ...chat, folder_id: newFolderId, position: newPosition, title: newTitle, updated_at: now });
    }
    stmtPatchMeta.run(newFolderId, newPosition, newTitle, req.params.id, userId);
    return res.json({ ...chat, folder_id: newFolderId, position: newPosition, title: newTitle });
}

// PATCH /api/chats/reorder — bulk position/folder update for drag-and-drop.
// Body: [{ id, position, folder_id }, ...]. All-or-nothing: every id must
// already belong to the requesting user or the whole batch is rejected, so a
// forged id can't be used to probe/touch another account's chats and a
// partial failure never leaves the list half-reordered.
function reorderChats(req, res) {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const updates = req.body;
    if (!Array.isArray(updates) || updates.length === 0) {
        return res.status(400).json({ error: 'Expected a non-empty array' });
    }
    for (const u of updates) {
        if (!u || typeof u.id !== 'string' || typeof u.position !== 'number') {
            return res.status(400).json({ error: 'Each entry needs id (string) and position (number)' });
        }
    }

    const ids = [...new Set(updates.map(u => u.id))];
    const owned = new Set(
        ids.filter(id => stmtOwnsChat.get(id, userId))
    );
    if (owned.size !== ids.length) {
        return res.status(404).json({ error: 'One or more chats not found' });
    }

    sharedDb.transaction(() => {
        for (const u of updates) {
            const folderId = u.folder_id == null ? null : String(u.folder_id);
            stmtReorderOne.run(u.position, folderId, u.id, userId);
        }
    })();

    return res.json({ ok: true, updated: updates.length });
}

// DELETE /api/chats/:id
function deleteChat(req, res) {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    if (!stmtOwnsChat.get(req.params.id, userId)) return res.status(404).json({ error: 'Not found' });
    stmtDeleteChat.run(req.params.id, userId);
    return res.status(204).end();
}

// POST /api/chats/:id/messages
// Accepts a single message object OR an array for bulk insert.
function addMessage(req, res) {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    if (!stmtOwnsChat.get(req.params.id, userId)) return res.status(404).json({ error: 'Not found' });

    const isBulk = Array.isArray(req.body);
    const msgs = isBulk ? req.body : [req.body || {}];
    if (msgs.length === 0) return res.status(400).json({ error: 'No messages provided' });

    const chatId = req.params.id;
    const now = Date.now();
    const { max_order } = stmtMaxSortOrder.get(chatId);

    const inserted = sharedDb.transaction(() => {
        const result = insertMsgsBatch(msgs, chatId, max_order, now);
        stmtTouchChat.run(now, chatId);
        return result;
    })();

    return res.status(201).json(isBulk ? inserted : inserted[0]);
}

// PUT /api/chats/:id/messages/:msgId
function updateMessage(req, res) {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    if (!stmtOwnsChat.get(req.params.id, userId)) return res.status(404).json({ error: 'Not found' });

    const msg = stmtGetMessage.get(req.params.msgId, req.params.id);
    if (!msg) return res.status(404).json({ error: 'Message not found' });

    const { role, content } = req.body || {};
    const newRole = role !== undefined ? role : msg.role;
    const newContent = content !== undefined
        ? (typeof content === 'string' ? content : JSON.stringify(content))
        : msg.content;

    stmtUpdateMessage.run(newRole, newContent, req.params.msgId, req.params.id);
    stmtTouchChat.run(Date.now(), req.params.id);
    return res.json({ ...msg, role: newRole, content: newContent });
}

// DELETE /api/chats/:id/messages/:msgId
function deleteMessage(req, res) {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    if (!stmtOwnsChat.get(req.params.id, userId)) return res.status(404).json({ error: 'Not found' });
    if (!stmtGetMessage.get(req.params.msgId, req.params.id)) return res.status(404).json({ error: 'Message not found' });

    stmtDeleteMessage.run(req.params.msgId, req.params.id);
    stmtTouchChat.run(Date.now(), req.params.id);
    return res.status(204).end();
}

// ─── Mount ────────────────────────────────────────────────────────────────────
function mountChatApi(app) {
    app.get('/api/chats',                          listChats);
    app.get('/api/chats/:id',                      getChat);
    app.post('/api/chats',                         createChat);
    app.put('/api/chats/:id/full',                 upsertChatFull);
    app.put('/api/chats/:id',                      updateChat);
    app.patch('/api/chats/reorder',                reorderChats);
    app.patch('/api/chats/:id/meta',                patchChatMeta);
    app.delete('/api/chats/:id',                   deleteChat);
    app.post('/api/chats/:id/messages',            addMessage);
    app.put('/api/chats/:id/messages/:msgId',      updateMessage);
    app.delete('/api/chats/:id/messages/:msgId',   deleteMessage);
}

module.exports = { mountChatApi };
