'use strict';

const { app, BrowserWindow, ipcMain, dialog, protocol, globalShortcut, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const chokidar = require('chokidar');
const { v4: uuidv4 } = require('uuid');
const { autoUpdater } = require('electron-updater');
const Database = require('better-sqlite3');

const execFileAsync = promisify(execFile);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.mkv', '.flv', '.avi', '.webm']);
const VIDEO_MIME = { '.mp4':'video/mp4', '.mov':'video/quicktime', '.mkv':'video/x-matroska', '.webm':'video/webm', '.avi':'video/x-msvideo', '.flv':'video/x-flv' };
const LINK_PORT  = 7842;

// Must be called before app is ready
protocol.registerSchemesAsPrivileged([
  { scheme: 'safe-file', privileges: { secure: true, standard: true, stream: true, supportFetchAPI: true } },
]);

let mainWindow;
let db;
let watcher;
let linkServer;
let obsWs = null;

// ─── Database ────────────────────────────────────────────────────────────────

function initDb() {
  const dbPath = path.join(app.getPath('userData'), 'clips.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS clips (
      id TEXT PRIMARY KEY, filename TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
      added_at TEXT NOT NULL, duration REAL,
      size_bytes INTEGER, thumbnail TEXT
    );
    CREATE TABLE IF NOT EXISTS tags (
      id TEXT PRIMARY KEY, clip_id TEXT NOT NULL, tag TEXT NOT NULL,
      FOREIGN KEY (clip_id) REFERENCES clips(id) ON DELETE CASCADE,
      UNIQUE(clip_id, tag)
    );
    CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_clips_created ON clips(created_at DESC);
  `);
}

function getConfig(key) {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setConfig(key, value) {
  db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, value);
}

// ─── File Watcher ────────────────────────────────────────────────────────────

function startWatcher(folder) {
  if (watcher) { watcher.close(); watcher = null; }
  scanFolder(folder);
  watcher = chokidar.watch(folder, {
    ignored: /(^|[/\\])\../,
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 500 },
  });
  watcher.on('add', filePath => { if (isVideo(filePath)) processClip(filePath); });
}

function scanFolder(folder) {
  try {
    for (const entry of fs.readdirSync(folder)) {
      const full = path.join(folder, entry);
      if (fs.statSync(full).isFile() && isVideo(full)) {
        if (!db.prepare('SELECT 1 FROM clips WHERE path = ?').get(full)) {
          processClip(full);
        }
      }
    }
  } catch (e) { console.error('Scan error:', e); }
}

function isVideo(p) { return VIDEO_EXTS.has(path.extname(p).toLowerCase()); }

async function processClip(filePath) {
  if (db.prepare('SELECT 1 FROM clips WHERE path = ?').get(filePath)) return;
  const filename = path.basename(filePath);
  let sizeBytes = null, createdAt = new Date().toISOString();
  try { const s = fs.statSync(filePath); sizeBytes = s.size; createdAt = s.birthtime.toISOString(); } catch (_) {}
  const duration = await getDuration(filePath);
  const thumbnail = await generateThumbnail(filePath);
  const id = uuidv4();
  try {
    db.prepare(
      'INSERT OR IGNORE INTO clips (id, filename, path, created_at, added_at, duration, size_bytes, thumbnail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, filename, filePath, createdAt, new Date().toISOString(), duration, sizeBytes, thumbnail);
    mainWindow?.webContents.send('clip-detected', { id, filename, path: filePath, duration, thumbnail });

    // Auto-upload to platform if enabled
    if (getConfig('platform_auto_upload') === '1') {
      const platformUrl = getConfig('platform_url');
      const token       = getConfig('platform_token');
      if (platformUrl && token) {
        ipcMain.emit('_auto-upload', null, { clipId: id });
      }
    }
  } catch (e) { console.error('Error inserting clip:', e); }
}

async function getDuration(filePath) {
  try {
    const { stdout } = await execFileAsync('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', filePath]);
    return parseFloat(JSON.parse(stdout).format?.duration) || null;
  } catch { return null; }
}

async function generateThumbnail(filePath) {
  try {
    const thumbDir = path.join(app.getPath('temp'), 'flare_thumbs');
    fs.mkdirSync(thumbDir, { recursive: true });
    const thumbPath = path.join(thumbDir, path.basename(filePath, path.extname(filePath)) + '.jpg');
    await execFileAsync('ffmpeg', ['-y', '-ss', '00:00:01', '-i', filePath, '-vframes', '1', '-q:v', '5', '-vf', 'scale=320:-1', thumbPath]);
    return thumbPath;
  } catch { return null; }
}

// ─── IPC Handlers ────────────────────────────────────────────────────────────

function getTags(clipId) {
  return db.prepare('SELECT tag FROM tags WHERE clip_id = ? ORDER BY tag').all(clipId).map(r => r.tag);
}

ipcMain.handle('get-clips', (_, { limit, offset, search, sort }) => {
  const order = sort === 'oldest' ? 'created_at ASC' : sort === 'duration' ? 'duration DESC' : 'created_at DESC';
  const rows = search
    ? db.prepare('SELECT * FROM clips WHERE filename LIKE ? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(`%${search}%`, limit, offset)
    : db.prepare(`SELECT * FROM clips ORDER BY ${order} LIMIT ? OFFSET ?`).all(limit, offset);
  return rows.map(row => ({ ...row, tags: getTags(row.id) }));
});

ipcMain.handle('get-clip', (_, { id }) => {
  const row = db.prepare('SELECT * FROM clips WHERE id = ?').get(id);
  if (!row) throw new Error('Clip not found');
  return { ...row, tags: getTags(row.id) };
});

ipcMain.handle('get-clips-count', () => db.prepare('SELECT COUNT(*) as c FROM clips').get().c);

ipcMain.handle('add-tags', (_, { clipId, tags }) => {
  const stmt = db.prepare('INSERT OR IGNORE INTO tags (id, clip_id, tag) VALUES (?, ?, ?)');
  for (const tag of tags) stmt.run(uuidv4(), clipId, tag);
});

ipcMain.handle('remove-tag', (_, { clipId, tag }) => {
  db.prepare('DELETE FROM tags WHERE clip_id = ? AND tag = ?').run(clipId, tag);
});

ipcMain.handle('delete-clip', (_, { clipId }) => {
  db.prepare('DELETE FROM clips WHERE id = ?').run(clipId);
});

ipcMain.handle('set-watch-folder', (_, { folderPath }) => {
  setConfig('watch_folder', folderPath);
  startWatcher(folderPath);
});

ipcMain.handle('get-watch-folder', () => getConfig('watch_folder'));

ipcMain.handle('set-discord-config', (_, { botUrl, channelId, secret }) => {
  setConfig('discord_bot_url', botUrl);
  setConfig('discord_channel_id', channelId);
  setConfig('discord_secret', secret || '');
});

ipcMain.handle('share-clip-to-discord', async (_, { clipId, message }) => {
  const clip = db.prepare('SELECT * FROM clips WHERE id = ?').get(clipId);
  if (!clip) throw new Error('Clip not found');
  const botUrl = getConfig('discord_bot_url');
  if (!botUrl) throw new Error('Discord bot URL not configured. Open Discord settings first.');
  const channelId = getConfig('discord_channel_id');
  if (!channelId) throw new Error('Discord channel not configured.');
  const secret = getConfig('discord_secret') || '';
  const axios = require('axios');
  const headers = secret ? { 'X-Bridge-Secret': secret } : {};
  await axios.post(`${botUrl}/clips/share`, {
    clip_id: clip.id, filename: clip.filename, path: clip.path,
    duration: clip.duration, size_bytes: clip.size_bytes,
    tags: getTags(clipId), channel_id: channelId, message,
  }, { headers });
});

ipcMain.handle('open-folder-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('set-r2-config', (_, { accountId, accessKeyId, secretAccessKey, bucketName, publicDomain }) => {
  setConfig('r2_account_id',        accountId);
  setConfig('r2_access_key_id',     accessKeyId);
  setConfig('r2_secret_access_key', secretAccessKey);
  setConfig('r2_bucket_name',       bucketName);
  setConfig('r2_public_domain',     publicDomain.replace(/^https?:\/\//, ''));
});

ipcMain.handle('get-r2-config', () => ({
  accountId:       getConfig('r2_account_id')        || '',
  accessKeyId:     getConfig('r2_access_key_id')     || '',
  secretAccessKey: getConfig('r2_secret_access_key') || '',
  bucketName:      getConfig('r2_bucket_name')       || '',
  publicDomain:    getConfig('r2_public_domain')     || '',
}));

ipcMain.handle('upload-to-r2', async (_, { clipId }) => {
  const clip = db.prepare('SELECT * FROM clips WHERE id = ?').get(clipId);
  if (!clip) throw new Error('Clip not found');

  const accountId       = getConfig('r2_account_id');
  const accessKeyId     = getConfig('r2_access_key_id');
  const secretAccessKey = getConfig('r2_secret_access_key');
  const bucketName      = getConfig('r2_bucket_name');
  const publicDomain    = getConfig('r2_public_domain');

  if (!accountId || !accessKeyId || !secretAccessKey || !bucketName || !publicDomain) {
    throw new Error('R2 not configured — open Cloud settings first.');
  }

  const { S3Client }  = require('@aws-sdk/client-s3');
  const { Upload }    = require('@aws-sdk/lib-storage');

  const s3  = new S3Client({
    region:      'auto',
    endpoint:    `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });

  const ext  = path.extname(clip.path).toLowerCase();
  const mime = VIDEO_MIME[ext] || 'video/mp4';
  const key  = `${clipId}${ext}`;

  const upload = new Upload({
    client: s3,
    params: { Bucket: bucketName, Key: key, Body: fs.createReadStream(clip.path), ContentType: mime },
  });

  upload.on('httpUploadProgress', ({ loaded, total }) => {
    if (total) mainWindow?.webContents.send('r2-upload-progress', { percent: Math.round(loaded / total * 100) });
  });

  await upload.done();
  return `https://${publicDomain}/${key}`;
});

ipcMain.handle('get-discord-config', () => ({
  botUrl:    getConfig('discord_bot_url')    || '',
  channelId: getConfig('discord_channel_id') || '',
}));

ipcMain.handle('get-clip-link', (_, { clipId }) => {
  const ip = getLocalIP();
  return `http://${ip}:${LINK_PORT}/v/${clipId}`;
});

ipcMain.handle('get-app-version', () => app.getVersion());

// ─── Platform integration ──────────────────────────────────────────────────────

ipcMain.handle('set-platform-config', (_, { platformUrl, token, username }) => {
  setConfig('platform_url',      platformUrl);
  setConfig('platform_token',    token || '');
  setConfig('platform_username', username || '');
});

ipcMain.handle('get-platform-config', () => ({
  platformUrl: getConfig('platform_url')      || '',
  token:       getConfig('platform_token')    || '',
  username:    getConfig('platform_username') || '',
}));

ipcMain.handle('platform-login', async (_, { platformUrl, username, password }) => {
  const url = platformUrl.replace(/\/$/, '') + '/api/auth/login';
  const body = JSON.stringify({ username, password });
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 400) return reject(new Error(json.error || 'Login failed'));
          resolve(json);
        } catch { reject(new Error('Invalid response from platform')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
});

ipcMain.handle('platform-upload-clip', async (_, { clipId }) => {
  const clip        = db.prepare('SELECT * FROM clips WHERE id = ?').get(clipId);
  if (!clip) throw new Error('Clip not found');
  const platformUrl = getConfig('platform_url');
  const token       = getConfig('platform_token');
  if (!platformUrl || !token) throw new Error('Not connected to platform — open Platform settings first.');

  const axios     = require('axios');
  const FormData  = require('form-data');
  const form      = new FormData();
  form.append('clip',       fs.createReadStream(clip.path));
  form.append('title',      clip.filename.replace(/\.[^.]+$/, ''));
  form.append('filename',   clip.filename);
  form.append('duration',   String(clip.duration || ''));
  form.append('size_bytes', String(clip.size_bytes || ''));
  if (clip.thumbnail) form.append('thumbnail', fs.createReadStream(clip.thumbnail));

  const res = await axios.post(`${platformUrl.replace(/\/$/, '')}/api/clips/upload`, form, {
    headers: { ...form.getHeaders(), Authorization: `Bearer ${token}` },
    onUploadProgress: ({ loaded, total }) => {
      if (total) mainWindow?.webContents.send('platform-upload-progress', { percent: Math.round(loaded / total * 100) });
    },
    maxContentLength: Infinity,
    maxBodyLength:    Infinity,
  });

  const clipUrl = `${platformUrl.replace(/\/$/, '')}/clip/${res.data.id}`;
  setConfig(`platform_clip_${clipId}`, clipUrl);
  return clipUrl;
});

ipcMain.handle('get-platform-clip-url', (_, { clipId }) => getConfig(`platform_clip_${clipId}`) || null);

ipcMain.handle('set-platform-auto-upload', (_, { enabled }) => {
  setConfig('platform_auto_upload', enabled ? '1' : '0');
});
ipcMain.handle('get-platform-auto-upload', () => getConfig('platform_auto_upload') === '1');

// ─── OBS WebSocket / hotkey ────────────────────────────────────────────────────

ipcMain.handle('set-obs-config', (_, { host, port, password, hotkeyKey }) => {
  setConfig('obs_host',     host     || 'localhost');
  setConfig('obs_port',     String(port || 4455));
  setConfig('obs_password', password || '');
  setConfig('obs_hotkey',   hotkeyKey || 'F9');
  registerClipHotkey();
});

ipcMain.handle('get-obs-config', () => ({
  host:      getConfig('obs_host')     || 'localhost',
  port:      getConfig('obs_port')     || '4455',
  password:  getConfig('obs_password') || '',
  hotkeyKey: getConfig('obs_hotkey')   || 'F9',
}));

ipcMain.handle('obs-trigger-replay', triggerObsReplay);

async function triggerObsReplay() {
  const host     = getConfig('obs_host')     || 'localhost';
  const port     = getConfig('obs_port')     || '4455';
  const password = getConfig('obs_password') || '';
  try {
    const { default: OBSWebSocket } = require('obs-websocket-js');
    if (!obsWs) { obsWs = new OBSWebSocket(); }
    try { await obsWs.connect(`ws://${host}:${port}`, password || undefined); } catch {}
    await obsWs.call('SaveReplayBuffer');
    mainWindow?.webContents.send('obs-replay-saved');
    new Notification({ title: 'FlareTube', body: 'Replay saved! 🎬' }).show();
  } catch (e) {
    mainWindow?.webContents.send('obs-replay-error', { message: e.message });
    new Notification({ title: 'FlareTube', body: 'Could not save replay: ' + e.message }).show();
  }
}

function registerClipHotkey() {
  globalShortcut.unregisterAll();
  const key = getConfig('obs_hotkey') || 'F9';
  try {
    globalShortcut.register(key, () => triggerObsReplay());
  } catch (e) {
    console.error('Failed to register hotkey:', e);
  }
}

ipcMain.handle('check-for-update', async () => {
  try {
    const result = await autoUpdater.checkForUpdates();
    if (result?.updateInfo) {
      return { available: true, version: result.updateInfo.version, notes: result.updateInfo.releaseNotes || null };
    }
  } catch (_) {}
  return { available: false, version: app.getVersion(), notes: null };
});

ipcMain.handle('install-update', async () => {
  await autoUpdater.downloadUpdate();
  autoUpdater.quitAndInstall();
});

// ─── Local video link server ──────────────────────────────────────────────────

function getLocalIP() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

function startLinkServer() {
  linkServer = http.createServer((req, res) => {
    const match = req.url.match(/^\/v\/([a-f0-9-]{36})$/);
    if (!match) { res.writeHead(404); res.end(); return; }
    const clip = db.prepare('SELECT path FROM clips WHERE id = ?').get(match[1]);
    if (!clip) { res.writeHead(404); res.end(); return; }
    try {
      const stat = fs.statSync(clip.path);
      const mime = VIDEO_MIME[path.extname(clip.path).toLowerCase()] || 'video/mp4';
      const range = req.headers.range;
      if (range) {
        const [s, e] = range.replace(/bytes=/, '').split('-');
        const start = parseInt(s, 10);
        const end   = e ? parseInt(e, 10) : stat.size - 1;
        res.writeHead(206, {
          'Content-Range':  `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges':  'bytes',
          'Content-Length': end - start + 1,
          'Content-Type':   mime,
        });
        fs.createReadStream(clip.path, { start, end }).pipe(res);
      } else {
        res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': mime, 'Accept-Ranges': 'bytes' });
        fs.createReadStream(clip.path).pipe(res);
      }
    } catch (_) { res.writeHead(500); res.end(); }
  });
  linkServer.listen(LINK_PORT, '0.0.0.0');
}

// ─── App Lifecycle ────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200, height: 900, minWidth: 800, minHeight: 500,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'src-ui', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
}

app.whenReady().then(() => {
  protocol.registerFileProtocol('safe-file', (request, callback) => {
    const url = new URL(request.url);
    const filePath = decodeURIComponent(url.searchParams.get('p') || '');
    callback({ path: filePath });
  });

  initDb();
  startLinkServer();
  createWindow();

  const watchFolder = getConfig('watch_folder');
  if (watchFolder) startWatcher(watchFolder);

  // Auto-upload internal event (not exposed via ipc)
  ipcMain.on('_auto-upload', async (_, { clipId }) => {
    try {
      const url = await ipcMain.emit('platform-upload-clip', null, { clipId });
      mainWindow?.webContents.send('platform-auto-uploaded', { clipId, url });
    } catch (e) {
      console.error('Auto-upload failed:', e.message);
    }
  });

  registerClipHotkey();

  autoUpdater.autoDownload = false;
  autoUpdater.on('update-available', info => {
    mainWindow?.webContents.send('update-available', {
      available: true, version: info.version, notes: info.releaseNotes || null,
    });
  });
  autoUpdater.on('download-progress', ({ percent }) => {
    mainWindow?.webContents.send('update-progress', { percent: Math.round(percent) });
  });
  setTimeout(() => { try { autoUpdater.checkForUpdates(); } catch (_) {} }, 5000);
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
