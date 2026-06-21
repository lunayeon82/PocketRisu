'use strict';
// Google Drive backup integration — OAuth2 without googleapis dependency.
// Feature requires env vars: GDRIVE_CLIENT_ID, GDRIVE_CLIENT_SECRET
// Optional: GDRIVE_REDIRECT_URI (auto-detected from request if absent)
//           GDRIVE_FOLDER_ID (creates 'PocketRisu Backups' folder if absent)

const { kvGet, kvSet, kvDel, kvGetUpdatedAt } = require('./db.cjs');

const TOKENS_KEY = 'config/gdrive-tokens';
const FOLDER_ID_KEY = 'config/gdrive-folder-id';
const LAST_BACKUP_KEY = 'config/gdrive-last-backup';

function isConfigured() {
    return !!(process.env.GDRIVE_CLIENT_ID && process.env.GDRIVE_CLIENT_SECRET);
}

function getRedirectUri(req) {
    if (process.env.GDRIVE_REDIRECT_URI) return process.env.GDRIVE_REDIRECT_URI;
    const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || (req.secure ? 'https' : 'http');
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return `${proto}://${host}/api/gdrive/callback`;
}

function buildAuthUrl(redirectUri) {
    const params = new URLSearchParams({
        client_id: process.env.GDRIVE_CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'https://www.googleapis.com/auth/drive',
        access_type: 'offline',
        prompt: 'consent',
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function exchangeCode(code, redirectUri) {
    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            code,
            client_id: process.env.GDRIVE_CLIENT_ID,
            client_secret: process.env.GDRIVE_CLIENT_SECRET,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code',
        }).toString(),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Token exchange failed (${res.status}): ${text}`);
    }
    return res.json();
}

function loadTokens() {
    const raw = kvGet(TOKENS_KEY);
    if (!raw) return null;
    try { return JSON.parse(raw.toString('utf-8')); } catch { return null; }
}

function saveTokens(tokens) {
    kvSet(TOKENS_KEY, Buffer.from(JSON.stringify(tokens)));
}

function deleteTokens() {
    kvDel(TOKENS_KEY);
    kvDel(FOLDER_ID_KEY);
}

async function getValidAccessToken() {
    let tokens = loadTokens();
    if (!tokens?.refresh_token) throw new Error('Google Drive not connected');
    if (tokens.expiry_date && Date.now() < tokens.expiry_date - 60_000) {
        return tokens.access_token;
    }
    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: process.env.GDRIVE_CLIENT_ID,
            client_secret: process.env.GDRIVE_CLIENT_SECRET,
            refresh_token: tokens.refresh_token,
            grant_type: 'refresh_token',
        }).toString(),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Token refresh failed (${res.status}): ${text}`);
    }
    const fresh = await res.json();
    tokens = { ...tokens, access_token: fresh.access_token, expiry_date: Date.now() + fresh.expires_in * 1000 };
    saveTokens(tokens);
    return tokens.access_token;
}

async function getOrCreateFolder(accessToken) {
    if (process.env.GDRIVE_FOLDER_ID) return process.env.GDRIVE_FOLDER_ID;

    // Verify cached ID is still valid
    const cachedId = (() => {
        const raw = kvGet(FOLDER_ID_KEY);
        return raw ? raw.toString('utf-8') : null;
    })();
    if (cachedId) {
        const check = await fetch(
            `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(cachedId)}?fields=id,trashed`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        if (check.ok) {
            const data = await check.json();
            if (!data.trashed) return cachedId;
        }
        // Cached ID is gone or trashed — fall through to search
    }

    // Search for an existing "PocketRisu Backups" folder before creating a new one.
    // This handles the case where the user manually created the folder or added files to it.
    const searchQ = encodeURIComponent(`mimeType = 'application/vnd.google-apps.folder' and name = 'PocketRisu Backups' and trashed = false`);
    const searchRes = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=${searchQ}&fields=files(id)&spaces=drive&pageSize=1`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (searchRes.ok) {
        const searchData = await searchRes.json();
        if (searchData.files?.length > 0) {
            const existingId = searchData.files[0].id;
            kvSet(FOLDER_ID_KEY, Buffer.from(existingId));
            return existingId;
        }
    }

    // No existing folder — create one
    const res = await fetch('https://www.googleapis.com/drive/v3/files', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'PocketRisu Backups', mimeType: 'application/vnd.google-apps.folder' }),
    });
    if (!res.ok) throw new Error(`Folder creation failed (${res.status})`);
    const folder = await res.json();
    kvSet(FOLDER_ID_KEY, Buffer.from(folder.id));
    return folder.id;
}

async function uploadToDrive(accessToken, folderId, fileName, data) {
    const buf = data instanceof Buffer ? data : Buffer.from(data);
    const metadata = JSON.stringify({ name: fileName, parents: [folderId] });
    const boundary = `pocketrisu_${Date.now()}`;
    const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`),
        Buffer.from(metadata),
        Buffer.from(`\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`),
        buf,
        Buffer.from(`\r\n--${boundary}--`),
    ]);
    const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body,
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Upload failed (${res.status}): ${text}`);
    }
    return res.json();
}

const BACKUP_KEEP_COUNT = 10;

const AUTO_BACKUP_PATTERN = /^pocketrisu-backup-(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})\.bin$/;

// Resolve sort timestamp: name-embedded time for matching files, createdTime fallback.
function fileSortTs(file) {
    const m = file.name.match(AUTO_BACKUP_PATTERN);
    if (m) {
        const [date, time] = m[1].split('_');
        const ts = Date.parse(`${date}T${time.replace(/-/g, ':')}Z`);
        if (!isNaN(ts)) return ts;
    }
    return new Date(file.createdTime).getTime();
}

// All files in folder, sorted newest→oldest. Throws on API error.
async function listBackupFiles(accessToken, folderId) {
    const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
    const res = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,createdTime)&pageSize=100&spaces=drive`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Drive list failed (${res.status}): ${text}`);
    }
    const json = await res.json();
    const files = json.files ?? [];
    // Sort newest→oldest using name-embedded timestamp, falling back to createdTime
    return files.sort((a, b) => fileSortTs(b) - fileSortTs(a));
}

async function deleteFile(accessToken, fileId) {
    await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
    });
}

async function downloadFile(accessToken, fileId) {
    const res = await fetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!res.ok) {
        let msg = `Drive download failed (${res.status})`;
        try {
            const ct = res.headers.get('content-type') || '';
            if (ct.includes('application/json')) {
                const body = await res.json();
                const reason = body?.error?.errors?.[0]?.reason;
                const detail = body?.error?.message;
                if (detail) msg = detail;
                if (reason) msg += ` [${reason}]`;
            }
        } catch { /* ignore */ }
        if (res.status === 403 || res.status === 404) {
            msg += ' — 설정 > 백업 > Google Drive에서 연결 해제 후 재연결하면 해결됩니다 (drive 권한 필요)';
        }
        throw new Error(msg);
    }
    const arrayBuf = await res.arrayBuffer();
    return Buffer.from(arrayBuf);
}

// getDbBytes: async function that returns a Buffer of the raw database blob.
async function performBackup(getDbBytes) {
    if (!isConfigured()) throw new Error('Google Drive not configured (GDRIVE_CLIENT_ID / GDRIVE_CLIENT_SECRET missing)');
    const accessToken = await getValidAccessToken();
    const folderId = await getOrCreateFolder(accessToken);
    const data = await getDbBytes();
    if (!data || !data.length) throw new Error('Empty database — nothing to back up');
    const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    const fileName = `pocketrisu-backup-${ts}.bin`;
    const result = await uploadToDrive(accessToken, folderId, fileName, data);
    kvSet(LAST_BACKUP_KEY, Buffer.from(JSON.stringify({ ts: Date.now(), fileId: result.id, fileName })));

    // Rotate: keep newest BACKUP_KEEP_COUNT files (manual + auto combined).
    // Sort by name-embedded timestamp first; fall back to createdTime for non-matching names.
    try {
        const allFiles = await listBackupFiles(accessToken, folderId);
        // allFiles is newest→oldest; delete from the tail (oldest)
        const toDelete = allFiles.slice(BACKUP_KEEP_COUNT);
        await Promise.all(toDelete.map(f => deleteFile(accessToken, f.id)));
    } catch { /* rotation failure is non-fatal */ }

    return { fileId: result.id, fileName };
}

async function hasFullDriveScope(accessToken) {
    try {
        const res = await fetch(
            `https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=${encodeURIComponent(accessToken)}`,
        );
        if (!res.ok) return false;
        const info = await res.json();
        // Scopes are space-separated. drive.file is a subset — only full 'drive' allows all files.
        const scopes = (info?.scope || '').split(' ');
        return scopes.includes('https://www.googleapis.com/auth/drive');
    } catch { return false; }
}

async function getStatus() {
    const tokens = loadTokens();
    const lastRaw = kvGet(LAST_BACKUP_KEY);
    let lastBackup = null;
    if (lastRaw) { try { lastBackup = JSON.parse(lastRaw.toString('utf-8')); } catch { /* ignore */ } }
    const connected = !!(tokens?.refresh_token);
    let hasFullScope = null;
    if (connected) {
        try {
            const accessToken = await getValidAccessToken();
            hasFullScope = await hasFullDriveScope(accessToken);
        } catch { hasFullScope = null; }
    }
    return {
        configured: isConfigured(),
        connected,
        lastBackup,
        hasFullScope,
    };
}

// True if the DB was modified after the last Drive backup (or if no backup exists yet).
function isDbNewerThanLastBackup() {
    const lastRaw = kvGet(LAST_BACKUP_KEY);
    if (!lastRaw) return true;
    let lastBackupTs;
    try { lastBackupTs = JSON.parse(lastRaw.toString('utf-8')).ts; } catch { return true; }
    const dbUpdated = kvGetUpdatedAt('database/database.bin');
    if (!dbUpdated) return false;
    return dbUpdated > lastBackupTs;
}

module.exports = {
    isConfigured,
    getRedirectUri,
    buildAuthUrl,
    exchangeCode,
    saveTokens,
    deleteTokens,
    performBackup,
    getStatus,
    isDbNewerThanLastBackup,
    loadTokens,
    listBackupFiles,
    downloadFile,
    getValidAccessToken,
    getOrCreateFolder,
};
