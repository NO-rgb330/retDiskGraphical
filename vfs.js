/* Storage engine: OPFS primary, IndexedDB fallback. Extracted from the
   original app.js, unchanged logic, exposed as window.VFS. */
(function () {
'use strict';

const DB = 'rd8', V = 1, N = 'n', R = 'r', O = 'opf8', C = 5 * 1024 * 1024, TRASH = 'trash';
const KDF_ITER = 600000, MAX_HASH = 1024 ** 3;

let db, opf = null, wkr = null, activeBackend = 'none';

const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const tx = t => new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const subtleOK = () => !!(window.crypto && crypto.subtle);
const bytesToHex = a => Array.from(a).map(b => b.toString(16).padStart(2, '0')).join('');
const hexToBytes = h => new Uint8Array(h.match(/.{1,2}/g).map(b => parseInt(b, 16)));
const uid = () => 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
const cleanName = s => String(s).replace(/[\/\\]/g, '_').replace(/[\u0000-\u001f]/g, '').trim();

const openIDB = () => new Promise((res, rej) => {
    const r = indexedDB.open(DB, V);
    r.onupgradeneeded = e => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains(N)) d.createObjectStore(N, { keyPath: 'id' }).createIndex('pid', 'parentId');
        if (!d.objectStoreNames.contains('s')) d.createObjectStore('s', { keyPath: 'k' });
        if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs', { keyPath: 'id' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
});

const sto = (n, m = 'readonly') => db.transaction(n, m).objectStore(n);
const list = pid => req(sto(N).index('pid').getAll(pid));
const node = id => id === R
    ? Promise.resolve({ id: R, name: 'My Disk', kind: 'folder', parentId: null })
    : id === TRASH
        ? Promise.resolve({ id: TRASH, name: 'Trash', kind: 'folder', parentId: null })
        : req(sto(N).get(id));
const put = n => req(sto(N, 'readwrite').put(n));

const del = async id => {
    for (const c of await list(id)) await del(c.id);
    const n = await node(id);
    if (n && n.kind === 'file') await deleteBlob(id);
    await req(sto(N, 'readwrite').delete(id));
};

const uniq = async (n, pid, ex) => {
    const s = await list(pid), t = new Set(s.filter(x => x.id !== ex).map(x => x.name.toLowerCase()));
    if (!t.has(n.toLowerCase())) return n;
    const d = n.lastIndexOf('.'), b = d > 0 ? n.slice(0, d) : n, e = d > 0 ? n.slice(d) : '';
    let i = 2, c; do { c = `${b} (${i})${e}`; i++; } while (t.has(c.toLowerCase()));
    return c;
};

const isInside = async (id, anc) => {
    let cur = id;
    for (let g = 0; cur && cur !== R && cur !== TRASH && g < 500; g++) {
        if (cur === anc) return true;
        const n = await node(cur); cur = n && n.parentId;
    }
    return cur === anc;
};

const getFhOPFS = async (id, cr) => (await opf.getDirectoryHandle(O, { create: true })).getFileHandle(id, { create: !!cr });

const mountStorage = async () => {
    try {
        if (navigator.storage && navigator.storage.getDirectory) {
            opf = await navigator.storage.getDirectory();
            const d = await opf.getDirectoryHandle(O, { create: true });
            const w = await (await d.getFileHandle('test', { create: true })).createWritable();
            await w.write(new Uint8Array(1)); await w.close();
            await d.removeEntry('test');
            activeBackend = 'OPFS';
            return;
        }
    } catch (e) { opf = null; }
    activeBackend = 'IndexedDB';
};

const writeBlob = async (id, data) => {
    if (activeBackend === 'OPFS') {
        const w = await (await getFhOPFS(id, true)).createWritable();
        await w.write(data); await w.close();
    } else {
        const t = db.transaction('blobs', 'readwrite');
        t.objectStore('blobs').put({ id, data });
        await tx(t);
    }
};
const readBlob = async id => {
    if (activeBackend === 'OPFS') { try { return await (await getFhOPFS(id, false)).getFile(); } catch (e) {} }
    try { const rec = await req(sto('blobs').get(id)); return rec ? rec.data : null; } catch (e) { return null; }
};
const deleteBlob = async id => {
    if (activeBackend === 'OPFS') {
        try { await (await opf.getDirectoryHandle(O)).removeEntry(id); } catch (e) {}
    } else {
        const t = db.transaction('blobs', 'readwrite');
        t.objectStore('blobs').delete(id);
        await tx(t);
    }
};

const proc = async (file, pwd, nd) => {
    if (pwd && !subtleOK()) throw new Error('Encryption needs HTTPS or localhost.');
    const tot = Math.ceil(file.size / C);
    const comp = typeof CompressionStream !== 'undefined' && file.size < 100 * 1024 * 1024
        && (file.type.startsWith('text/') || file.type === 'application/json');
    const salt = crypto.getRandomValues(new Uint8Array(16)), sHex = bytesToHex(salt);
    nd.salt = Array.from(salt);
    nd.compressed = comp;

    let writ = null;
    const chunks = [];
    if (activeBackend === 'OPFS') writ = await (await getFhOPFS(nd.id, true)).createWritable();

    for (let i = 0; i < tot; i++) {
        const c = await file.slice(i * C, Math.min((i + 1) * C, file.size)).arrayBuffer();
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const buf = await runChunk({ chunk: c, compress: comp, password: pwd || null, saltHex: sHex, ivHex: bytesToHex(iv) });
        nd.ivs.push(Array.from(iv));
        nd.chunkSizes.push(buf.byteLength);
        nd.compSize += buf.byteLength;
        if (writ) await writ.write(new Uint8Array(buf));
        else chunks.push(new Uint8Array(buf));
        if (i % 20 === 19) await req(sto(N, 'readwrite').put(nd));
        await sleep(0);
    }
    if (writ) await writ.close();
    else await writeBlob(nd.id, new Blob(chunks));
    nd.isUploading = false;
    await req(sto(N, 'readwrite').put(nd));
};

const hashBlob = async b => {
    if (!subtleOK() || b.size > MAX_HASH) return null;
    return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', await b.arrayBuffer())));
};

const deriveKey = async (pwd, salt, usage) => crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: KDF_ITER, hash: 'SHA-256' },
    await crypto.subtle.importKey('raw', new TextEncoder().encode(pwd), 'PBKDF2', false, ['deriveKey']),
    { name: 'AES-GCM', length: 256 }, false, [usage]
);
const legacyKey = async p => bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(p))));

let lk = { id: null, key: null };
const localChunk = async ({ chunk, compress, password, saltHex, ivHex }) => {
    let buf = chunk;
    if (compress) buf = await new Response(new Blob([buf]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
    if (password) {
        const id = saltHex + '|' + password;
        if (lk.id !== id) lk = { id, key: await deriveKey(password, hexToBytes(saltHex), 'encrypt') };
        buf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: hexToBytes(ivHex) }, lk.key, buf);
    }
    return buf;
};

let wPending = null;
const useWorker = () => {
    try {
        wkr = new Worker('worker.js');
        wkr.onerror = e => {
            if (e && e.preventDefault) e.preventDefault();
            wkr = null;
            if (wPending) { const p = wPending; wPending = null; localChunk(p.msg).then(p.res, p.rej); }
        };
        wkr.onmessage = e => {
            const p = wPending; wPending = null;
            if (p) e.data.ok ? p.res(e.data.buf) : p.rej(new Error(e.data.error));
        };
    } catch (e) { wkr = null; }
};
const runChunk = msg => new Promise((res, rej) => {
    if (!wkr) return localChunk(msg).then(res, rej);
    wPending = { msg, res, rej };
    wkr.postMessage(msg);
});

const getBlob = async (nd, pwd) => {
    try {
        const raw = await readBlob(nd.id);
        if (!raw) return null;
        if (!nd.encrypted && !nd.compressed) return raw;
        let key = null;
        if (nd.encrypted) {
            if (!subtleOK()) throw new Error('Decryption needs HTTPS or localhost.');
            key = await deriveKey(nd.encVer === 2 ? pwd : await legacyKey(pwd), new Uint8Array(nd.salt), 'decrypt');
        }
        let off = 0; const ch = [];
        for (let i = 0; i < nd.chunkSizes.length; i++) {
            let b = await raw.slice(off, off + nd.chunkSizes[i]).arrayBuffer(); off += nd.chunkSizes[i];
            if (nd.encrypted) b = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(nd.ivs[i]) }, key, b);
            if (nd.compressed) b = await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
            ch.push(new Uint8Array(b));
        }
        return new Blob(ch, { type: nd.mime });
    } catch (e) { console.error(e); return null; }
};

const add = async (file, pid, pwd, opts = {}) => {
    const name = await uniq(cleanName(file.name || 'untitled') || 'untitled', pid, opts.exclude);
    const nd = {
        id: uid(), parentId: pid, name,
        kind: 'file', mime: file.type || 'application/octet-stream',
        size: file.size, compSize: 0, compressed: false,
        encrypted: !!pwd, encVer: 2, salt: null, ivs: [], chunkSizes: [],
        thumb: null, hash: null,
        created: opts.created || Date.now(), modified: file.lastModified || Date.now()
    };
    if (opts.hint) nd.hint = opts.hint;
    if (opts.ro) nd.ro = true;
    if (opts.tag) nd.tag = opts.tag;
    await req(sto(N, 'readwrite').add(nd));
    await proc(file, pwd, nd);
    nd.hash = await hashBlob(file);
    await req(sto(N, 'readwrite').put(nd));
    return nd;
};

const moveToTrash = async id => {
    const n = await node(id);
    if (!n || n.parentId === TRASH) return;
    n.origParent = n.parentId; n.parentId = TRASH; n.modified = Date.now();
    await put(n);
};

const restoreNode = async id => {
    const n = await node(id);
    if (!n) return;
    let pid = n.origParent || R;
    if (pid !== R && !(await node(pid))) pid = R;
    n.parentId = pid; delete n.origParent;
    n.name = await uniq(n.name, pid, n.id);
    await put(n);
};

const randBlob = len => {
    const parts = [];
    for (let o = 0; o < len; o += 1048576) {
        const a = new Uint8Array(Math.min(1048576, len - o));
        for (let p = 0; p < a.length; p += 65536) crypto.getRandomValues(a.subarray(p, Math.min(p + 65536, a.length)));
        parts.push(a);
    }
    return new Blob(parts);
};
const shredNode = async id => {
    const n = await node(id);
    if (!n) return;
    for (const c of await list(id)) await shredNode(c.id);
    if (n.kind === 'file') {
        const len = Math.min(n.compSize || n.size || 0, 32 * 1024 * 1024);
        if (len) for (let i = 0; i < 3; i++) await writeBlob(id, randBlob(len));
        await deleteBlob(id);
    }
    await req(sto(N, 'readwrite').delete(id));
};

const clean = n => ({
    id: n.id, name: n.name, kind: n.kind, size: n.size || 0,
    mime: n.mime || '', created: n.created || 0, modified: n.modified || 0,
    encrypted: !!n.encrypted, compressed: !!n.compressed,
    hash: n.hash || null, hint: n.hint || null,
    ro: !!n.ro, tag: n.tag || null, isUploading: !!n.isUploading
});

const resolvePath = async p => {
    if (!p || p === '/') return R;
    const parts = p.split('/').filter(Boolean);
    let cur = R;
    for (const part of parts) {
        const kids = await list(cur);
        const found = kids.find(k => k.name === part);
        if (!found) return null;
        cur = found.id;
    }
    return cur;
};

const resolve = async target => {
    if (!target) return R;
    if (typeof target === 'string' && target.startsWith('/')) return resolvePath(target);
    return target;
};

const pathOf = async id => {
    if (id === R) return '/';
    if (id === TRASH) return '/Trash';
    const parts = [];
    let cur = id, g = 0;
    while (cur && cur !== R && cur !== TRASH && g++ < 500) {
        const n = await node(cur);
        if (!n) break;
        parts.unshift(n.name);
        cur = n.parentId;
    }
    return (cur === TRASH ? '/Trash/' : '/') + parts.join('/');
};

const VFS = {
    async init() {
        await mountStorage();
        db = await openIDB();
        db.onversionchange = () => db.close();
        useWorker();
        try { await navigator.storage.persist(); } catch (e) {}
        return activeBackend;
    },
    get backend() { return activeBackend; },
    get root() { return R; },
    get trash() { return TRASH; },

    async list(target) {
        const id = await resolve(target);
        if (!id) return [];
        return (await list(id)).map(clean);
    },
    async getNode(id) {
        const n = await node(await resolve(id));
        return n ? clean(n) : null;
    },
    async read(target, opts = {}) {
        const id = await resolve(target);
        if (!id) throw new Error('Not found');
        const nd = await node(id);
        if (!nd || nd.kind !== 'file') throw new Error('Not a file');
        if (nd.encrypted && !opts.password) {
            const err = new Error('Password required');
            err.code = 'NEED_PASSWORD'; err.hint = nd.hint || '';
            throw err;
        }
        const blob = await getBlob(nd, opts.password);
        if (!blob) throw new Error('File data missing');
        return { blob, pwd: opts.password || null };
    },
    async readText(target, opts = {}) {
        const r = await this.read(target, opts);
        return r.blob.text();
    },
    async write(path, blob, opts = {}) {
        const parentPath = path.replace(/\/[^/]*$/, '') || '/';
        const name = path.replace(/.*\//, '');
        const pid = await resolvePath(parentPath);
        if (!pid) throw new Error('Parent not found');
        const kids = await list(pid);
        const existing = kids.find(k => k.name === name && k.kind === 'file');
        if (existing) {
            await deleteBlob(existing.id);
            existing.size = blob.size;
            existing.mime = blob.type || 'application/octet-stream';
            existing.encrypted = !!opts.password;
            existing.compressed = false;
            existing.ivs = []; existing.chunkSizes = []; existing.compSize = 0;
            existing.modified = Date.now();
            await put(existing);
            await proc(new File([blob], name, { type: blob.type }), opts.password, existing);
            existing.hash = await hashBlob(blob);
            await put(existing);
            return clean(existing);
        }
        return clean(await add(new File([blob], name, { type: blob.type }), pid, opts.password, opts));
    },
    async add(file, parent, opts = {}) {
        const pid = await resolve(parent);
        if (!pid) throw new Error('Parent not found');
        return clean(await add(file, pid, opts.password, opts));
    },
    async mkdirAt(parentId, name) {
        const pid = await resolve(parentId);
        const nd = { id: uid(), parentId: pid, name: await uniq(name, pid), kind: 'folder', size: 0, compSize: 0, created: Date.now(), modified: Date.now() };
        await req(sto(N, 'readwrite').add(nd));
        return clean(nd);
    },
    async mkdir(path, opts = {}) {
        if (opts.recursive) {
            let cur = R;
            for (const part of path.split('/').filter(Boolean)) {
                const kids = await list(cur);
                let found = kids.find(k => k.name === part && k.kind === 'folder');
                if (!found) {
                    found = { id: uid(), parentId: cur, name: part, kind: 'folder', size: 0, compSize: 0, created: Date.now(), modified: Date.now() };
                    await req(sto(N, 'readwrite').add(found));
                }
                cur = found.id;
            }
            return clean(await node(cur));
        }
        const parentPath = path.replace(/\/[^/]*$/, '') || '/';
        const name = path.replace(/.*\//, '');
        const pid = await resolvePath(parentPath);
        if (!pid) throw new Error('Parent not found');
        return this.mkdirAt(pid, name);
    },
    async put(n) {
        const existing = n.id && await req(sto(N).get(n.id));
        const merged = existing ? { ...existing, ...n, modified: Date.now() } : n;
        await req(sto(N, 'readwrite').put(merged));
        return clean(merged);
    },
    async update(id, changes) {
        const n = await node(await resolve(id));
        if (!n) throw new Error('Not found');
        if (changes.name && changes.name !== n.name) changes.name = await uniq(changes.name, n.parentId, n.id);
        Object.assign(n, changes, { modified: Date.now() });
        await put(n);
        return clean(n);
    },
    async remove(id) { await del(await resolve(id)); },
    async uniq(name, pid, exclude) { return await uniq(name, await resolve(pid), exclude); },
    async isInside(id, anc) { return await isInside(await resolve(id), await resolve(anc)); },
    async moveToTrash(id) { await moveToTrash(await resolve(id)); },
    async restore(id) { await restoreNode(await resolve(id)); },
    async shred(id) { await shredNode(await resolve(id)); },
    async hash(blob) { return await hashBlob(blob); },
    async pathOf(id) { return await pathOf(await resolve(id)); },
    async copy(id, targetParent) {
        const src = await node(await resolve(id));
        const pid = await resolve(targetParent);
        if (!src || !pid) throw new Error('Not found');
        const copyRec = async (n, pid) => {
            const nn = { ...n, id: uid(), parentId: pid, name: await uniq(n.name, pid), created: Date.now(), modified: Date.now() };
            await req(sto(N, 'readwrite').add(nn));
            if (n.kind === 'folder') {
                for (const k of await list(n.id)) await copyRec(k, nn.id);
            } else {
                const raw = await readBlob(n.id);
                if (raw) await writeBlob(nn.id, raw);
            }
            return nn;
        };
        return clean(await copyRec(src, pid));
    },
    async estimate() {
        try {
            const e = await navigator.storage.estimate();
            return { usage: e.usage || 0, quota: e.quota || 0 };
        } catch (e) { return { usage: 0, quota: 0 }; }
    }
};

window.VFS = VFS;
})();
