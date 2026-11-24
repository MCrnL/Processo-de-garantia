(() => {
'use strict';
const APP_VERSION = 6;

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
  invBrand: '', invModel: '', invSN: '',
  na: {},                    // itens marcados como "não aplicável"
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
  await safe(() => idb('photos', 'readwrite', st => st.put(blob, pkey(id, n))));
  list.push({ n, blob }); photos.set(id, list);
}
async function removePhoto(id, n) {
  revoke(id, n);
  await safe(() => idb('photos', 'readwrite', st => st.delete(pkey(id, n))));
  const left = plist(id).filter(p => p.n !== n);
  if (left.length) photos.set(id, left); else photos.delete(id);
}
const removeAll = async id => { for (const p of [...plist(id)]) await removePhoto(id, p.n); };

let saveTimer;
const save = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => safe(() => idb('kv', 'readwrite', st => st.put(JSON.stringify(state), 'state'))), 250);
};

/* ---------- strings: numeração contínua no inversor ---------- */
function stringNums(s) {
  let g = 0;
  return s.mppts.map(m => { const a = []; for (let j = 0; j < m.strings; j++) a.push(++g); return a; });
}
const strLabel = nums => nums.length === 1
  ? `String ${nums[0]}`
  : `Strings ${nums.slice(0, -1).join(', ')} e ${nums[nums.length - 1]}`;

/* ---------- montagem do checklist ---------- */
const NOTE_FN = 'Se não houver neutro, teste entre fase e terra';
function buildSections(s) {
  const inst = [
    ['inv_frente', 'Frente do inversor, mostrando os arredores', 'inversor_frente'],
    ['inv_etiqueta', 'Etiqueta com número de série e modelo do inversor', 'inversor_etiqueta'],
    ['inv_garantia', 'Selo de garantia do inversor', 'inversor_selo_garantia', true],
    ['cc_conectado', 'Conexões CC do inversor, cabos conectados', 'conexoes_CC_conectadas'],
    ['cc_desconectado', 'Conexões CC do inversor, cabos desconectados', 'conexoes_CC_desconectadas'],
    ['ca_sem_tampa', 'Conexões CA do inversor, sem a tampa de proteção', 'conexoes_CA_sem_tampa'],
    ['protecoes', 'Proteções CC e CA (QGBT e string box abertos)', 'protecoes_CC_CA']
  ].map(([id, label, file, optional]) => ({ id, label, file, optional: !!optional }));

  const m = (id, label, file, mppt) => ({ id, label, file, mppt });
  const opt = it => ({ ...it, optional: true });
  const caGroups = s.phases === 'tri' ? [
    { title: 'Entre fases', items: [
      m('ca_l1l2', 'Fase L1 e fase L2', 'L1_L2'),
      m('ca_l2l3', 'Fase L2 e fase L3', 'L2_L3'),
      m('ca_l1l3', 'Fase L1 e fase L3', 'L1_L3')] },
    { title: 'Entre fase e neutro', note: NOTE_FN, items: [
      m('ca_l1n', 'Fase L1 e neutro', 'L1_N'),
      m('ca_l2n', 'Fase L2 e neutro', 'L2_N'),
      m('ca_l3n', 'Fase L3 e neutro', 'L3_N')] },
    { title: 'Entre neutro e terra', items: [opt(m('ca_nt', 'Neutro e terra', 'N_PE'))] }
  ] : [
    { title: 'Entre fase e neutro', note: NOTE_FN, items: [m('ca_fn', 'Fase e neutro', 'F_N')] },
    { title: 'Entre neutro e terra', items: [opt(m('ca_nt', 'Neutro e terra', 'N_PE'))] }
  ];

  const ccItems = [], peItems = [];
  const nums = stringNums(s);
  s.mppts.forEach((mp, i) => {
    nums[i].forEach((num, j) => {
      const base = `String${pad2(num)}`;
      ccItems.push(m(`cc_${i + 1}_${j + 1}`, `String ${num}`, base, i + 1));
      peItems.push(m(`pp_${i + 1}_${j + 1}`, `Teste de Flutuação String ${num} Positivo`, `${base}_flutuacao_positivo`, i + 1));
      peItems.push(m(`pn_${i + 1}_${j + 1}`, `Teste de Flutuação String ${num} Negativo`, `${base}_flutuacao_negativo`, i + 1));
    });
  });
  const ccGroups = [{ title: '', items: ccItems }], peGroups = [{ title: '', items: peItems }];

  return [
    { id: 'inst', title: 'Fotos da instalação', folder: '1_instalacao', groups: [{ title: '', items: inst }] },
    { id: 'ca', title: 'Tensão CA', folder: '2_tensao_CA', groups: caGroups },
    { id: 'cc', title: 'Tensão CC das strings', folder: '3_tensao_CC_strings', groups: ccGroups },
    { id: 'pe', title: 'Teste de flutuação (PV e terra)', folder: '4_teste_flutuacao_PV_terra', groups: peGroups }
  ];
}

const wmText = (secId, it) =>
  secId === 'inst' ? it.label
  : secId === 'ca' ? `Tensão CA: ${it.label}`
  : secId === 'cc' ? `Tensão CC: ${it.label}`
  : it.label;

const dataFields = s => [
  { label: 'Nome da UFV', v: s.ufv, grp: 'sys' },
  { label: 'Marca dos módulos', v: s.modBrand, grp: 'sys' },
  { label: 'Modelo dos módulos', v: s.modModel, grp: 'sys' },
  { label: 'Potência dos módulos', v: s.modPower, grp: 'sys' },
  ...s.mppts.map((mp, i) => ({ label: `Quantidade de módulos no MPPT ${i + 1}`, v: mp.modules, grp: 'sys' })),
  { label: 'Marca do inversor', v: s.invBrand, grp: 'inv' },
  { label: 'Modelo do inversor', v: s.invModel, grp: 'inv' },
  { label: 'Número de série (SN) do inversor', v: s.invSN, grp: 'inv' }
];

function stats() {
  const secs = buildSections(state);
  const items = secs.flatMap(sec => sec.groups.flatMap(g => g.items.map(it => ({ ...it, sec: sec.title, group: g.title, wm: wmText(sec.id, it), na: !!(it.optional && state.na[it.id]) }))));
  const df = dataFields(state);
  const active = items.filter(i => !i.na);
  const photosDone = active.filter(i => has(i.id)).length;
  const dataDone = df.filter(f => filled(f.v)).length;
  const sys = df.filter(f => f.grp === 'sys');
  return { secs, items, df, photosDone, dataDone, sysDone: sys.filter(f => filled(f.v)).length, sysTotal: sys.length,
    done: photosDone + dataDone, total: active.length + df.length };
}
const secCount = sec => {
  const its = sec.groups.flatMap(g => g.items).filter(i => !(i.optional && state.na[i.id]));
  const inv = sec.id === 'inst' ? dataFields(state).filter(f => f.grp === 'inv') : [];
  return [its.filter(i => has(i.id)).length + inv.filter(f => filled(f.v)).length, its.length + inv.length];
};

/* ---------- localização ---------- */
let geo = null, geoWatch = null, geoState = 'idle';   // idle | wait | ok | off
function setGeoChip() {
  const c = $('#gps'); if (!c) return;
  c.className = 'gps' + (geoState === 'ok' ? ' ok' : geoState === 'off' ? ' off' : '');
  c.textContent = geoState === 'ok' ? `GPS ±${Math.round(geo.acc)} m` : geoState === 'off' ? 'GPS desligado' : 'GPS…';
}
function startGeo() {
  if (geoWatch != null) return;
  if (!navigator.geolocation) { geoState = 'off'; setGeoChip(); return; }
  geoState = 'wait'; setGeoChip();
  try {
    geoWatch = navigator.geolocation.watchPosition(p => {
      geo = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, alt: p.coords.altitude };
      geoState = 'ok'; setGeoChip();
    }, err => {
      if (err.code === 1) { geoState = 'off'; geoWatch = null; }
      setGeoChip();
    }, { enableHighAccuracy: true, maximumAge: 15000, timeout: 30000 });
  } catch (e) { geoState = 'off'; geoWatch = null; setGeoChip(); }
}
const waitGeo = ms => new Promise(res => {
  const t0 = Date.now();
  (function poll() { if (geo || geoState === 'off' || Date.now() - t0 > ms) res(); else setTimeout(poll, 150); })();
});

/* ---------- marca d'água ---------- */
function wrapLines(ctx, text, maxW) {
  const out = []; let cur = '';
  for (const w of String(text).split(' ')) {
    const t = cur ? cur + ' ' + w : w;
    if (cur && ctx.measureText(t).width > maxW) { out.push(cur); cur = w; } else cur = t;
  }
  if (cur) out.push(cur);
  return out;
}
function drawWatermark(ctx, w, h, meta) {
  const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
  const fs = Math.max(22, Math.round(Math.min(w, h) * 0.04));
  const small = Math.round(fs * 0.78), pad = Math.round(fs * 0.7), maxW = w - pad * 2;
  const blocks = [];
  ctx.font = `700 ${fs}px ${FONT}`;
  wrapLines(ctx, meta.title, maxW).forEach(t => blocks.push({ t, size: fs, bold: true }));
  if (filled(meta.ufv)) blocks.push({ t: `UFV: ${meta.ufv.trim()}`, size: small });
  if (meta.geo) {
    blocks.push({ t: `${meta.geo.lat.toFixed(6)}, ${meta.geo.lon.toFixed(6)} (±${Math.round(meta.geo.acc)} m)`, size: small });
    if (meta.geo.alt != null && isFinite(meta.geo.alt)) blocks.push({ t: `Altitude: ${Math.round(meta.geo.alt)} m`, size: small });
  } else blocks.push({ t: meta.src === 'gal' ? 'Foto da galeria, sem GPS' : 'Sem localização', size: small });
  blocks.push({ t: meta.when.toLocaleString('pt-BR'), size: small });

  ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic'; ctx.lineJoin = 'round';
  let y = h - pad;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    ctx.font = `${b.bold ? 700 : 600} ${b.size}px ${FONT}`;
    ctx.lineWidth = Math.max(3, b.size * 0.18);
    ctx.strokeStyle = 'rgba(0,0,0,0.9)'; ctx.fillStyle = '#fff';
    ctx.strokeText(b.t, w - pad, y); ctx.fillText(b.t, w - pad, y);
    y -= Math.round(b.size * 1.28);
  }
}

async function compress(file, meta) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch (e) {
    const u = URL.createObjectURL(file);
    try { bmp = new Image(); bmp.src = u; await bmp.decode(); bmp.width = bmp.naturalWidth; bmp.height = bmp.naturalHeight; }
    finally { setTimeout(() => URL.revokeObjectURL(u), 5000); }
  }
  const max = 1600, sc = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * sc), h = Math.round(bmp.height * sc);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.drawImage(bmp, 0, 0, w, h);
  if (bmp.close) bmp.close();
  drawWatermark(ctx, w, h, meta);
  return new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('toBlob')), 'image/jpeg', 0.85));
}

async function onFile(e) {
  const files = [...e.target.files]; e.target.value = '';
  const id = pending, src = pendingSrc;
  if (!files.length || !id) return;
  try {
    toast('Processando foto…');
    if (src === 'cam') await waitGeo(3000);
    const it = stats().items.find(i => i.id === id);
    for (const f of files) {
      const k = plist(id).length;
      const meta = {
        title: (it ? it.wm : '') + (k > 0 ? ` (foto ${k + 1})` : ''),
        ufv: state.ufv, src,
        when: src === 'cam' ? new Date() : new Date(f.lastModified || Date.now()),
        geo: src === 'cam' ? geo : null
      };
      await addPhoto(id, await compress(f, meta));
    }
    render(); toast(files.length > 1 ? `${files.length} fotos salvas` : 'Foto salva');
  } catch (err) { console.error(err); toast('Não foi possível ler essa foto'); }
}

/* ---------- interface ---------- */
let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

function sheet({ title, lines = [], actions }) {
  return new Promise(res => {
    const el = $('#sheet');
    el.querySelector('h2').textContent = title;
    const body = el.querySelector('.body'); body.innerHTML = '';
    lines.forEach(l => { const p = document.createElement('p'); p.textContent = l; body.append(p); });
    const box = el.querySelector('.acts'); box.innerHTML = '';
    actions.forEach(a => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn' + (a.kind ? ' ' + a.kind : ''); b.textContent = a.label;
      b.onclick = () => { if (a.run) a.run(); el.hidden = true; res(a.value); };
      box.append(b);
    });
    el.hidden = false;
    (box.querySelector('.primary, .danger') || box.querySelector('button')).focus();
  });
}
const confirmBox = (title, text, ok = 'Confirmar', danger = false) =>
  sheet({ title, lines: [text], actions: [{ label: 'Cancelar', value: false }, { label: ok, kind: danger ? 'danger' : 'primary', value: true }] });

const itemLabel = id => (stats().items.find(i => i.id === id) || {}).label || '';

function renderItem(it) {
  const na = !!(it.optional && state.na[it.id]);
  const list = plist(it.id), done = na || list.length > 0;
  const thumbs = list.map(p => `<div class="ph" data-n="${p.n}">
      <button class="pv" type="button" data-act="view" aria-label="Ver foto"><img src="${urlFor(it.id, p.n)}" alt=""></button>
      <button class="px" type="button" data-act="del" aria-label="Remover foto">${ICON.x}</button></div>`).join('');
  const optBox = it.optional ? `<label class="check opt"><input type="checkbox" data-opt="${it.id}"${na ? '' : ' checked'}>Aplicável a este inversor</label>` : '';
  const body = na ? '<div class="nanote">Não se aplica a este inversor</div>' : `
      ${thumbs ? `<div class="thumbs">${thumbs}</div>` : ''}
      <div class="actions">
        <button class="btn${done ? '' : ' primary'}" type="button" data-act="cam">${ICON.camera}<span>${done ? 'Outra foto' : 'Tirar foto'}</span></button>
        <button class="btn" type="button" data-act="gal">${ICON.image}<span>Galeria</span></button>
      </div>`;
  return `<li class="item${done ? ' done' : ''}${na ? ' na' : ''}" data-id="${it.id}">
    <span class="state" aria-hidden="true">${na ? '–' : done ? ICON.check : ''}</span>
    <div class="ibody">
      <div class="lbl">${esc(it.label)}${list.length > 1 && !na ? ` <span class="cnt">${list.length} fotos</span>` : ''}</div>
      ${optBox}${body}
    </div>
  </li>`;
}

function renderInvFields() {
  return `<li class="invfields">
    <div class="t">Dados do inversor</div>
    <div class="grid2">
      <div class="field"><label for="f-ibrand">Marca</label><input id="f-ibrand" type="text" autocomplete="off" data-field="invBrand" value="${esc(state.invBrand)}"></div>
      <div class="field"><label for="f-imodel">Modelo</label><input id="f-imodel" type="text" autocomplete="off" data-field="invModel" value="${esc(state.invModel)}"></div>
    </div>
    <div class="field"><label for="f-isn">Número de série (SN)</label><input id="f-isn" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" data-field="invSN" value="${esc(state.invSN)}"></div>
  </li>`;
}

function renderSection(sec) {
  const [d, t] = secCount(sec);
  const groups = sec.groups.map(g =>
    `${g.title ? `<div class="gtitle">${esc(g.title)}</div>` : ''}${g.note ? `<div class="gnote">${esc(g.note)}</div>` : ''}<ul class="items">${g.items.map(it => (it.id === 'inv_etiqueta' ? renderInvFields() : '') + renderItem(it)).join('')}</ul>`).join('');
  return `<details class="sec" data-sec="${sec.id}"${state.open[sec.id] ? ' open' : ''}>
    <summary><span class="sname">${esc(sec.title)}</span><span class="pill${d === t ? ' ok' : ''}" data-pill="${sec.id}">${d}/${t}</span></summary>
    ${groups}</details>`;
}

const stepper = (dec, inc, value, attrs = '') =>
  `<div class="stepper"><button type="button" data-act="${dec}" ${attrs} aria-label="Diminuir">−</button><output>${value}</output><button type="button" data-act="${inc}" ${attrs} aria-label="Aumentar">+</button></div>`;

function renderData(st) {
  const dd = st.sysDone, dt = st.sysTotal;
  const nums = stringNums(state);
  const mp = state.mppts.map((m, i) => `
    <div class="mppt">
      <strong>MPPT ${i + 1} · ${strLabel(nums[i])}</strong>
      <div class="cols">
        <div class="field"><label for="mod${i}">Quantidade de módulos</label>
          <input id="mod${i}" type="text" inputmode="numeric" autocomplete="off" data-mppt="${i}" data-mf="modules" value="${esc(m.modules)}"></div>
        ${state.sameStrings ? '' : `<div class="field"><label>Strings neste MPPT</label>${stepper('str-dec', 'str-inc', m.strings, `data-i="${i}"`)}</div>`}
      </div>
    </div>`).join('');
  return `<details class="sec" data-sec="data"${state.open.data ? ' open' : ''}>
    <summary><span class="sname">Dados do sistema</span><span class="pill${dd === dt ? ' ok' : ''}" data-pill="data">${dd}/${dt}</span></summary>
    <div class="panel">
      <div class="grid2">
        <div class="field"><label for="f-ufv">Usina (UFV)</label><input id="f-ufv" type="text" autocomplete="off" data-field="ufv" value="${esc(state.ufv)}"></div>
        <div class="field"><label for="f-date">Data da vistoria</label><input id="f-date" type="date" data-field="date" value="${esc(state.date)}"></div>
      </div>
      <div class="grid2">
        <div class="field"><label for="f-brand">Marca dos módulos FV</label><input id="f-brand" type="text" autocomplete="off" data-field="modBrand" value="${esc(state.modBrand)}"></div>
        <div class="field"><label for="f-model">Modelo dos módulos FV</label><input id="f-model" type="text" autocomplete="off" data-field="modModel" value="${esc(state.modModel)}"></div>
      </div>
      <div class="field"><label for="f-power">Potência dos módulos (Wp)</label><input id="f-power" type="text" inputmode="decimal" autocomplete="off" data-field="modPower" value="${esc(state.modPower)}"></div>
      <div class="field"><div class="q">Ligação CA do inversor</div>
        <div class="seg" role="group" aria-label="Ligação CA">
          <button type="button" data-act="phases" data-v="tri" aria-pressed="${state.phases === 'tri'}">Trifásico</button>
          <button type="button" data-act="phases" data-v="mono" aria-pressed="${state.phases === 'mono'}">Monofásico</button>
        </div></div>
      <div class="rowline"><span>Quantidade de MPPTs</span>${stepper('mppt-dec', 'mppt-inc', state.mppts.length)}</div>
      <div class="field"><div class="q">Todos os MPPTs têm a mesma quantidade de strings?</div>
        <div class="seg" role="group" aria-label="Mesma quantidade de strings">
          <button type="button" data-act="same" data-v="sim" aria-pressed="${state.sameStrings}">Sim</button>
          <button type="button" data-act="same" data-v="nao" aria-pressed="${!state.sameStrings}">Não</button>
        </div></div>
      ${state.sameStrings ? `<div class="rowline"><span>Strings por MPPT</span>${stepper('all-dec', 'all-inc', state.mppts[0].strings)}</div>` : ''}
      ${mp}
      <div class="field"><label for="f-obs">Observações</label><textarea id="f-obs" data-field="obs">${esc(state.obs)}</textarea></div>
    </div></details>`;
}

function renderAdd() {
  return `<details class="sec" data-sec="add"${state.open.add ? ' open' : ''}>
    <summary><span class="sname">Adicional</span></summary>
    <div class="panel">
      <label class="check"><input type="checkbox" data-flag="reviewed"${state.reviewed ? ' checked' : ''}>Fotos revisadas pelo Suporte O&amp;M</label>
      <div class="field"><div class="q">Testes executados em contato com a fabricante do inversor?</div>
        <div class="seg" role="group" aria-label="Testes com a fabricante">
          <button type="button" data-act="factory" data-v="sim" aria-pressed="${state.factory === 'sim'}">Sim</button>
          <button type="button" data-act="factory" data-v="nao" aria-pressed="${state.factory === 'nao'}">Não</button>
        </div></div>
    </div></details>`;
}

function render() {
  const y = window.scrollY;
  const st = stats();
  $('#main').innerHTML = renderData(st) + st.secs.map(renderSection).join('') + renderAdd() +
    `<button class="linkbtn" type="button" data-act="reset">Iniciar nova vistoria</button><p class="ver">Versão ${APP_VERSION}</p>`;
  updateProgress(st);
  window.scrollTo(0, y);
}

function updateProgress(st = stats()) {
  $('#count').textContent = `${st.done}/${st.total}`;
  const pct = st.total ? Math.round(st.done / st.total * 100) : 0;
  $('#barfill').style.width = pct + '%';
  $('#bar').classList.toggle('full', pct === 100);
  const missing = st.total - st.done;
  $('#zipsub').textContent = missing ? `faltam ${missing}` : 'tudo pronto';
  const set = (id, d, t) => { const p = document.querySelector(`[data-pill="${id}"]`); if (p) { p.textContent = `${d}/${t}`; p.classList.toggle('ok', d === t); } };
  set('data', st.sysDone, st.sysTotal);
  st.secs.forEach(sec => { const [d, t] = secCount(sec); set(sec.id, d, t); });
}

/* ---------- mudanças de estrutura (MPPT, strings, ligação CA) ---------- */
async function change(mutator) {
  const before = JSON.parse(JSON.stringify(state));
  mutator(state);
  const valid = new Set(stats().items.map(i => i.id));
  const orphans = [...photos.keys()].filter(k => !valid.has(k));
  if (orphans.length) {
    const n = orphans.reduce((a, k) => a + plist(k).length, 0);
    const ok = await confirmBox('Remover itens do checklist?',
      `Essa mudança tira itens que já têm foto. ${n} ${n > 1 ? 'fotos serão apagadas' : 'foto será apagada'}.`, 'Remover', true);
    if (!ok) { state = before; render(); return; }
    for (const k of orphans) await removeAll(k);
  }
  save(); render();
}

/* ---------- exportação ---------- */
function buildReport(st) {
  const s = state, nums = stringNums(s);
  const missing = [
    ...st.df.filter(f => !filled(f.v)).map(f => f.label),
    ...st.items.filter(i => !i.na && !has(i.id)).map(i => `${i.sec}${i.group ? ' / ' + i.group : ''} / ${i.label}`)
  ];
  const yn = v => v === 'sim' ? 'Sim' : v === 'nao' ? 'Não' : 'Não informado';
  const L = [];
  L.push('VISTORIA DE INVERSOR');
  L.push(`UFV: ${s.ufv || '—'}`);
  L.push(`Data da vistoria: ${fmtDate(s.date) || '—'}`);
  L.push(`Gerado em: ${new Date().toLocaleString('pt-BR')}`);
  L.push('', 'MÓDULOS FV');
  L.push(`Marca: ${s.modBrand || '—'}`, `Modelo: ${s.modModel || '—'}`, `Potência: ${s.modPower ? s.modPower + ' Wp' : '—'}`);
  L.push('', 'INVERSOR');
  L.push(`Marca: ${s.invBrand || '—'}`, `Modelo: ${s.invModel || '—'}`, `Número de série (SN): ${s.invSN || '—'}`);
  L.push('', 'MPPTs');
  s.mppts.forEach((m, i) => L.push(`MPPT ${i + 1}: ${m.modules || '—'} módulos, ${strLabel(nums[i])}`));
  L.push('', `Ligação CA: ${s.phases === 'tri' ? 'Trifásica' : 'Monofásica'}`);
  L.push('', 'ADICIONAL');
  L.push(`Fotos revisadas pelo Suporte O&M: ${s.reviewed ? 'Sim' : 'Não'}`);
  L.push(`Testes executados em contato com a fabricante do inversor: ${yn(s.factory)}`);
  if (filled(s.obs)) L.push('', 'OBSERVAÇÕES', s.obs.trim());
  const nas = st.items.filter(i => i.na);
  if (nas.length) { L.push('', 'NÃO SE APLICA'); nas.forEach(i => L.push('- ' + i.label)); }
  if (missing.length) { L.push('', `ITENS FALTANDO (${missing.length})`); missing.forEach(m => L.push('- ' + m)); }
  return { txt: L.join('\n') + '\n', missing };
}

async function exportZip() {
  if (typeof JSZip === 'undefined') { toast('Biblioteca de ZIP não carregou. Recarregue a página.'); return; }
  const st = stats();
  const { txt, missing } = buildReport(st);
  if (missing.length) {
    const shown = missing.slice(0, 5).join('; ');
    const more = missing.length > 5 ? ` e mais ${missing.length - 5}` : '';
    const ok = await confirmBox('Gerar ZIP com itens faltando?', `Faltam ${missing.length}: ${shown}${more}. A lista também vai no arquivo dados.txt.`, 'Gerar mesmo assim');
    if (!ok) return;
  }
  const btn = $('#zipbtn'); btn.disabled = true;
  const label = btn.firstChild.textContent;
  try {
    const s = state, nums = stringNums(s);
    const rootName = `vistoria_${slug(s.ufv) || 'sem_nome'}${filled(s.invSN) ? '_SN' + slug(s.invSN) : ''}_${s.date || todayISO()}`;
    const zip = new JSZip();
    const root = zip.folder(rootName);
    const itens = [];
    let total = 0;
    st.secs.forEach(sec => {
      const dir = root.folder(sec.folder);
      let n = 0;
      sec.groups.forEach(g => g.items.forEach(it => {
        n++;
        const naI = !!(it.optional && state.na[it.id]);
        const list = naI ? [] : plist(it.id), arquivos = [];
        list.forEach((p, k) => {
          const file = `${pad2(n)}_${slug(it.file)}${list.length > 1 ? '_' + (k + 1) : ''}.jpg`;
          dir.file(file, p.blob); arquivos.push(`${sec.folder}/${file}`); total++;
        });
        itens.push({ secao: sec.title, grupo: g.title || null, item: it.label, nao_se_aplica: naI, arquivos });
      }));
    });
    root.file('dados.txt', txt);
    root.file('dados.json', JSON.stringify({
      ufv: s.ufv, data: s.date, gerado_em: new Date().toISOString(),
      inversor: { marca: s.invBrand, modelo: s.invModel, numero_serie: s.invSN },
      modulos: { marca: s.modBrand, modelo: s.modModel, potencia_wp: s.modPower },
      ligacao_ca: s.phases === 'tri' ? 'trifasica' : 'monofasica',
      mppts: s.mppts.map((m, i) => ({ mppt: i + 1, modulos: m.modules, strings: nums[i] })),
      adicional: { fotos_revisadas_suporte_om: !!s.reviewed, testes_com_fabricante: s.factory },
      observacoes: s.obs, itens, faltando: missing
    }, null, 2));
    const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' }, m => { btn.firstChild.textContent = `Gerando ${Math.round(m.percent)}% `; });
    const name = `${rootName}.zip`;
    const file = new File([blob], name, { type: 'application/zip' });
    const canShare = !!(navigator.canShare && navigator.canShare({ files: [file] }));
    const actions = [{ label: 'Fechar', value: 0 }, { label: 'Baixar', kind: canShare ? '' : 'primary', run: () => download(blob, name) }];
    if (canShare) actions.push({ label: 'Compartilhar', kind: 'primary', run: () => { navigator.share({ files: [file], title: name }).catch(() => {}); } });
    await sheet({ title: 'ZIP pronto', lines: [name, `${total} fotos · ${(blob.size / 1048576).toFixed(1)} MB`], actions });
  } catch (err) { console.error(err); toast('Erro ao gerar o ZIP'); }
  finally { btn.disabled = false; btn.firstChild.textContent = label; }
}

function download(blob, name) {
  const u = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = u; a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 60000);
}

/* ---------- eventos ---------- */
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const act = b.dataset.act, id = b.closest('.item')?.dataset.id, ph = b.closest('.ph');
  switch (act) {
    case 'cam': pending = id; pendingSrc = 'cam'; startGeo(); $('#camIn').click(); break;
    case 'gal': pending = id; pendingSrc = 'gal'; $('#galIn').click(); break;
    case 'view': $('#view img').src = urlFor(id, +ph.dataset.n); $('#view').hidden = false; break;
    case 'close-view': $('#view').hidden = true; break;
    case 'del':
      if (await confirmBox('Remover foto?', itemLabel(id), 'Remover', true)) { await removePhoto(id, +ph.dataset.n); render(); }
      break;
    case 'phases': if (state.phases !== b.dataset.v) change(s => { s.phases = b.dataset.v; }); break;
    case 'factory': state.factory = state.factory === b.dataset.v ? null : b.dataset.v; save(); render(); break;
    case 'same': {
      const same = b.dataset.v === 'sim';
      if (same !== state.sameStrings) change(s => { s.sameStrings = same; if (same) { const k = s.mppts[0].strings; s.mppts.forEach(m => { m.strings = k; }); } });
      break;
    }
    case 'mppt-inc': change(s => { if (s.mppts.length < 24) s.mppts.push({ modules: '', strings: s.sameStrings ? s.mppts[0].strings : s.mppts[s.mppts.length - 1].strings }); }); break;
    case 'mppt-dec': change(s => { if (s.mppts.length > 1) s.mppts.pop(); }); break;
    case 'all-inc': change(s => { const k = Math.min(12, s.mppts[0].strings + 1); s.mppts.forEach(m => { m.strings = k; }); }); break;
    case 'all-dec': change(s => { const k = Math.max(1, s.mppts[0].strings - 1); s.mppts.forEach(m => { m.strings = k; }); }); break;
    case 'str-inc': change(s => { const m = s.mppts[+b.dataset.i]; if (m.strings < 12) m.strings++; }); break;
    case 'str-dec': change(s => { const m = s.mppts[+b.dataset.i]; if (m.strings > 1) m.strings--; }); break;
    case 'reset':
      if (await confirmBox('Iniciar nova vistoria?', 'Isso apaga todas as fotos e dados da vistoria atual deste aparelho. Gere o ZIP antes, se ainda precisar dele.', 'Apagar e começar', true)) {
        for (const k of [...photos.keys()]) await removeAll(k);
        state = defaultState(); save(); render(); window.scrollTo(0, 0);
      }
      break;
    case 'zip': exportZip(); break;
  }
});

document.addEventListener('input', e => {
  const t = e.target, d = t.dataset;
  if (d.field) state[d.field] = t.value;
  else if (d.mf) state.mppts[+d.mppt][d.mf] = t.value;
  else return;
  save(); updateProgress();
});
document.addEventListener('change', async e => {
  const t = e.target;
  if (t.dataset.flag === 'reviewed') { state.reviewed = t.checked; save(); }
  else if (t.dataset.opt) {
    const id = t.dataset.opt;
    if (t.checked) delete state.na[id];
    else {
      if (has(id) && !(await confirmBox('Marcar como não aplicável?', `As fotos de "${itemLabel(id)}" serão apagadas.`, 'Apagar fotos', true))) { render(); return; }
      await removeAll(id); state.na[id] = true;
    }
    save(); render();
  }
});
document.addEventListener('toggle', e => {
  const sec = e.target.dataset && e.target.dataset.sec;
  if (sec) { state.open[sec] = e.target.open; save(); }
}, true);
document.addEventListener('keydown', e => { if (e.key === 'Escape') $('#view').hidden = true; });
$('#camIn').addEventListener('change', onFile);
$('#galIn').addEventListener('change', onFile);

/* instalação */
let deferred;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; $('#install').hidden = false; });
$('#install').addEventListener('click', async () => {
  if (!deferred) return;
  deferred.prompt(); await deferred.userChoice; deferred = null; $('#install').hidden = true;
});

/* ---------- início ---------- */
(async function init() {
  const saved = await safe(() => idb('kv', 'readonly', st => st.get('state')));
  if (saved) {
    try {
      const s = JSON.parse(saved);
      state = Object.assign(defaultState(), s);
      state.open = Object.assign(defaultState().open, s.open || {});
      if (!Array.isArray(state.mppts) || !state.mppts.length) state.mppts = defaultState().mppts;
      if (typeof state.sameStrings !== 'boolean') state.sameStrings = state.mppts.every(m => m.strings === state.mppts[0].strings);
      delete state.vals;
    } catch (e) { /* mantém o estado padrão */ }
  }
  const keys = await safe(() => idb('photos', 'readonly', st => st.getAllKeys())) || [];
  const vals = await safe(() => idb('photos', 'readonly', st => st.getAll())) || [];
  keys.forEach((k, i) => {
    if (!vals[i]) return;
    const str = String(k), j = str.lastIndexOf('|');
    const id = j < 0 ? str : str.slice(0, j), n = j < 0 ? 0 : +str.slice(j + 1);
    const list = photos.get(id) || []; list.push({ n, blob: vals[i] }); photos.set(id, list);
  });
  photos.forEach(list => list.sort((a, b) => a.n - b.n));
  render();
  startGeo();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    const had = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (had) toast('Atualização instalada. Feche e abra o app.'); });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(r => r.update()).catch(() => {});
  }
})();

})();
