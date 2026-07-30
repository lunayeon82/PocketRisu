'use strict';

// ── Login gate (rl_users) ───────────────────────────────────────────────────
// Wraps every route (including static assets) behind a real username/password
// account, stored in a SQLite DB shared with other apps on the same box
// (table prefix rl_). This sits in front of — and is independent from —
// RisuAI's own single-password/JWT system (checkAuth/risu-auth/risu-session),
// which stays as-is and keeps gating individual data API calls.

const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const BCRYPT_ROUNDS = 12;
const SESSION_COOKIE = 'rl_auth';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Exact paths reachable without a session. Everything else is gated.
const OPEN_PATHS = new Set(['/login', '/api/auth/login', '/api/auth/logout']);

const savePath = path.join(process.cwd(), 'save');
if (!fs.existsSync(savePath)) {
    fs.mkdirSync(savePath, { recursive: true });
}

// Shared DB path is deploy-specific (co-located with another app's data on
// Lightsail); default to a local file so dev/test environments work out of
// the box without that other app's directory existing.
const sharedDbPath = process.env.RL_SHARED_DB_PATH || path.join(savePath, 'shared-dev.db');
const sharedDbDir = path.dirname(sharedDbPath);
if (!fs.existsSync(sharedDbDir)) {
    fs.mkdirSync(sharedDbDir, { recursive: true });
}
const sharedDb = new Database(sharedDbPath);
sharedDb.pragma('journal_mode = WAL');
sharedDb.pragma('busy_timeout = 5000');

sharedDb.exec(`
  CREATE TABLE IF NOT EXISTS rl_users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  )
`);

const stmtCountUsers = sharedDb.prepare(`SELECT COUNT(*) as n FROM rl_users`);
const stmtGetUser = sharedDb.prepare(`SELECT * FROM rl_users WHERE username = ?`);
const stmtInsertUser = sharedDb.prepare(`INSERT INTO rl_users (username, password_hash, created_at) VALUES (?, ?, ?)`);

// Creates the first account from ADMIN_USER/ADMIN_PASS if rl_users is still
// empty. No-op once any account exists — safe to leave the env vars set.
async function bootstrapAdmin() {
    const { n } = stmtCountUsers.get();
    if (n > 0) return;

    const adminUser = process.env.ADMIN_USER;
    const adminPass = process.env.ADMIN_PASS;
    if (!adminUser || !adminPass) {
        console.log('[AuthGate] rl_users is empty and ADMIN_USER/ADMIN_PASS are not set — no one will be able to log in until an account exists.');
        return;
    }

    const hash = await bcrypt.hash(adminPass, BCRYPT_ROUNDS);
    stmtInsertUser.run(adminUser, hash, Date.now());
    console.log(`[AuthGate] Created initial account '${adminUser}'.`);
}

async function verifyCredentials(username, password) {
    if (!username || !password) return false;
    const row = stmtGetUser.get(username);
    if (!row) return false;
    return bcrypt.compare(password, row.password_hash);
}

// ── Session store ────────────────────────────────────────────────────────
// Server-memory + cookie, persisted to disk so restarts don't log everyone
// out. Fine at 3-user scale; mirrors the pattern server.cjs already uses for
// its own risu-session cookie, but kept fully separate (different cookie
// name, different file, different Map).
const SESSION_FILE = path.join(savePath, '__rl_sessions');
const sessions = new Map(); // token -> { username, expiresAt }

function loadSessions() {
    try {
        const raw = fs.readFileSync(SESSION_FILE, 'utf-8');
        const now = Date.now();
        for (const [token, data] of JSON.parse(raw)) {
            if (data.expiresAt > now) sessions.set(token, data);
        }
    } catch { /* file missing or corrupt — start fresh */ }
}

function saveSessions() {
    try { fs.writeFileSync(SESSION_FILE, JSON.stringify([...sessions])); }
    catch { /* non-critical */ }
}

loadSessions();

function parseCookie(req, name) {
    const header = req.headers.cookie || '';
    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq === -1) continue;
        if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
    }
    return null;
}

function createSession(username) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + SESSION_TTL_MS;
    sessions.set(token, { username, expiresAt });
    for (const [t, data] of sessions) {
        if (data.expiresAt < Date.now()) sessions.delete(t);
    }
    saveSessions();
    return { token, expiresAt };
}

function destroySession(token) {
    sessions.delete(token);
    saveSessions();
}

function getSession(req) {
    const token = parseCookie(req, SESSION_COOKIE);
    if (!token) return null;
    const data = sessions.get(token);
    if (!data || data.expiresAt < Date.now()) return null;
    return { token, ...data };
}

function setSessionCookie(req, res, token, expiresAt) {
    const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
    const secure = req.secure ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}; Path=/${secure}`);
}

function clearSessionCookie(res) {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/`);
}

// ── Middleware ───────────────────────────────────────────────────────────
function requireLogin(req, res, next) {
    if (OPEN_PATHS.has(req.path)) return next();

    if (getSession(req)) return next();

    const acceptsHtml = (req.headers.accept || '').includes('text/html');
    if (acceptsHtml) {
        res.redirect(302, '/login');
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
}

// ── Login page ───────────────────────────────────────────────────────────
// Fully standalone (inline CSS, no external JS) so it never needs an
// exemption for /assets — a plain <form> POST is enough to log in.
function loginPageHtml(showError) {
    const errorHtml = showError ? '<p class="error">Invalid username or password.</p>' : '';
    return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Login — PocketRisu</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #111; color: #eee; }
  form { display: flex; flex-direction: column; gap: 0.75rem; width: 20rem; padding: 2rem; border-radius: 0.5rem; background: #1c1c1c; box-shadow: 0 4px 24px rgba(0,0,0,0.4); }
  h1 { font-size: 1.1rem; margin: 0 0 0.5rem; }
  input { padding: 0.5rem; border-radius: 0.25rem; border: 1px solid #444; background: #0d0d0d; color: #eee; font-size: 1rem; }
  button { padding: 0.5rem; border-radius: 0.25rem; border: none; background: #4a5eff; color: #fff; cursor: pointer; font-size: 1rem; }
  .error { color: #ff6b6b; margin: 0; font-size: 0.9rem; }
</style>
</head>
<body>
<form method="post" action="/api/auth/login">
  <h1>PocketRisu Login</h1>
  ${errorHtml}
  <input type="text" name="username" placeholder="Username" autocomplete="username" required autofocus>
  <input type="password" name="password" placeholder="Password" autocomplete="current-password" required>
  <button type="submit">Log in</button>
</form>
</body>
</html>`;
}

module.exports = {
    bootstrapAdmin,
    verifyCredentials,
    createSession,
    destroySession,
    getSession,
    setSessionCookie,
    clearSessionCookie,
    requireLogin,
    loginPageHtml,
};
