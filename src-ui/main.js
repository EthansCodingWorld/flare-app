const invoke = (cmd, args) => window.electronAPI.invoke(cmd, args);
const listen = (event, cb) => window.electronAPI.on(event, cb);
const $ = id => document.getElementById(id);

const state = {
  clips: [], totalCount: 0, currentPage: 0, pageSize: 12,
  filter: { search: '', sort: 'newest' },
  currentClip: null,
};

async function init() {
  setupListeners();
  await Promise.all([loadClips(), loadWatchFolder(), loadAppVersion(), loadDiscordConfig(), loadR2Config()]);
  setupRealtime();
}

// ─── Listeners ────────────────────────────────────────────────────────────────

function setupListeners() {
  $('setupFolderBtn').addEventListener('click', () => $('setupModal').classList.add('active'));
  $('setupClose').addEventListener('click', () => $('setupModal').classList.remove('active'));
  $('discordBtn').addEventListener('click', () => $('discordModal').classList.add('active'));
  $('discordClose').addEventListener('click', () => $('discordModal').classList.remove('active'));
  $('modalClose').addEventListener('click', closeClipModal);

  $('browseFolderBtn').addEventListener('click', async () => {
    const p = await window.electronAPI.openFolderDialog();
    if (p) $('folderPathInput').value = p;
  });

  $('confirmFolderBtn').addEventListener('click', async () => {
    const p = $('folderPathInput').value.trim();
    if (!p) return;
    try {
      await invoke('set-watch-folder', { folderPath: p });
      $('setupModal').classList.remove('active');
      showToast('Watch folder saved!', 'success');
      await loadClips();
    } catch (e) { showToast('Error: ' + e, 'error'); }
  });

  $('saveDiscordBtn').addEventListener('click', async () => {
    const botUrl    = $('discordBotUrl').value.trim();
    const channelId = $('discordChannelId').value.trim();
    const secret    = $('discordSecret').value.trim() || null;
    if (!botUrl || !channelId) return showToast('Fill in Bot URL and Channel ID', 'error');
    try {
      await invoke('set-discord-config', { botUrl, channelId, secret });
      $('discordModal').classList.remove('active');
      showToast('Discord configured!', 'success');
    } catch (e) { showToast('Error: ' + e, 'error'); }
  });

  $('searchInput').addEventListener('input', e => {
    state.filter.search = e.target.value;
    state.currentPage = 0;
    loadClips();
  });

  $('sortSelect').addEventListener('change', e => {
    state.filter.sort = e.target.value;
    state.currentPage = 0;
    loadClips();
  });

  $('cloudBtn').addEventListener('click', () => $('cloudModal').classList.add('active'));
  $('cloudClose').addEventListener('click', () => $('cloudModal').classList.remove('active'));
  $('saveCloudBtn').addEventListener('click', saveR2Config);

  $('refreshBtn').addEventListener('click', loadClips);
  $('addTagBtn').addEventListener('click', addTag);
  $('newTagInput').addEventListener('keydown', e => { if (e.key === 'Enter') addTag(); });
  $('shareDiscordBtn').addEventListener('click', shareToDiscord);
  $('deleteClipBtn').addEventListener('click', deleteClip);
  $('uploadR2Btn').addEventListener('click', uploadToR2);
  $('copyCloudBtn').addEventListener('click', copyCloudLink);

  $('updateInstallBtn').addEventListener('click', doInstallUpdate);
  $('updateDetailsBtn').addEventListener('click', openUpdateModal);
  $('updateDismiss').addEventListener('click', () => $('updateBanner').classList.remove('visible'));
  $('updateModalClose').addEventListener('click', () => $('updateModal').classList.remove('active'));
  $('updateLaterBtn').addEventListener('click', () => $('updateModal').classList.remove('active'));
  $('updateConfirmBtn').addEventListener('click', doInstallUpdate);

  // Close modals on backdrop click
  ['clipModal', 'setupModal', 'discordModal', 'cloudModal', 'updateModal'].forEach(id => {
    $(id).addEventListener('click', e => { if (e.target === $(id)) $(id).classList.remove('active'); });
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape')
      ['clipModal','setupModal','discordModal','cloudModal','updateModal'].forEach(id => $(id).classList.remove('active'));
  });
}

// ─── Data loading ──────────────────────────────────────────────────────────────

async function loadClips() {
  try {
    const [clips, count] = await Promise.all([
      invoke('get-clips', {
        limit:  state.pageSize,
        offset: state.currentPage * state.pageSize,
        search: state.filter.search || null,
        sort:   state.filter.sort,
      }),
      invoke('get-clips-count'),
    ]);
    state.clips      = clips;
    state.totalCount = count;
    $('clipCount').textContent = `${count} clip${count !== 1 ? 's' : ''}`;
    renderClips();
  } catch (e) {
    console.error(e);
    $('clipsGrid').innerHTML = '<div class="loading">Error loading clips</div>';
  }
}

async function loadWatchFolder() {
  try {
    const f = await invoke('get-watch-folder');
    if (f) $('folderPathInput').value = f;
  } catch (_) {}
}

async function loadDiscordConfig() {
  try {
    const cfg = await invoke('get-discord-config');
    if (cfg) {
      if (cfg.botUrl)    $('discordBotUrl').value    = cfg.botUrl;
      if (cfg.channelId) $('discordChannelId').value = cfg.channelId;
    }
  } catch (_) {}
}

async function loadR2Config() {
  try {
    const cfg = await invoke('get-r2-config');
    if (cfg) {
      if (cfg.accountId)       $('r2AccountId').value       = cfg.accountId;
      if (cfg.accessKeyId)     $('r2AccessKeyId').value     = cfg.accessKeyId;
      if (cfg.secretAccessKey) $('r2SecretAccessKey').value = cfg.secretAccessKey;
      if (cfg.bucketName)      $('r2BucketName').value      = cfg.bucketName;
      $('r2PublicDomain').value = cfg.publicDomain || 'clips.flaremaxxing.com';
    }
  } catch (_) {}
}

async function saveR2Config() {
  const accountId       = $('r2AccountId').value.trim();
  const accessKeyId     = $('r2AccessKeyId').value.trim();
  const secretAccessKey = $('r2SecretAccessKey').value.trim();
  const bucketName      = $('r2BucketName').value.trim();
  const publicDomain    = $('r2PublicDomain').value.trim() || 'clips.flaremaxxing.com';
  if (!accountId || !accessKeyId || !secretAccessKey || !bucketName) {
    return showToast('Fill in all R2 fields', 'error');
  }
  try {
    await invoke('set-r2-config', { accountId, accessKeyId, secretAccessKey, bucketName, publicDomain });
    $('cloudModal').classList.remove('active');
    showToast('Cloud settings saved!', 'success');
  } catch (e) { showToast('Error: ' + e, 'error'); }
}

// ─── Render ────────────────────────────────────────────────────────────────────

function renderClips() {
  if (!state.clips.length) {
    $('clipsGrid').innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🎬</div>
        <h3>No clips yet</h3>
        <p>Set up your OBS output folder and FlareTube will detect new clips automatically</p>
        <button class="btn btn-primary" onclick="document.getElementById('setupModal').classList.add('active')">Setup Folder</button>
      </div>`;
    $('pagination').innerHTML = '';
    return;
  }

  $('clipsGrid').innerHTML = state.clips.map(c => `
    <div class="clip-card" data-id="${c.id}">
      <div class="thumb-wrap">
        ${c.thumbnail
          ? `<img src="${window.electronAPI.mediaUrl(c.thumbnail)}" class="clip-thumbnail" alt="" loading="lazy">`
          : `<div class="thumb-placeholder">🎬</div>`}
        ${c.duration ? `<div class="duration-badge">${fmtDuration(c.duration)}</div>` : ''}
        <div class="play-overlay">
          <div class="play-btn">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="white">
              <path d="M3 2l11 6-11 6V2z"/>
            </svg>
          </div>
        </div>
      </div>
      <div class="card-info">
        <div class="card-title" title="${esc(c.filename)}">${esc(c.filename)}</div>
        <div class="card-meta">
          <span>${fmtDate(c.created_at)}</span>
          ${c.size_bytes ? `<span>·</span><span>${fmtSize(c.size_bytes)}</span>` : ''}
        </div>
        ${c.tags.length ? `<div class="card-tags">${c.tags.map(t => `<span class="tag-pill">${esc(t)}</span>`).join('')}</div>` : ''}
      </div>
    </div>
  `).join('');

  document.querySelectorAll('.clip-card').forEach(el =>
    el.addEventListener('click', () => openClip(el.dataset.id))
  );

  renderPagination();
}

function renderPagination() {
  const total = Math.ceil(state.totalCount / state.pageSize);
  if (total <= 1) { $('pagination').innerHTML = ''; return; }
  const cur = state.currentPage;
  const pages = [];
  for (let i = 0; i < total; i++) {
    if (i === 0 || i === total - 1 || Math.abs(i - cur) <= 1) pages.push(i);
    else if (pages[pages.length - 1] !== '...') pages.push('...');
  }
  $('pagination').innerHTML = pages.map(p =>
    p === '...'
      ? `<span class="page-ellipsis">…</span>`
      : `<button class="${p === cur ? 'active' : ''}" data-page="${p}">${p + 1}</button>`
  ).join('');
  $('pagination').querySelectorAll('button').forEach(btn =>
    btn.addEventListener('click', () => {
      state.currentPage = parseInt(btn.dataset.page);
      loadClips();
      window.scrollTo(0, 0);
    })
  );
}

// ─── Clip detail ───────────────────────────────────────────────────────────────

async function openClip(id) {
  try {
    const clip = await invoke('get-clip', { id });
    state.currentClip = clip;

    $('clipTitle').textContent    = clip.filename;
    $('clipDate').textContent     = fmtDateFull(clip.created_at);
    $('clipDuration').textContent = clip.duration  ? fmtDuration(clip.duration)  : '—';
    $('clipSize').textContent     = clip.size_bytes ? fmtSize(clip.size_bytes)    : '—';
    $('clipVideo').src = window.electronAPI.mediaUrl(clip.path);

    renderClipTags(clip.tags);

    // Reset cloud share UI
    $('cloudLinkRow').style.display = 'none';
    $('cloudLink').textContent = '';
    $('uploadProg').style.display = 'none';
    $('uploadFill').style.width = '0%';
    $('uploadR2Btn').style.display = '';

    $('clipModal').classList.add('active');

  } catch (e) { showToast('Error loading clip: ' + e, 'error'); }
}

function renderClipTags(tags) {
  $('clipTags').innerHTML = tags.map(t => `
    <span class="clip-tag">
      ${esc(t)}
      <button class="tag-x" data-tag="${esc(t)}" title="Remove">×</button>
    </span>
  `).join('');

  $('clipTags').querySelectorAll('.tag-x').forEach(btn =>
    btn.addEventListener('click', async () => {
      try {
        await invoke('remove-tag', { clipId: state.currentClip.id, tag: btn.dataset.tag });
        state.currentClip.tags = state.currentClip.tags.filter(t => t !== btn.dataset.tag);
        renderClipTags(state.currentClip.tags);
      } catch (e) { showToast('Error: ' + e, 'error'); }
    })
  );
}

async function addTag() {
  const input = $('newTagInput');
  const tag   = input.value.trim();
  if (!tag || !state.currentClip) return;
  try {
    await invoke('add-tags', { clipId: state.currentClip.id, tags: [tag] });
    state.currentClip.tags.push(tag);
    renderClipTags(state.currentClip.tags);
    input.value = '';
  } catch (e) { showToast('Error: ' + e, 'error'); }
}

function closeClipModal() {
  $('clipModal').classList.remove('active');
  $('clipVideo').src = '';
  state.currentClip = null;
}

// ─── R2 cloud upload ───────────────────────────────────────────────────────────

async function uploadToR2() {
  if (!state.currentClip) return;
  const btn = $('uploadR2Btn');
  try {
    btn.disabled = true; btn.textContent = 'Uploading…';
    $('uploadProg').style.display = '';
    $('uploadFill').style.width = '0%';
    $('uploadLabel').textContent = 'Uploading…';

    const url = await invoke('upload-to-r2', { clipId: state.currentClip.id });

    $('uploadProg').style.display = 'none';
    $('cloudLink').textContent = url;
    $('cloudLinkRow').style.display = '';
    btn.style.display = 'none';
    showToast('Uploaded! Link ready.', 'success');
  } catch (e) {
    $('uploadProg').style.display = 'none';
    btn.disabled = false; btn.textContent = '☁ Upload & Get Link';
    showToast('Upload failed: ' + e, 'error');
  }
}

async function copyCloudLink() {
  const link = $('cloudLink').textContent;
  if (!link) return;
  try {
    await navigator.clipboard.writeText(link);
    showToast('Link copied!', 'success');
  } catch (_) { showToast('Copy failed', 'error'); }
}

// ─── Discord share ─────────────────────────────────────────────────────────────

async function shareToDiscord() {
  if (!state.currentClip) return;
  const msg = $('discordMessage').value.trim() || null;
  const btn = $('shareDiscordBtn');
  try {
    btn.disabled = true; btn.textContent = 'Sharing…';
    await invoke('share-clip-to-discord', { clipId: state.currentClip.id, message: msg });
    showToast('Shared to Discord!', 'success');
    $('discordMessage').value = '';
  } catch (e) {
    showToast('Discord error: ' + e, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Share to Discord';
  }
}

// ─── Delete ────────────────────────────────────────────────────────────────────

async function deleteClip() {
  if (!state.currentClip) return;
  if (!confirm(`Remove "${state.currentClip.filename}" from FlareTube?\n(The file stays on disk)`)) return;
  try {
    await invoke('delete-clip', { clipId: state.currentClip.id });
    closeClipModal();
    await loadClips();
    showToast('Removed from library', 'info');
  } catch (e) { showToast('Error: ' + e, 'error'); }
}

// ─── Realtime ─────────────────────────────────────────────────────────────────

function setupRealtime() {
  listen('clip-detected', () => loadClips());
  listen('update-available', data => showUpdateBanner(data));
  listen('update-progress', data => setProgress(data.percent));
  listen('r2-upload-progress', data => {
    $('uploadFill').style.width = `${data.percent}%`;
    $('uploadLabel').textContent = data.percent < 100 ? `Uploading… ${data.percent}%` : 'Finishing…';
  });
}

// ─── Updates ──────────────────────────────────────────────────────────────────

let _pendingUpdate = null;

async function loadAppVersion() {
  try {
    const v = await invoke('get-app-version');
    $('currentVersionPill').textContent = `v${v}`;
  } catch (_) {}
}

function showUpdateBanner(update) {
  _pendingUpdate = update;
  $('updateBannerText').textContent = `✨ FlareTube ${update.version} is available`;
  $('updateBanner').classList.add('visible');
}

function openUpdateModal() {
  if (!_pendingUpdate) return;
  $('newVersionPill').textContent = `v${_pendingUpdate.version}`;
  $('changelogBox').textContent   = _pendingUpdate.notes || 'No release notes.';
  $('updateProgress').classList.remove('visible');
  $('progressFill').style.width = '0%';
  $('updateConfirmBtn').disabled    = false;
  $('updateConfirmBtn').textContent = 'Install & Restart';
  $('updateModal').classList.add('active');
}

function setProgress(pct) {
  $('updateProgress').classList.add('visible');
  $('progressFill').style.width   = `${pct}%`;
  $('progressLabel').textContent  = pct < 100 ? `Downloading… ${pct}%` : 'Installing…';
}

async function doInstallUpdate() {
  $('updateConfirmBtn').disabled    = true;
  $('updateConfirmBtn').textContent = 'Downloading…';
  $('updateProgress').classList.add('visible');
  try {
    await invoke('install-update');
  } catch (e) {
    $('updateConfirmBtn').disabled    = false;
    $('updateConfirmBtn').textContent = 'Install & Restart';
    showToast('Update failed: ' + e, 'error');
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDuration(s) {
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2,'0')}`;
}
function fmtDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { month:'short', day:'numeric' });
}
function fmtDateFull(iso) { return new Date(iso).toLocaleString(); }
function fmtSize(b) {
  if (b < 1024**2) return `${(b/1024).toFixed(0)} KB`;
  if (b < 1024**3) return `${(b/1024**2).toFixed(1)} MB`;
  return `${(b/1024**3).toFixed(2)} GB`;
}
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

let _toastTimer;
function showToast(msg, type = 'info') {
  let el = $('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.className   = `toast toast-${type} visible`;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('visible'), 3000);
}

init();
