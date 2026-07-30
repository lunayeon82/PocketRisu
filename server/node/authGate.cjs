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

// Added after the initial rl_users rollout — guard with table_info so
// existing deploys upgrade in place instead of erroring on re-run.
const rlUsersColumns = sharedDb.prepare(`PRAGMA table_info(rl_users)`).all();
if (!rlUsersColumns.some((c) => c.name === 'is_admin')) {
    sharedDb.exec(`ALTER TABLE rl_users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0`);
}

const stmtCountUsers = sharedDb.prepare(`SELECT COUNT(*) as n FROM rl_users`);
const stmtCountAdmins = sharedDb.prepare(`SELECT COUNT(*) as n FROM rl_users WHERE is_admin = 1`);
const stmtGetUser = sharedDb.prepare(`SELECT * FROM rl_users WHERE username = ?`);
const stmtGetUserById = sharedDb.prepare(`SELECT * FROM rl_users WHERE id = ?`);
const stmtListUsers = sharedDb.prepare(`SELECT id, username, is_admin, created_at FROM rl_users ORDER BY id`);
const stmtInsertUser = sharedDb.prepare(`INSERT INTO rl_users (username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?)`);
const stmtDeleteUser = sharedDb.prepare(`DELETE FROM rl_users WHERE id = ?`);
const stmtUpdatePasswordHash = sharedDb.prepare(`UPDATE rl_users SET password_hash = ? WHERE id = ?`);

// Upgrade backfill: accounts created before is_admin existed (including via
// the original single-account bootstrap) default to 0, and bootstrapAdmin()
// below only fires on a still-empty table, so pre-existing deploys would
// otherwise end up with zero admins and no way to reach the management API.
// Promote ADMIN_USER's account if present; otherwise, if there's exactly one
// pre-existing account, promote it (it was the sole login before this
// feature existed, so it's unambiguous).
if (stmtCountAdmins.get().n === 0) {
    const adminUser = process.env.ADMIN_USER;
    const target = (adminUser && stmtGetUser.get(adminUser))
        || (stmtCountUsers.get().n === 1 ? sharedDb.prepare(`SELECT * FROM rl_users LIMIT 1`).get() : null);
    if (target) {
        sharedDb.prepare(`UPDATE rl_users SET is_admin = 1 WHERE id = ?`).run(target.id);
        console.log(`[AuthGate] Promoted existing account '${target.username}' to admin (upgrade backfill).`);
    } else if (stmtCountUsers.get().n > 0) {
        console.log('[AuthGate] No admin account exists and multiple accounts are present — set is_admin manually in rl_users, or via ADMIN_USER matching an existing username.');
    }
}

// Creates the first account from ADMIN_USER/ADMIN_PASS if rl_users is still
// empty. No-op once any account exists — safe to leave the env vars set.
// This is the only way an admin account gets created — the management API
// only ever creates non-admin accounts.
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
    stmtInsertUser.run(adminUser, hash, 1, Date.now());
    console.log(`[AuthGate] Created initial admin account '${adminUser}'.`);
}

async function verifyCredentials(username, password) {
    if (!username || !password) return false;
    const row = stmtGetUser.get(username);
    if (!row) return false;
    return bcrypt.compare(password, row.password_hash);
}

function isAdmin(username) {
    const row = stmtGetUser.get(username);
    return !!row && !!row.is_admin;
}

function listUsers() {
    return stmtListUsers.all();
}

function getUserById(id) {
    return stmtGetUserById.get(id);
}

function countAdmins() {
    return stmtCountAdmins.get().n;
}

// Always creates a non-admin account — admin status is only ever granted via
// bootstrapAdmin(). Throws (SQLITE_CONSTRAINT) if the username is taken.
async function createUser(username, password) {
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    stmtInsertUser.run(username, hash, 0, Date.now());
}

function deleteUserById(id) {
    stmtDeleteUser.run(id);
}

async function updateUserPassword(id, newPassword) {
    const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    stmtUpdatePasswordHash.run(hash, id);
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

// Logs a user out of every active session — used after their account is
// deleted or their password is changed, so a stale cookie can't linger.
function destroySessionsForUsername(username) {
    for (const [token, data] of sessions) {
        if (data.username === username) sessions.delete(token);
    }
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

// Runs after requireLogin — assumes a valid session already exists.
function requireAdmin(req, res, next) {
    const session = getSession(req);
    if (session && isAdmin(session.username)) return next();

    const acceptsHtml = (req.headers.accept || '').includes('text/html');
    if (acceptsHtml) {
        res.redirect(302, '/');
    } else {
        res.status(403).json({ error: 'Forbidden' });
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

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

// ── Admin page ───────────────────────────────────────────────────────────
// Same standalone-inline-page approach as loginPageHtml, plus a small inline
// <script> driving fetch() calls to the /api/auth/users endpoints.
function adminPageHtml(users, currentUsername) {
    const rows = users.map((u) => {
        const isSelf = u.username === currentUsername;
        const isLastAdmin = !!u.is_admin && users.filter((x) => x.is_admin).length <= 1;
        const deleteDisabled = isSelf || isLastAdmin ? 'disabled' : '';
        const deleteTitle = isSelf ? 'title="본인 계정은 삭제할 수 없습니다"' : (isLastAdmin ? 'title="마지막 관리자는 삭제할 수 없습니다"' : '');
        return `<tr>
  <td>${escapeHtml(u.username)}${isSelf ? ' <span class="you">(나)</span>' : ''}</td>
  <td>${u.is_admin ? '관리자' : '일반'}</td>
  <td>${new Date(u.created_at).toLocaleDateString('ko-KR')}</td>
  <td>
    <form class="inline" data-action="password" data-id="${u.id}">
      <input type="password" name="password" placeholder="새 비밀번호" autocomplete="new-password" required minlength="1">
      <button type="submit">변경</button>
    </form>
  </td>
  <td>
    <form class="inline" data-action="delete" data-id="${u.id}">
      <button type="submit" class="danger" ${deleteDisabled} ${deleteTitle}>삭제</button>
    </form>
  </td>
</tr>`;
    }).join('\n');

    return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Admin — PocketRisu</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; margin: 0; padding: 2rem; background: #111; color: #eee; }
  h1 { font-size: 1.3rem; margin: 0 0 1.5rem; }
  a { color: #8fa2ff; }
  table { width: 100%; max-width: 48rem; border-collapse: collapse; margin-bottom: 2rem; }
  th, td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid #333; font-size: 0.9rem; vertical-align: middle; }
  th { color: #999; font-weight: 500; }
  .you { color: #999; font-size: 0.8rem; }
  form.inline { display: flex; gap: 0.4rem; margin: 0; }
  input { padding: 0.4rem 0.5rem; border-radius: 0.25rem; border: 1px solid #444; background: #0d0d0d; color: #eee; font-size: 0.9rem; width: 9rem; }
  button { padding: 0.4rem 0.75rem; border-radius: 0.25rem; border: none; background: #4a5eff; color: #fff; cursor: pointer; font-size: 0.9rem; }
  button.danger { background: #a83a3a; }
  button:disabled { background: #333; color: #777; cursor: not-allowed; }
  .add-form { display: flex; gap: 0.5rem; align-items: flex-end; max-width: 30rem; margin-bottom: 1rem; }
  .add-form label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.8rem; color: #999; }
  .msg { min-height: 1.2rem; font-size: 0.85rem; margin-bottom: 1rem; }
  .msg.error { color: #ff6b6b; }
  .msg.ok { color: #6bcb77; }
</style>
</head>
<body>
<h1>계정 관리 <a href="/">← 앱으로</a></h1>

<table>
  <thead><tr><th>사용자</th><th>권한</th><th>생성일</th><th>비밀번호 변경</th><th></th></tr></thead>
  <tbody id="user-rows">
${rows}
  </tbody>
</table>

<form class="add-form" id="add-form">
  <label>사용자명 <input type="text" name="username" autocomplete="off" required></label>
  <label>비밀번호 <input type="password" name="password" autocomplete="new-password" required minlength="1"></label>
  <button type="submit">계정 추가</button>
</form>
<div class="msg" id="msg"></div>

<script>
const msgEl = document.getElementById('msg');
function showMsg(text, isError) {
  msgEl.textContent = text;
  msgEl.className = 'msg ' + (isError ? 'error' : 'ok');
}
async function callApi(url, options) {
  const res = await fetch(url, options);
  let body = {};
  try { body = await res.json(); } catch {}
  if (!res.ok) throw new Error(body.error || ('요청 실패 (' + res.status + ')'));
  return body;
}
document.getElementById('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    await callApi('/api/auth/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: fd.get('username'), password: fd.get('password') }),
    });
    location.reload();
  } catch (err) { showMsg(err.message, true); }
});
document.getElementById('user-rows').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const id = form.dataset.id;
  const action = form.dataset.action;
  try {
    if (action === 'delete') {
      await callApi('/api/auth/users/' + id, { method: 'DELETE' });
    } else if (action === 'password') {
      const fd = new FormData(form);
      await callApi('/api/auth/users/' + id + '/password', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: fd.get('password') }),
      });
    }
    location.reload();
  } catch (err) { showMsg(err.message, true); }
});
</script>
</body>
</html>`;
}

module.exports = {
    bootstrapAdmin,
    verifyCredentials,
    createSession,
    destroySession,
    destroySessionsForUsername,
    getSession,
    setSessionCookie,
    clearSessionCookie,
    requireLogin,
    requireAdmin,
    loginPageHtml,
    adminPageHtml,
    isAdmin,
    listUsers,
    getUserById,
    countAdmins,
    createUser,
    deleteUserById,
    updateUserPassword,
};
