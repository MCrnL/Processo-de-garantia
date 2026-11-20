(() => {
'use strict';
const APP_VERSION = 3;

/* ---------- utilidades ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const slug = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
const pad2 = n => String(n).padStart(2, '0');
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const fmtDate = iso => iso ? iso.split('-').reverse().join('/') : '';
const filled = v => String(v ?? '').trim() !== '';

const svg = p => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const ICON = {
  camera: svg('<path d="M4 8h3l1.6-2.2h6.8L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.6"/>'),
  image: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M21 16l-5-5-8 9"/>'),
  x: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>')
};

/* ---------- armazenamento local (IndexedDB) ---------- */
let dbp;
const openDB = () => dbp || (dbp = new Promise((res, rej) => {
  const r = indexedDB.open('vistoria', 1);
  r.onupgradeneeded = () => { r.result.createObjectStore('photos'); r.result.createObjectStore('kv'); };
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
}));
const idb = async (store, mode, fn) => {
  const db = await openDB();
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => res(req ? req.result : undefined);
    t.onerror = t.onabort = () => rej(t.error);
  });
};
const safe = async fn => { try { return await fn(); } catch (e) { return undefined; } };

/* ---------- estado ---------- */
const defaultState = () => ({
  ufv: '', date: todayISO(), obs: '',
  modBrand: '', modModel: '', modPower: '',
  phases: 'tri',
  sameStrings: true,
  mppts: [{ modules: '', strings: 2 }, { modules: '', strings: 2 }],
  reviewed: false, factory: null,
  open: { data: true, inst: true, ca: false, cc: false, pe: false, add: false }
});
let state = defaultState();

/* fotos: id do item -> lista de { n, blob }. No IndexedDB a chave é "id|n". */
const photos = new Map();
const urls = new Map();
let pending = null;        // item que está recebendo a foto
let pendingSrc = 'cam';    // 'cam' ou 'gal'

const pkey = (id, n) => n === 0 ? id : `${id}|${n}`;
const plist = id => photos.get(id) || [];
const has = id => plist(id).length > 0;
const urlFor = (id, n) => {
  const k = pkey(id, n);
  if (!urls.has(k)) urls.set(k, URL.createObjectURL(plist(id).find(p => p.n === n).blob));
  return urls.get(k);
};
const revoke = (id, n) => { const k = pkey(id, n); if (urls.has(k)) { URL.revokeObjectURL(urls.get(k)); urls.delete(k); } };
async function addPhoto(id, blob) {
  const list = plist(id);
  const n = list.length ? Math.max(...list.map(p => p.n)) + 1 : 1;