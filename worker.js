// Chunk processor: gzip then AES-GCM. Key cached per (salt,password).
const KDF_ITER = 600000;
let cache = { id: null, key: null };
const hexToBytes = h => new Uint8Array(h.match(/.{1,2}/g).map(b => parseInt(b, 16)));

const getKey = async (password, saltHex) => {
    const id = saltHex + '|' + password;
    if (cache.id === id) return cache.key;
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt: hexToBytes(saltHex), iterations: KDF_ITER, hash: 'SHA-256' },
        base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']
    );
    cache = { id, key };
    return key;
};

self.onmessage = async (e) => {
    const { chunk, compress, password, saltHex, ivHex } = e.data;
    try {
        let buf = chunk;
        if (compress) {
            buf = await new Response(new Blob([buf]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
        }
        if (password) {
            const key = await getKey(password, saltHex);
            buf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: hexToBytes(ivHex) }, key, buf);
        }
        self.postMessage({ ok: true, buf }, [buf]);
    } catch (err) {
        self.postMessage({ ok: false, error: err.message });
    }
};
