/* Shell: window manager, taskbar, app launcher, VFS bridge. */
(async function () {
'use strict';

const $ = s => document.querySelector(s);

const APPS = {
    explorer: { title: 'Explorer',    icon: '<svg viewBox="0 0 16 16"><path d="M1.5 3.5h4.2l1.3 1.6h7.5v7.4a.5.5 0 0 1-.5.5h-12a.5.5 0 0 1-.5-.5z" fill="#f0c060" stroke="#a67c1e"/><path d="M1.5 5.7h13" stroke="#fff" stroke-opacity=".55"/></svg>', path: 'apps/explorer.ms2g', desktop: true,  width: 980, height: 640 },
    player:   { title: 'Media Player', icon: '<svg viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="12" rx="2" fill="#3272ae"/><path d="M6 4.5v7l6-3.5z" fill="#fff"/></svg>', path: 'apps/player.ms2g',   desktop: false, width: 860, height: 620 },
    notepad:  { title: 'Notepad',    icon: '<svg viewBox="0 0 16 16"><path d="M3.5 1.5h5.7l3.3 3.3v9.7h-9z" fill="#fff" stroke="#8d9aa8"/><path d="M9.2 1.5v3.3h3.3" fill="#eef2f6" stroke="#8d9aa8"/><rect x="4.6" y="7.3" width="6.8" height="4.8" rx="1" fill="#3a76ae"/></svg>', path: 'apps/notepad.ms2g',  desktop: true,  width: 780, height: 560 },
};

const windows = new Map();
let zCounter = 100;
let winSeq = 0;

// ---------- boot ----------
try { await VFS.init(); }
catch (e) {
    document.body.innerHTML = `<div style="padding:40px;font-family:monospace;color:#fff;background:#333;height:100vh">Storage init failed: ${e.message}</div>`;
    return;
}

buildDesktopIcons();
buildStartMenu();
startClock();
updateTrayDisk();
setInterval(updateTrayDisk, 10000);

launchApp('explorer');

// ---------- desktop icons ----------
function buildDesktopIcons() {
    const c = $('#desktop-icons');
    c.innerHTML = '';
    for (const [id, app] of Object.entries(APPS)) {
        if (!app.desktop) continue;
        const el = document.createElement('div');
        el.className = 'desk-icon';
        el.innerHTML = `<span class="di-svg">${app.icon}</span><span class="di-label">${app.title}</span>`;
        el.ondblclick = () => launchApp(id);
        c.appendChild(el);
    }
}

// ---------- start menu ----------
function buildStartMenu() {
    const c = $('#sm-apps');
    c.innerHTML = '';
    for (const [id, app] of Object.entries(APPS)) {
        const b = document.createElement('button');
        b.className = 'sm-item';
        b.innerHTML = `<span class="sm-svg">${app.icon}</span> ${app.title}`;
        b.onclick = () => { closeStartMenu(); launchApp(id); };
        c.appendChild(b);
    }
    $('#start-btn').onclick = e => { e.stopPropagation(); $('#start-menu').hidden = !$('#start-menu').hidden; };
    document.addEventListener('click', e => {
        if (!e.target.closest('#start-menu') && !e.target.closest('#start-btn')) closeStartMenu();
    });
    $('#sm-shutdown').onclick = () => { if (confirm('Reload desktop?')) location.reload(); };
}
function closeStartMenu() { $('#start-menu').hidden = true; }

// ---------- clock + tray ----------
function startClock() {
    const tick = () => {
        const d = new Date();
        $('#clock').textContent = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    };
    tick(); setInterval(tick, 15000);
}
async function updateTrayDisk() {
    try {
        const e = await VFS.estimate();
        const pct = e.quota ? Math.round((e.usage / e.quota) * 100) : 0;
        $('#tray-disk').textContent = pct + '%';
    } catch (_) {}
}

// ---------- window manager ----------
function createWindow(opts) {
    const id = 'w' + (++winSeq);
    const el = document.createElement('div');
    el.className = 'window';
    el.dataset.id = id;
    el.style.width = (opts.width || 900) + 'px';
    el.style.height = (opts.height || 580) + 'px';
    el.style.left = Math.max(10, (window.innerWidth - (opts.width || 900)) / 2 + (windows.size % 5) * 24) + 'px';
    el.style.top  = Math.max(10, (window.innerHeight - 30 - (opts.height || 580)) / 2 + (windows.size % 5) * 18) + 'px';
    el.style.zIndex = ++zCounter;
    el.innerHTML = `
        <div class="window-titlebar">
            <span class="window-icon">${opts.icon || ''}</span>
            <span class="window-title">${esc(opts.title || 'Window')}</span>
            <div class="window-buttons">
                <button class="wb-min" title="Minimize">–</button>
                <button class="wb-max" title="Maximize">□</button>
                <button class="wb-close" title="Close">×</button>
            </div>
        </div>
        <div class="window-content"></div>`;
    $('#window-layer').appendChild(el);

    const win = { id, el, iframe: null, title: opts.title || 'Window', icon: opts.icon || '', minimized: false };
    windows.set(id, win);

    el.addEventListener('mousedown', () => focusWindow(id), true);
    el.querySelector('.wb-close').onclick = () => closeWindow(id);
    el.querySelector('.wb-min').onclick = () => minimizeWindow(id);
    el.querySelector('.wb-max').onclick = () => el.classList.toggle('maximized');
    makeDraggable(el);
    updateTaskbar();
    return win;
}

function focusWindow(id) {
    const w = windows.get(id); if (!w) return;
    w.el.style.zIndex = ++zCounter;
    updateTaskbar();
}
function closeWindow(id) {
    const w = windows.get(id); if (!w) return;
    if (w.iframe && w.iframe.src) URL.revokeObjectURL(w.iframe.src);
    w.el.remove();
    windows.delete(id);
    updateTaskbar();
}
function minimizeWindow(id) {
    const w = windows.get(id); if (!w) return;
    w.minimized = true; w.el.style.display = 'none';
    updateTaskbar();
}
function restoreWindow(id) {
    const w = windows.get(id); if (!w) return;
    w.minimized = false; w.el.style.display = '';
    focusWindow(id);
}
function makeDraggable(el) {
    const tb = el.querySelector('.window-titlebar');
    let drag = null;
    tb.addEventListener('mousedown', e => {
        if (e.target.closest('button')) return;
        if (el.classList.contains('maximized')) return;
        const r = el.getBoundingClientRect();
        drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
        e.preventDefault();
    });
    window.addEventListener('mousemove', e => {
        if (!drag) return;
        el.style.left = Math.max(-el.offsetWidth + 100, Math.min(window.innerWidth - 100, e.clientX - drag.dx)) + 'px';
        el.style.top  = Math.max(0, Math.min(window.innerHeight - 60, e.clientY - drag.dy)) + 'px';
    });
    window.addEventListener('mouseup', () => { drag = null; });
}
function updateTaskbar() {
    const tb = $('#task-buttons');
    tb.innerHTML = '';
    const sorted = [...windows.values()].sort((a, b) => parseInt(a.el.style.zIndex) - parseInt(b.el.style.zIndex));
    for (const w of sorted) {
        const b = document.createElement('button');
        b.className = 'task-btn' + (w.minimized ? ' minimized' : '');
        b.innerHTML = `<span style="display:inline-flex;align-items:center;width:14px;height:14px;margin-right:6px;">${w.icon}</span> ${w.title}`;
        b.onclick = () => {
            if (w.minimized) restoreWindow(w.id);
            else if (parseInt(w.el.style.zIndex) === zCounter) minimizeWindow(w.id);
            else focusWindow(w.id);
        };
        tb.appendChild(b);
    }
}

// ---------- app launcher ----------
async function launchApp(appId, opts = {}) {
    const app = APPS[appId];
    if (!app) { console.warn('Unknown app', appId); return null; }
    const win = createWindow({
        title: opts.title || app.title,
        icon: app.icon,
        width: opts.width || app.width,
        height: opts.height || app.height,
    });
    let html;
    try {
        html = await fetch(app.path).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); });
    } catch (e) {
        win.el.querySelector('.window-content').innerHTML = `<div style="padding:20px;color:#b03a2a;">Failed to load ${esc(app.path)}: ${esc(e.message)}</div>`;
        return win;
    }
    return mountAppHtml(win, html, appId, opts);
}

async function launchVfsApp(name, html, opts = {}) {
    const win = createWindow({ title: name || 'App', icon: '<svg viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="12" rx="2" fill="#3272ae"/></svg>', width: 900, height: 620 });
    return mountAppHtml(win, html, 'vfs:' + name, opts);
}

function mountAppHtml(win, html, appId, opts) {
    // Inject base href to ensure relative paths (like style.css) resolve correctly
    const baseHref = new URL('./', window.location.href).href;
    if (!/<base\s/i.test(html)) {
        html = html.replace(/<head([^>]*)>/i, `<head$1><base href="${baseHref}">`);
    }
    // Strip leading slashes from local assets so they load correctly inside srcdoc
    html = html.replace(/href=["']\/(style\.css)["']/g, 'href="$1"');
    html = html.replace(/src=["']\/(app-sdk\.js)["']/g, 'src="$1"');

    const iframe = document.createElement('iframe');
    iframe.className = 'window-iframe';
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads allow-top-navigation-by-user-activation');
    win.iframe = iframe;
    win.el.querySelector('.window-content').appendChild(iframe);

    const channel = new MessageChannel();
    channel.port1.onmessage = e => handleAppMessage(win, e, channel.port1);

    iframe.addEventListener('load', () => {
        iframe.contentWindow.postMessage(
            { type: 'retro-init', appId, opts, appTitle: win.title },
            '*',
            [channel.port2]
        );
    });
    
    // srcdoc solves the blob URL origin/path issues completely
    iframe.srcdoc = html;
    return win;
}

// ---------- VFS bridge ----------
async function handleAppMessage(win, e, port) {
    const { id, method, args } = e.data || {};
    if (id == null || !method) return;
    let ok = true, result, error, errCode, errHint;
    try {
        result = await dispatch(win, method, args || {});
    } catch (err) {
        ok = false; error = (err && err.message) || String(err);
        if (err.code) errCode = err.code;
        if (err.hint) errHint = err.hint;
    }
    port.postMessage({ id, ok, result, error, errCode, errHint });
}

async function dispatch(win, method, args) {
    switch (method) {
        case 'list':       return VFS.list(args.target);
        case 'getNode':    return VFS.getNode(args.id);
        case 'read':       return VFS.read(args.target, args.opts);
        case 'readText':   return VFS.readText(args.target, args.opts);
        case 'write':      return VFS.write(args.path, args.blob, args.opts);
        case 'add':        return VFS.add(args.file, args.parent, args.opts);
        case 'mkdirAt':    return VFS.mkdirAt(args.parentId, args.name);
        case 'mkdir':      return VFS.mkdir(args.path, args.opts);
        case 'put':        return VFS.put(args.node);
        case 'update':     return VFS.update(args.id, args.changes);
        case 'remove':     return VFS.remove(args.id);
        case 'uniq':       return VFS.uniq(args.name, args.pid, args.exclude);
        case 'isInside':   return VFS.isInside(args.id, args.anc);
        case 'moveToTrash':return VFS.moveToTrash(args.id);
        case 'restore':    return VFS.restore(args.id);
        case 'shred':      return VFS.shred(args.id);
        case 'hash':       return VFS.hash(args.blob);
        case 'pathOf':     return VFS.pathOf(args.id);
        case 'copy':       return VFS.copy(args.id, args.parent);
        case 'estimate':   return VFS.estimate();
        case 'launchApp': {
            const w = await launchApp(args.appId, args.opts || {});
            return w ? { windowId: w.id } : null;
        }
        case 'launchVfsApp': {
            const w = await launchVfsApp(args.name, args.html, args.opts || {});
            return w ? { windowId: w.id } : null;
        }
        case 'setTitle': {
            win.title = String(args.title || '');
            win.el.querySelector('.window-title').textContent = win.title;
            updateTaskbar();
            return true;
        }
        case 'closeWindow':
            closeWindow(win.id);
            return true;
        default:
            throw new Error('Unknown SDK method: ' + method);
    }
}

function esc(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
})();
