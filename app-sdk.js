/* SDK injected into every .ms2g app. Exposes RetroFS / RetroShell / RetroApp. */
(function () {
'use strict';

let port = null;
let nextId = 0;
const pending = new Map();
let appInfo = null;
let readyResolve;
const readyPromise = new Promise(r => { readyResolve = r; });

const decode = v => {
    if (v && typeof v === 'object' && v.__blob) {
        return new Blob([new Uint8Array(v.data)], { type: v.type });
    }
    return v;
};

const rpc = (method, args) => new Promise((resolve, reject) => {
    const send = () => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        port.postMessage({ id, method, args });
    };
    if (port) send(); else readyPromise.then(send);
});

window.addEventListener('message', (e) => {
    if (!e.data || e.data.type !== 'retro-init') return;
    port = e.ports[0];
    appInfo = e.data;
    port.onmessage = (msg) => {
        const { id, ok, result, error, errCode, errHint } = msg.data;
        const p = pending.get(id);
        if (!p) return;
        pending.delete(id);
        if (ok) return p.resolve(decode(result));
        const err = new Error(error || 'error');
        if (errCode) err.code = errCode;
        if (errHint) err.hint = errHint;
        if (errCode === 'NEED_PASSWORD') err.needsPassword = true;
        p.reject(err);
    };
    readyResolve(appInfo);
});

window.RetroFS = {
    list: t => rpc('list', { target: t }),
    getNode: id => rpc('getNode', { id }),
    stat: t => rpc('getNode', { id: t }),
    read: (t, o = {}) => rpc('read', { target: t, opts: o }),
    readText: (t, o = {}) => rpc('readText', { target: t, opts: o }),
    write: (p, b, o = {}) => rpc('write', { path: p, blob: b, opts: o }),
    add: (f, parent, o = {}) => rpc('add', { file: f, parent, opts: o }),
    mkdirAt: (pid, n) => rpc('mkdirAt', { parentId: pid, name: n }),
    mkdir: (p, o = {}) => rpc('mkdir', { path: p, opts: o }),
    put: n => rpc('put', { node: n }),
    update: (id, c) => rpc('update', { id, changes: c }),
    remove: id => rpc('remove', { id }),
    uniq: (n, pid, ex) => rpc('uniq', { name: n, pid, exclude: ex }),
    isInside: (id, anc) => rpc('isInside', { id, anc }),
    moveToTrash: id => rpc('moveToTrash', { id }),
    restore: id => rpc('restore', { id }),
    shred: id => rpc('shred', { id }),
    hash: b => rpc('hash', { blob: b }),
    pathOf: id => rpc('pathOf', { id }),
    copy: (id, parent) => rpc('copy', { id, parent }),
    estimate: () => rpc('estimate', {}),
};

window.RetroShell = {
    ready: () => readyPromise,
    launchApp: (appId, opts = {}) => rpc('launchApp', { appId, opts }),
    launchVfsApp: (name, html, opts = {}) => rpc('launchVfsApp', { name, html, opts }),
    setTitle: title => rpc('setTitle', { title }),
    close: () => rpc('closeWindow', {}),
    info: () => readyPromise.then(i => i),
};

window.RetroApp = {
    onReady: fn => readyPromise.then(fn),
    info: () => appInfo,
};
})();
