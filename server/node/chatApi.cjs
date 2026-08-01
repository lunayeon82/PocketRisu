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
  SELECT c.id, c.character_id, c.title, c.chat_meta, c.created_at, c.updated_at,
         (SELECT COUNT(*) FROM rl_messages m WHERE m.chat_id = c.id) AS message_count
  FROM rl_chats c
  WHERE c.user_id = ?
  ORDER BY c.updated_at DESC
`);

const stmtGetChat = sharedDb.prepare(`
  SELECT id, character_id, title, chat_meta, created_at, updated_at
  FROM rl_chats WHERE id = ? AND user_id = ?
`);

const stmtOwnsChat = sharedDb.prepare(`SELECT 1 FROM rl_chats WHERE id = ? AND user_id = ?`);

const stmtInsertChat = sharedDb.prepare(`
  INSERT INTO rl_chats (id, user_id, character_id, title, chat_meta, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const stmtUpdateChat = sharedDb.prepare(`
  UPDATE rl_chats SET title = ?, chat_meta = ?, updated_at = ?
  WHERE id = ? AND user_id = ?
`);

const stmtDeleteChat = sharedDb.prepare(`DELETE FROM rl_chats WHERE id = ? AND user_id = ?`);

const stmtTouchChat = sharedDb.prepare(`UPDATE rl_chats SET updated_at = ? WHERE id = ?`);

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

// ─── Route handlers ───────────────────────────────────────────────────────────

// GET /api/chats
function listChats(req, res) {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    return res.json(stmtListChats.all(userId));
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

    try {
        sharedDb.transaction(() => {
            stmtInsertChat.run(id, userId, character_id, title, metaJson, now, now);
            if (Array.isArray(messages) && messages.length > 0) {
                insertMsgsBatch(messages, id, -1, now);
            }
        })();
    } catch (e) {
        if (/UNIQUE/.test(e.message)) return res.status(409).json({ error: 'Chat id already exists' });
        throw e;
    }

    return res.status(201).json({ id, character_id, title, chat_meta: metaJson, created_at: now, updated_at: now });
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
    const now = Date.now();

    stmtUpdateChat.run(newTitle, newMeta, now, req.params.id, userId);
    return res.json({ ...chat, title: newTitle, chat_meta: newMeta, updated_at: now });
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
    app.put('/api/chats/:id',                      updateChat);
    app.delete('/api/chats/:id',                   deleteChat);
    app.post('/api/chats/:id/messages',            addMessage);
    app.put('/api/chats/:id/messages/:msgId',      updateMessage);
    app.delete('/api/chats/:id/messages/:msgId',   deleteMessage);
}

module.exports = { mountChatApi };
