'use strict';

const { sharedDb } = require('./authGate.cjs');
const { resolveUserId } = require('./chatApi.cjs');

// ─── Schema ───────────────────────────────────────────────────────────────────
// Durable staging for in-flight AI streaming responses relayed through
// /proxy2 (see reverseProxyFunc's durable-pump branch in server.cjs). The
// server never parses raw_body — it's the exact upstream provider bytes,
// replayed client-side through the same SSE parser that would've handled
// them live (see risuDurableMeta.parserKind). Rows are ephemeral: acked
// (deleted) by the client on normal completion, or swept by TTL/stall GC.
sharedDb.exec(`
  CREATE TABLE IF NOT EXISTS rl_pending_generations (
    id              TEXT    PRIMARY KEY,
    user_id         INTEGER NOT NULL,
    room_chat_id    TEXT    NOT NULL,
    character_id    TEXT    NOT NULL,
    parser_kind     TEXT    NOT NULL,
    replay_meta     TEXT,
    status          TEXT    NOT NULL DEFAULT 'streaming',
    raw_body        BLOB    NOT NULL DEFAULT (X''),
    byte_length     INTEGER NOT NULL DEFAULT 0,
    truncated       INTEGER NOT NULL DEFAULT 0,
    upstream_status INTEGER,
    error_message   TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    completed_at    INTEGER
  )
`);
sharedDb.exec(`CREATE INDEX IF NOT EXISTS idx_rl_pending_gen_chat ON rl_pending_generations(user_id, room_chat_id, status)`);
sharedDb.exec(`CREATE INDEX IF NOT EXISTS idx_rl_pending_gen_gc   ON rl_pending_generations(status, updated_at)`);

// ─── Prepared statements ──────────────────────────────────────────────────────
// INSERT OR REPLACE: a single logical generation (one generationId) can span
// multiple HTTP legs when the ModelPreset tool loop makes follow-up calls —
// each leg's pump restarts the row from scratch rather than conflicting on
// the primary key. This means durable buffering only ever reflects the
// *latest* in-flight leg of a multi-round tool-use turn, not the full
// conversation of legs — an accepted MVP limitation (see plan §7).
const stmtInsert = sharedDb.prepare(`
  INSERT OR REPLACE INTO rl_pending_generations
    (id, user_id, room_chat_id, character_id, parser_kind, replay_meta, status, raw_body, byte_length, truncated, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, 'streaming', ?, 0, 0, ?, ?)
`);

const stmtFlushBody = sharedDb.prepare(`
  UPDATE rl_pending_generations
  SET raw_body = ?, byte_length = ?, truncated = ?, updated_at = ?
  WHERE id = ?
`);

const stmtFinish = sharedDb.prepare(`
  UPDATE rl_pending_generations
  SET status = ?, raw_body = ?, byte_length = ?, truncated = ?,
      upstream_status = ?, error_message = ?, updated_at = ?, completed_at = ?
  WHERE id = ?
`);

const stmtListByChat = sharedDb.prepare(`
  SELECT id, status, parser_kind, byte_length, truncated, upstream_status, error_message,
         created_at, updated_at, completed_at
  FROM rl_pending_generations
  WHERE user_id = ? AND room_chat_id = ?
  ORDER BY created_at ASC
`);

const stmtGetById = sharedDb.prepare(`
  SELECT id, room_chat_id, character_id, parser_kind, replay_meta, status, raw_body,
         byte_length, truncated, upstream_status, error_message, created_at, updated_at, completed_at
  FROM rl_pending_generations
  WHERE id = ? AND user_id = ?
`);

const stmtDeleteById = sharedDb.prepare(`DELETE FROM rl_pending_generations WHERE id = ? AND user_id = ?`);

const stmtMarkStalled = sharedDb.prepare(`
  UPDATE rl_pending_generations
  SET status = 'error', error_message = 'Stalled: no upstream activity before server-side timeout', updated_at = ?, completed_at = ?
  WHERE status = 'streaming' AND updated_at < ?
`);

const stmtDeleteExpired = sharedDb.prepare(`
  DELETE FROM rl_pending_generations WHERE status != 'streaming' AND updated_at < ?
`);

// Defensive per-user hoarding backstop — TTL should normally catch everything
// first, this just bounds worst-case table growth from a client that never acks.
const stmtCapPerUser = sharedDb.prepare(`
  DELETE FROM rl_pending_generations
  WHERE user_id = ? AND status != 'streaming' AND id NOT IN (
    SELECT id FROM rl_pending_generations WHERE user_id = ? AND status != 'streaming'
    ORDER BY updated_at DESC LIMIT ?
  )
`);
const stmtDistinctUsersWithTerminalRows = sharedDb.prepare(`
  SELECT DISTINCT user_id FROM rl_pending_generations WHERE status != 'streaming'
`);

// ─── Internal helpers used by server.cjs's durable proxy pump ────────────────

function createPendingGeneration({ id, userId, roomChatId, characterId, parserKind, replayMeta, initialBody }) {
    const now = Date.now();
    stmtInsert.run(
        id, userId, roomChatId, characterId, parserKind,
        replayMeta !== undefined ? JSON.stringify(replayMeta) : null,
        initialBody ?? Buffer.alloc(0),
        now, now
    );
}

function flushPendingGenerationBody(id, rawBody, truncated) {
    stmtFlushBody.run(rawBody, rawBody.length, truncated ? 1 : 0, Date.now(), id);
}

function finishPendingGeneration({ id, status, rawBody, truncated, upstreamStatus, errorMessage }) {
    const now = Date.now();
    stmtFinish.run(
        status, rawBody, rawBody.length, truncated ? 1 : 0,
        upstreamStatus ?? null, errorMessage ?? null, now, now, id
    );
}

// Periodic GC — mirrors the proxyStreamJobs sweep cadence/shape in server.cjs.
function sweepPendingGenerations({ stallMs, ttlMs, perUserCap }) {
    const now = Date.now();
    stmtMarkStalled.run(now, now, now - stallMs);
    stmtDeleteExpired.run(now - ttlMs);
    if (perUserCap) {
        for (const row of stmtDistinctUsersWithTerminalRows.all()) {
            stmtCapPerUser.run(row.user_id, row.user_id, perUserCap);
        }
    }
}

// ─── Route handlers ───────────────────────────────────────────────────────────

// GET /api/pending-generations?roomChatId=xxx
function listPendingGenerations(req, res) {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const roomChatId = req.query.roomChatId;
    if (!roomChatId) return res.status(400).json({ error: 'roomChatId required' });
    const rows = stmtListByChat.all(userId, roomChatId).map((row) => ({
        id: row.id,
        status: row.status,
        parserKind: row.parser_kind,
        byteLength: row.byte_length,
        truncated: !!row.truncated,
        upstreamStatus: row.upstream_status,
        errorMessage: row.error_message,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        completedAt: row.completed_at,
    }));
    return res.json(rows);
}

// GET /api/pending-generations/:id
function getPendingGeneration(req, res) {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const row = stmtGetById.get(req.params.id, userId);
    if (!row) return res.status(404).json({ error: 'Not found' });
    let replayMeta = null;
    if (row.replay_meta) {
        try { replayMeta = JSON.parse(row.replay_meta); } catch { /* ignore malformed */ }
    }
    return res.json({
        id: row.id,
        roomChatId: row.room_chat_id,
        characterId: row.character_id,
        parserKind: row.parser_kind,
        replayMeta,
        status: row.status,
        rawBodyBase64: Buffer.from(row.raw_body ?? Buffer.alloc(0)).toString('base64'),
        byteLength: row.byte_length,
        truncated: !!row.truncated,
        upstreamStatus: row.upstream_status,
        errorMessage: row.error_message,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        completedAt: row.completed_at,
    });
}

// DELETE /api/pending-generations/:id — ack/consume. Idempotent: acking a
// row that's already gone (double-ack race between tabs, or already swept
// by GC) is not an error.
function ackPendingGeneration(req, res) {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    stmtDeleteById.run(req.params.id, userId);
    return res.status(204).end();
}

// ─── Mount ────────────────────────────────────────────────────────────────────
function mountPendingGenApi(app) {
    app.get('/api/pending-generations', listPendingGenerations);
    app.get('/api/pending-generations/:id', getPendingGeneration);
    app.delete('/api/pending-generations/:id', ackPendingGeneration);
}

module.exports = {
    mountPendingGenApi,
    createPendingGeneration,
    flushPendingGenerationBody,
    finishPendingGeneration,
    sweepPendingGenerations,
};
