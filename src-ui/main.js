const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { open } = window.__TAURI__.dialog;

const state = {
    clips: [],
    totalCount: 0,
    currentPage: 0,
    pageSize: 12,
    filter: { search: '', sort: 'newest' },
    currentClip: null,
};

const $ = id => document.getElementById(id);

async function init() {
    setupListeners();
    await loadClips();
    await loadWatchFolder();
    await loadAppVersion();
    setupRealtime();
}

function setupListeners() {
    $('setupFolderBtn').addEventListener('click', () => $('setupModal').classList.add('active'));
    $('setupClose').addEventListener('click', () => $('setupModal').classList.remove('active'));
    $('discordBtn').addEventListener('click', () => $('discordModal').classList.add('active'));
    $('discordClose').addEventListener('click', () => $('discordModal').classList.remove('active'));
    $('modalClose').addEventListener('click', closeClipModal);

    $('browseFolderBtn').addEventListener('click', async () => {
        const selected = await open({ directory: true, multiple: false });
        if (selected) $('folderPathInput').value = selected;
    });

    $('confirmFolderBtn').addEventListener('click', async () => {
        const path = $('folderPathInput').value.trim();
        if (!path) return;
        try {
            await invoke('set_watch_folder', { folderPath: path });
            $('setupModal').classList.remove('active');
            showToast('Watch folder saved!', 'success');
            await loadClips();
        } catch (e) {
            showToast('Error: ' + e, 'error');
        }
    });

    $('saveDiscordBtn').addEventListener('click', async () => {
        const botUrl = $('discordBotUrl').value.trim();
        const channelId = $('discordChannelId').value.trim();
        const secret = $('discordSecret').value.trim() || null;
        if (!botUrl || !channelId) return showToast('Fill in Bot URL and Channel ID', 'error');
        try {
            await invoke('set_discord_config', { botUrl, channelId, secret });
            $('discordModal').classList.remove('active');
            showToast('Discord configured!', 'success');
        } catch (e) {
            showToast('Error: ' + e, 'error');
        }
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

    $('refreshBtn').addEventListener('click', loadClips);

    $('addTagBtn').addEventListener('click', addTag);
    $('newTagInput').addEventListener('keydown', e => { if (e.key === 'Enter') addTag(); });
    $('shareDiscordBtn').addEventListener('click', shareToDiscord);
    $('deleteClipBtn').addEventListener('click', deleteClip);

    // Update banner
    $('updateInstallBtn').addEventListener('click', doInstallUpdate);
    $('updateDetailsBtn').addEventListener('click', openUpdateModal);
    $('updateDismiss').addEventListener('click', () => $('updateBanner').classList.remove('visible'));

    // Update modal
    $('updateModalClose').addEventListener('click', () => $('updateModal').classList.remove('active'));
    $('updateLaterBtn').addEventListener('click', () => $('updateModal').classList.remove('active'));
    $('updateConfirmBtn').addEventListener('click', doInstallUpdate);

    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            $('clipModal').classList.remove('active');
            $('setupModal').classList.remove('active');
            $('discordModal').classList.remove('active');
            $('updateModal').classList.remove('active');
        }
    });
}

async function loadClips() {
    try {
        const [clips, count] = await Promise.all([
            invoke('get_clips', {
                limit: state.pageSize,
                offset: state.currentPage * state.pageSize,
                search: state.filter.search || null,
                sort: state.filter.sort,
            }),
            invoke('get_clips_count'),
        ]);
        state.clips = clips;
        state.totalCount = count;
        $('clipCount').textContent = `${count} clip${count !== 1 ? 's' : ''}`;
        renderClips();
    } catch (e) {
        console.error('Failed to load clips:', e);
        $('clipsGrid').innerHTML = '<div class="loading">Error loading clips</div>';
    }
}

async function loadWatchFolder() {
    try {
        const folder = await invoke('get_watch_folder');
        if (folder) $('folderPathInput').value = folder;
    } catch (_) {}
}

function renderClips() {
    if (!state.clips.length) {
        $('clipsGrid').innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">🎬</div>
                <h3>No clips yet</h3>
                <p>Set up your OBS output folder to get started</p>
                <button class="btn btn-primary" onclick="document.getElementById('setupModal').classList.add('active')">Setup Folder</button>
            </div>`;
        $('pagination').innerHTML = '';
        return;
    }

    $('clipsGrid').innerHTML = state.clips.map(clip => `
        <div class="clip-card" data-id="${clip.id}">
            ${clip.thumbnail
                ? `<img src="asset://localhost/${clip.thumbnail.replace(/\\/g, '/')}" class="clip-thumbnail" alt="" loading="lazy">`
                : `<div class="clip-thumbnail clip-thumb-placeholder"><span>🎬</span></div>`}
            <div class="clip-card-info">
                <div class="clip-card-title" title="${escHtml(clip.filename)}">${escHtml(clip.filename)}</div>
                <div class="clip-card-meta">
                    ${clip.duration ? `<span>${fmtDuration(clip.duration)}</span>` : ''}
                    <span>${fmtDate(clip.created_at)}</span>
                </div>
                ${clip.tags.length ? `<div class="clip-card-tags">${clip.tags.map(t => `<span class="tag-chip">${escHtml(t)}</span>`).join('')}</div>` : ''}
            </div>
        </div>
    `).join('');

    document.querySelectorAll('.clip-card').forEach(card => {
        card.addEventListener('click', () => openClip(card.dataset.id));
    });

    renderPagination();
}

function renderPagination() {
    const total = Math.ceil(state.totalCount / state.pageSize);
    if (total <= 1) { $('pagination').innerHTML = ''; return; }

    const cur = state.currentPage;
    const pages = [];
    for (let i = 0; i < total; i++) {
        if (i === 0 || i === total - 1 || Math.abs(i - cur) <= 1) {
            pages.push(i);
        } else if (pages[pages.length - 1] !== '...') {
            pages.push('...');
        }
    }

    $('pagination').innerHTML = pages.map(p =>
        p === '...'
            ? `<span class="page-ellipsis">…</span>`
            : `<button class="${p === cur ? 'active' : ''}" data-page="${p}">${p + 1}</button>`
    ).join('');

    $('pagination').querySelectorAll('button').forEach(btn => {
        btn.addEventListener('click', () => {
            state.currentPage = parseInt(btn.dataset.page);
            loadClips();
            window.scrollTo(0, 0);
        });
    });
}

async function openClip(id) {
    try {
        const clip = await invoke('get_clip', { id });
        state.currentClip = clip;

        $('clipTitle').textContent = clip.filename;
        $('clipDate').textContent = fmtDateFull(clip.created_at);
        $('clipDuration').textContent = clip.duration ? fmtDuration(clip.duration) : '';
        $('clipSize').textContent = clip.size_bytes ? fmtSize(clip.size_bytes) : '';
        $('clipVideo').src = `asset://localhost/${clip.path.replace(/\\/g, '/')}`;

        renderClipTags(clip.tags);
        $('clipModal').classList.add('active');
    } catch (e) {
        showToast('Error loading clip: ' + e, 'error');
    }
}

function renderClipTags(tags) {
    $('clipTags').innerHTML = tags.map(t => `
        <span class="clip-tag">
            ${escHtml(t)}
            <button class="tag-remove" data-tag="${escHtml(t)}" title="Remove tag">×</button>
        </span>
    `).join('');

    $('clipTags').querySelectorAll('.tag-remove').forEach(btn => {
        btn.addEventListener('click', async () => {
            try {
                await invoke('remove_tag', { clipId: state.currentClip.id, tag: btn.dataset.tag });
                state.currentClip.tags = state.currentClip.tags.filter(t => t !== btn.dataset.tag);
                renderClipTags(state.currentClip.tags);
            } catch (e) { showToast('Error: ' + e, 'error'); }
        });
    });
}

async function addTag() {
    const input = $('newTagInput');
    const tag = input.value.trim();
    if (!tag || !state.currentClip) return;
    try {
        await invoke('add_tags', { clipId: state.currentClip.id, tags: [tag] });
        state.currentClip.tags.push(tag);
        renderClipTags(state.currentClip.tags);
        input.value = '';
    } catch (e) { showToast('Error: ' + e, 'error'); }
}

async function shareToDiscord() {
    if (!state.currentClip) return;
    const msg = $('discordMessage').value.trim() || null;
    try {
        $('shareDiscordBtn').disabled = true;
        $('shareDiscordBtn').textContent = 'Sharing…';
        await invoke('share_clip_to_discord', { clipId: state.currentClip.id, message: msg });
        showToast('Shared to Discord!', 'success');
        $('discordMessage').value = '';
    } catch (e) {
        showToast('Discord error: ' + e, 'error');
    } finally {
        $('shareDiscordBtn').disabled = false;
        $('shareDiscordBtn').textContent = 'Share to Discord';
    }
}

async function deleteClip() {
    if (!state.currentClip) return;
    if (!confirm(`Delete "${state.currentClip.filename}" from Flare? (File stays on disk)`)) return;
    try {
        await invoke('delete_clip', { clipId: state.currentClip.id });
        closeClipModal();
        await loadClips();
        showToast('Clip removed', 'success');
    } catch (e) { showToast('Error: ' + e, 'error'); }
}

function closeClipModal() {
    $('clipModal').classList.remove('active');
    $('clipVideo').src = '';
    state.currentClip = null;
}

function setupRealtime() {
    listen('clip-detected', () => loadClips());

    // Background update check result
    listen('update-available', ({ payload }) => {
        showUpdateBanner(payload);
    });

    // Download progress from install_update command
    listen('update-progress', ({ payload }) => {
        setUpdateProgress(payload.percent);
    });
}

// ─── Versioning / Updates ────────────────────────────────────────────────────

let _pendingUpdate = null;

async function loadAppVersion() {
    try {
        const ver = await invoke('get_app_version');
        $('currentVersionPill').textContent = `v${ver}`;
    } catch (_) {}
}

function showUpdateBanner(update) {
    _pendingUpdate = update;
    $('updateBannerText').textContent = `✨ Flare ${update.version} is available`;
    $('updateBanner').classList.add('visible');
}

function openUpdateModal() {
    if (!_pendingUpdate) return;
    $('newVersionPill').textContent = `v${_pendingUpdate.version}`;
    $('changelogBox').textContent = _pendingUpdate.notes || 'No release notes provided.';
    $('updateProgress').classList.remove('visible');
    $('progressFill').style.width = '0%';
    $('updateConfirmBtn').disabled = false;
    $('updateConfirmBtn').textContent = 'Install & Restart';
    $('updateModal').classList.add('active');
}

function setUpdateProgress(percent) {
    $('updateProgress').classList.add('visible');
    $('progressFill').style.width = `${percent}%`;
    $('progressLabel').textContent = percent < 100 ? `Downloading… ${percent}%` : 'Installing…';
}

async function doInstallUpdate() {
    $('updateConfirmBtn').disabled = true;
    $('updateConfirmBtn').textContent = 'Downloading…';
    $('updateProgress').classList.add('visible');
    try {
        await invoke('install_update');
        // App will restart automatically after install
    } catch (e) {
        $('updateConfirmBtn').disabled = false;
        $('updateConfirmBtn').textContent = 'Install & Restart';
        showToast('Update failed: ' + e, 'error');
    }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function fmtDuration(secs) {
    const m = Math.floor(secs / 60), s = Math.floor(secs % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtDate(iso) {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function fmtDateFull(iso) {
    return new Date(iso).toLocaleString();
}

function fmtSize(bytes) {
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function escHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

let toastTimer;
function showToast(msg, type = 'info') {
    let toast = $('toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'toast';
        document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.className = `toast toast-${type} visible`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('visible'), 3000);
}

init();
