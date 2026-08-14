'use strict';

const { randomUUID } = require('crypto');
const webpush = require('web-push');
const { sharedDb } = require('./authGate.cjs');
const { resolveUserId } = require('./chatApi.cjs');

// ─── Schema ───────────────────────────────────────────────────────────────────
// One row per subscribed browser/device (a user can have several). endpoint is
// globally unique per browser+site pairing, so it's the natural upsert key —
// re-subscribing the same device (e.g. key rotation) just updates in place.
sharedDb.exec(`
  CREATE TABLE IF NOT EXISTS rl_push_subscriptions (
    id          TEXT    PRIMARY KEY,
    user_id     INTEGER NOT NULL,
    endpoint    TEXT    NOT NULL UNIQUE,
    p256dh      TEXT    NOT NULL,
    auth        TEXT    NOT NULL,
    user_agent  TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  )
`);
sharedDb.exec(`CREATE INDEX IF NOT EXISTS idx_rl_push_sub_user ON rl_push_subscriptions(user_id)`);

// ─── Prepared statements ──────────────────────────────────────────────────────
const stmtUpsertByEndpoint = sharedDb.prepare(`
  INSERT INTO rl_push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(endpoint) DO UPDATE SET
    user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
    user_agent = excluded.user_agent, updated_at = excluded.updated_at
`);

const stmtDeleteByEndpoint = sharedDb.prepare(`DELETE FROM rl_push_subscriptions WHERE endpoint = ? AND user_id = ?`);
const stmtDeleteById = sharedDb.prepare(`DELETE FROM rl_push_subscriptions WHERE id = ?`);
const stmtListByUser = sharedDb.prepare(`SELECT id, endpoint, p256dh, auth FROM rl_push_subscriptions WHERE user_id = ?`);

// web-push's setVapidDetails() stores the keys in a module-private closure
// variable — it's never exposed back on the exported object, so we have to
// hold our own copy of the public key here for getVapidPublicKey() to read.
let cachedVapidPublicKey = null;
function configureVapid(publicKey, privateKey, contactEmail) {
    webpush.setVapidDetails(contactEmail, publicKey, privateKey);
    cachedVapidPublicKey = publicKey;
}

// ─── Send helper, used by server.cjs's durable-pump completion hook ───────────
// Fire-and-forget by design — callers never await this on any live request
// path (see runDurableProxyPump). Cleans up expired/revoked subscriptions
// (404/410 from the push service) the same way ackPendingGeneration cleans up
// consumed generations — self-healing, no separate reconciliation job needed.
async function sendPushToUser(userId, payload) {
    const rows = stmtListByUser.all(userId);
    const body = JSON.stringify(payload);
    for (const row of rows) {
        try {
            await webpush.sendNotification(
                { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
                body
            );
        } catch (err) {
            if (err && (err.statusCode === 404 || err.statusCode === 410)) {
                stmtDeleteById.run(row.id);
            } else {
                console.error(`[Push] sendNotification failed for subscription ${row.id}:`, err);
            }
        }
    }
}

// ─── Route handlers ───────────────────────────────────────────────────────────

// GET /api/push/vapid-public-key
function getVapidPublicKey(req, res) {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    return res.json({ publicKey: cachedVapidPublicKey });
}

// POST /api/push/subscribe — body: { endpoint, keys: { p256dh, auth }, userAgent? }
function subscribe(req, res) {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const { endpoint, keys, userAgent } = req.body || {};
    if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
        return res.status(400).json({ error: 'endpoint and keys.p256dh/keys.auth required' });
    }
    const now = Date.now();
    stmtUpsertByEndpoint.run(randomUUID(), userId, endpoint, keys.p256dh, keys.auth, userAgent ?? null, now, now);
    return res.status(204).end();
}

// DELETE /api/push/subscribe — body: { endpoint }. Idempotent: already-gone is not an error.
function unsubscribe(req, res) {
    const userId = resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const { endpoint } = req.body || {};
    if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
    stmtDeleteByEndpoint.run(endpoint, userId);
    return res.status(204).end();
}

// ─── Mount ────────────────────────────────────────────────────────────────────
function mountPushApi(app) {
    app.get('/api/push/vapid-public-key', getVapidPublicKey);
    app.post('/api/push/subscribe', subscribe);
    app.delete('/api/push/subscribe', unsubscribe);
}

module.exports = { mountPushApi, sendPushToUser, configureVapid };
