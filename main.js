'use strict';

const { app, BrowserWindow, ipcMain, dialog, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const chokidar = require('chokidar');
const { v4: uuidv4 } = require('uuid');
const { autoUpdater } = require('electron-updater');
const Database = require('better-sqlite3');

const execFileAsync = promisify(execFile);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.mkv', '.flv', '.avi', '.webm']);

// Must be called before app is ready
protocol.registerSchemesAsPrivileged([
  { scheme: 'safe-file', privileges: { secure: true, standard: true, stream: true, supportFetchAPI: true } },
]);

let mainWindow;
let db;
let watcher;

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

ipcMain.handle('get-app-version', () => app.getVersion());

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
  createWindow();

  const watchFolder = getConfig('watch_folder');
  if (watchFolder) startWatcher(watchFolder);

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

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
