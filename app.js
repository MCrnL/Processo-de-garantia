(() => {
'use strict';

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
  trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
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
  mppts: [{ modules: '', strings: 2 }, { modules: '', strings: 2 }],
  vals: {}, reviewed: false, factory: null,
  open: { data: true, inst: true, ca: false, cc: false, pe: false, add: false }
});
let state = defaultState();
const blobs = new Map();   // id do item -> Blob (JPEG)
const urls = new Map();    // id do item -> object URL da miniatura
let pending = null;        // item que está recebendo a foto

let saveTimer;
const save = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => safe(() => idb('kv', 'readwrite', st => st.put(JSON.stringify(state), 'state'))), 250);
};

/* ---------- montagem do checklist ---------- */
function buildSections(s) {
  const inst = [
    ['inv_frente', 'Frente do inversor, mostrando os arredores', 'inversor_frente'],
    ['inv_etiqueta', 'Etiqueta com número de série e modelo do inversor', 'inversor_etiqueta'],
    ['inv_garantia', 'Selo de garantia do inversor', 'inversor_selo_garantia'],
    ['cc_conectado', 'Conexões CC do inversor, cabos conectados', 'conexoes_CC_conectadas'],
    ['cc_desconectado', 'Conexões CC do inversor, cabos desconectados', 'conexoes_CC_desconectadas'],
    ['ca_sem_tampa', 'Conexões CA do inversor, sem a tampa de proteção', 'conexoes_CA_sem_tampa'],
    ['protecoes', 'Proteções CC e CA (QGBT e string box abertos)', 'protecoes_CC_CA']
  ].map(([id, label, file]) => ({ id, label, file }));

  const m = (id, label, file) => ({ id, label, file, measure: true });
  const caGroups = s.phases === 'tri' ? [
    { title: 'Entre fases', items: [
      m('ca_l1l2', 'Fase L1 e fase L2', 'L1_L2'),
      m('ca_l2l3', 'Fase L2 e fase L3', 'L2_L3'),
      m('ca_l1l3', 'Fase L1 e fase L3', 'L1_L3')] },
    { title: 'Entre fase e neutro', items: [
      m('ca_l1n', 'Fase L1 e neutro', 'L1_N'),
      m('ca_l2n', 'Fase L2 e neutro', 'L2_N'),
      m('ca_l3n', 'Fase L3 e neutro', 'L3_N')] },
    { title: 'Entre neutro e terra', items: [m('ca_nt', 'Neutro e terra', 'N_PE')] }
  ] : [
    { title: 'Entre fase e neutro', items: [m('ca_fn', 'Fase e neutro', 'F_N')] },
    { title: 'Entre neutro e terra', items: [m('ca_nt', 'Neutro e terra', 'N_PE')] }
  ];

  const ccGroups = [], peGroups = [];
  s.mppts.forEach((mp, i) => {
    const ccItems = [], peItems = [];
    for (let j = 0; j < mp.strings; j++) {
      ccItems.push(m(`cc_${i + 1}_${j + 1}`, `String ${j + 1}`, `MPPT${i + 1}_String${j + 1}`));
      peItems.push(m(`pp_${i + 1}_${j + 1}`, `Positivo da string ${j + 1} e terra da carcaça`, `MPPT${i + 1}_String${j + 1}_positivo_terra`));
      peItems.push(m(`pn_${i + 1}_${j + 1}`, `Negativo da string ${j + 1} e terra da carcaça`, `MPPT${i + 1}_String${j + 1}_negativo_terra`));
    }
    ccGroups.push({ title: `MPPT ${i + 1}`, items: ccItems });
    peGroups.push({ title: `MPPT ${i + 1}`, items: peItems });
  });

  return [
    { id: 'inst', title: 'Fotos da instalação', folder: '1_instalacao', groups: [{ title: '', items: inst }] },
    { id: 'ca', title: 'Tensão CA', folder: '2_tensao_CA', groups: caGroups },
    { id: 'cc', title: 'Tensão CC das strings', folder: '3_tensao_CC_strings', groups: ccGroups },
    { id: 'pe', title: 'Tensão CC entre PV e terra', folder: '4_tensao_CC_PV_terra', groups: peGroups }
  ];
}

const dataFields = s => [
  { label: 'Nome da UFV', v: s.ufv },
  { label: 'Marca dos módulos', v: s.modBrand },
  { label: 'Modelo dos módulos', v: s.modModel },
  { label: 'Potência dos módulos', v: s.modPower },
  ...s.mppts.map((mp, i) => ({ label: `Quantidade de módulos no MPPT ${i + 1}`, v: mp.modules }))
];

function stats() {
  const secs = buildSections(state);
  const items = secs.flatMap(sec => sec.groups.flatMap(g => g.items.map(it => ({ ...it, sec: sec.title, group: g.title }))));
  const df = dataFields(state);
  const photosDone = items.filter(i => blobs.has(i.id)).length;
  const dataDone = df.filter(f => filled(f.v)).length;
  return { secs, items, df, photosDone, dataDone, done: photosDone + dataDone, total: items.length + df.length };
}
const secCount = (sec) => {
  const its = sec.groups.flatMap(g => g.items);
  return [its.filter(i => blobs.has(i.id)).length, its.length];
};

/* ---------- fotos ---------- */
const urlFor = id => {
  if (!urls.has(id)) urls.set(id, URL.createObjectURL(blobs.get(id)));
  return urls.get(id);
};
const revoke = id => { if (urls.has(id)) { URL.revokeObjectURL(urls.get(id)); urls.delete(id); } };
const removePhoto = async id => {
  blobs.delete(id); revoke(id);
  await safe(() => idb('photos', 'readwrite', st => st.delete(id)));
};

async function compress(file) {
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
  c.getContext('2d').drawImage(bmp, 0, 0, w, h);
  if (bmp.close) bmp.close();
  return new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('toBlob')), 'image/jpeg', 0.82));
}

async function onFile(e) {
  const f = e.target.files[0]; e.target.value = '';
  const id = pending;
  if (!f || !id) return;
  try {
    toast('Processando foto…');
    const blob = await compress(f);
    await safe(() => idb('photos', 'readwrite', st => st.put(blob, id)));
    blobs.set(id, blob); revoke(id);
    render(); toast('Foto salva');
  } catch (err) { console.error(err); toast('Não foi possível ler essa foto'); }
}

/* ---------- interface ---------- */
let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
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
  const has = blobs.has(it.id);
  const val = state.vals[it.id] || '';
  return `<li class="item${has ? ' done' : ''}" data-id="${it.id}">
    <button class="thumb" type="button" data-act="view" ${has ? '' : 'disabled'} aria-label="Ver foto">${has ? `<img src="${urlFor(it.id)}" alt="">` : ICON.camera}${has ? `<span class="tick">${ICON.check}</span>` : ''}</button>
    <div>
      <div class="lbl">${esc(it.label)}</div>
      <div class="actions">
        <button class="btn${has ? '' : ' primary'}" type="button" data-act="cam">${ICON.camera}<span>${has ? 'Refazer' : 'Tirar foto'}</span></button>
        <button class="btn" type="button" data-act="gal">${ICON.image}<span>Galeria</span></button>
        ${has ? `<button class="btn icon" type="button" data-act="del" aria-label="Remover foto">${ICON.trash}</button>` : ''}
      </div>
      ${it.measure ? `<label class="val"><span>Valor medido</span><input type="text" inputmode="decimal" autocomplete="off" placeholder="0,0" data-val="${it.id}" value="${esc(val)}"><em>V</em></label>` : ''}
    </div>
  </li>`;
}

function renderSection(sec) {
  const [d, t] = secCount(sec);
  const groups = sec.groups.map(g =>
    `${g.title ? `<div class="gtitle">${esc(g.title)}</div>` : ''}<ul class="items">${g.items.map(renderItem).join('')}</ul>`).join('');
  return `<details class="sec" data-sec="${sec.id}"${state.open[sec.id] ? ' open' : ''}>
    <summary><span class="sname">${esc(sec.title)}</span><span class="pill${d === t ? ' ok' : ''}" data-pill="${sec.id}">${d}/${t}</span></summary>
    ${groups}</details>`;
}

function renderData(st) {
  const dd = st.dataDone, dt = st.df.length;
  const mp = state.mppts.map((m, i) => `
    <div class="mppt">
      <strong>MPPT ${i + 1}</strong>
      <div class="cols">
        <div class="field"><label for="mod${i}">Quantidade de módulos</label>
          <input id="mod${i}" type="text" inputmode="numeric" autocomplete="off" data-mppt="${i}" data-mf="modules" value="${esc(m.modules)}"></div>
        <div class="field"><label>Strings neste MPPT</label>
          <div class="stepper"><button type="button" data-act="str-dec" data-i="${i}" aria-label="Menos uma string">−</button><output>${m.strings}</output><button type="button" data-act="str-inc" data-i="${i}" aria-label="Mais uma string">+</button></div></div>
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
      <div class="rowline"><span>Quantidade de MPPTs</span>
        <div class="stepper"><button type="button" data-act="mppt-dec" aria-label="Menos um MPPT">−</button><output>${state.mppts.length}</output><button type="button" data-act="mppt-inc" aria-label="Mais um MPPT">+</button></div></div>
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
    '<button class="linkbtn" type="button" data-act="reset">Iniciar nova vistoria</button>';
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
  set('data', st.dataDone, st.df.length);
  st.secs.forEach(sec => { const [d, t] = secCount(sec); set(sec.id, d, t); });
}

/* ---------- mudanças de estrutura (MPPT, strings, ligação CA) ---------- */
async function change(mutator) {
  const before = JSON.parse(JSON.stringify(state));
  mutator(state);
  const valid = new Set(stats().items.map(i => i.id));
  const orphans = [...blobs.keys()].filter(k => !valid.has(k));
  if (orphans.length) {
    const ok = await confirmBox('Remover itens do checklist?',
      `Essa mudança tira ${orphans.length} ${orphans.length > 1 ? 'itens que já têm foto' : 'item que já tem foto'}. As fotos desses itens serão apagadas.`, 'Remover', true);
    if (!ok) { state = before; render(); return; }
    for (const k of orphans) await removePhoto(k);
  }
  Object.keys(state.vals).forEach(k => { if (!valid.has(k)) delete state.vals[k]; });
  save(); render();
}

/* ---------- exportação ---------- */
function buildReport(st) {
  const s = state;
  const missing = [
    ...st.df.filter(f => !filled(f.v)).map(f => f.label),
    ...st.items.filter(i => !blobs.has(i.id)).map(i => `${i.sec}${i.group ? ' / ' + i.group : ''} / ${i.label}`)
  ];
  const yn = v => v === 'sim' ? 'Sim' : v === 'nao' ? 'Não' : 'Não informado';
  const L = [];
  L.push('VISTORIA DE INVERSOR');
  L.push(`UFV: ${s.ufv || '—'}`);
  L.push(`Data da vistoria: ${fmtDate(s.date) || '—'}`);
  L.push(`Gerado em: ${new Date().toLocaleString('pt-BR')}`);
  L.push('', 'MÓDULOS FV');
  L.push(`Marca: ${s.modBrand || '—'}`, `Modelo: ${s.modModel || '—'}`, `Potência: ${s.modPower ? s.modPower + ' Wp' : '—'}`);
  L.push('', 'MPPTs');
  s.mppts.forEach((m, i) => L.push(`MPPT ${i + 1}: ${m.modules || '—'} módulos, ${m.strings} ${m.strings > 1 ? 'strings' : 'string'}`));
  L.push('', `Ligação CA: ${s.phases === 'tri' ? 'Trifásica' : 'Monofásica'}`);
  const meas = st.items.filter(i => i.measure && filled(s.vals[i.id]));
  if (meas.length) {
    L.push('', 'VALORES MEDIDOS (V)');
    meas.forEach(i => L.push(`${i.sec} / ${i.group ? i.group + ' / ' : ''}${i.label}: ${s.vals[i.id]}`));
  }
  L.push('', 'ADICIONAL');
  L.push(`Fotos revisadas pelo Suporte O&M: ${s.reviewed ? 'Sim' : 'Não'}`);
  L.push(`Testes executados em contato com a fabricante do inversor: ${yn(s.factory)}`);
  if (filled(s.obs)) L.push('', 'OBSERVAÇÕES', s.obs.trim());
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
    const s = state;
    const rootName = `vistoria_${slug(s.ufv) || 'sem_nome'}_${s.date || todayISO()}`;
    const zip = new JSZip();
    const root = zip.folder(rootName);
    const itens = [];
    st.secs.forEach(sec => {
      const dir = root.folder(sec.folder);
      let n = 0;
      sec.groups.forEach(g => g.items.forEach(it => {
        n++;
        const file = `${pad2(n)}_${slug(it.file)}.jpg`;
        const b = blobs.get(it.id);
        if (b) dir.file(file, b);
        itens.push({ secao: sec.title, grupo: g.title || null, item: it.label, arquivo: b ? `${sec.folder}/${file}` : null,
          valor_v: it.measure && filled(s.vals[it.id]) ? s.vals[it.id] : null });
      }));
    });
    root.file('dados.txt', txt);
    root.file('dados.json', JSON.stringify({
      ufv: s.ufv, data: s.date, gerado_em: new Date().toISOString(),
      modulos: { marca: s.modBrand, modelo: s.modModel, potencia_wp: s.modPower },
      ligacao_ca: s.phases === 'tri' ? 'trifasica' : 'monofasica',
      mppts: s.mppts.map((m, i) => ({ mppt: i + 1, modulos: m.modules, strings: m.strings })),
      adicional: { fotos_revisadas_suporte_om: !!s.reviewed, testes_com_fabricante: s.factory },
      observacoes: s.obs, itens, faltando: missing
    }, null, 2));
    const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' }, m => { btn.firstChild.textContent = `Gerando ${Math.round(m.percent)}% `; });
    const name = `${rootName}.zip`;
    const file = new File([blob], name, { type: 'application/zip' });
    const canShare = !!(navigator.canShare && navigator.canShare({ files: [file] }));
    const actions = [{ label: 'Fechar', value: 0 }, { label: 'Baixar', kind: canShare ? '' : 'primary', run: () => download(blob, name) }];
    if (canShare) actions.push({ label: 'Compartilhar', kind: 'primary', run: () => { navigator.share({ files: [file], title: name }).catch(() => {}); } });
    await sheet({ title: 'ZIP pronto', lines: [name, `${st.photosDone} fotos · ${(blob.size / 1048576).toFixed(1)} MB`], actions });
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
  const act = b.dataset.act, id = b.closest('.item')?.dataset.id;
  switch (act) {
    case 'cam': pending = id; $('#camIn').click(); break;
    case 'gal': pending = id; $('#galIn').click(); break;
    case 'view': $('#view img').src = urlFor(id); $('#view').hidden = false; break;
    case 'close-view': $('#view').hidden = true; break;
    case 'del':
      if (await confirmBox('Remover foto?', itemLabel(id), 'Remover', true)) { await removePhoto(id); render(); }
      break;
    case 'phases': if (state.phases !== b.dataset.v) change(s => { s.phases = b.dataset.v; }); break;
    case 'factory': state.factory = state.factory === b.dataset.v ? null : b.dataset.v; save(); render(); break;
    case 'mppt-inc': change(s => { if (s.mppts.length < 12) s.mppts.push({ modules: '', strings: s.mppts[s.mppts.length - 1].strings }); }); break;
    case 'mppt-dec': change(s => { if (s.mppts.length > 1) s.mppts.pop(); }); break;
    case 'str-inc': change(s => { const m = s.mppts[+b.dataset.i]; if (m.strings < 8) m.strings++; }); break;
    case 'str-dec': change(s => { const m = s.mppts[+b.dataset.i]; if (m.strings > 1) m.strings--; }); break;
    case 'reset':
      if (await confirmBox('Iniciar nova vistoria?', 'Isso apaga todas as fotos e dados da vistoria atual deste aparelho. Gere o ZIP antes, se ainda precisar dele.', 'Apagar e começar', true)) {
        for (const k of [...blobs.keys()]) await removePhoto(k);
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
  else if (d.val) state.vals[d.val] = t.value;
  else return;
  save(); updateProgress();
});
document.addEventListener('change', e => { if (e.target.dataset.flag === 'reviewed') { state.reviewed = e.target.checked; save(); } });
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
    } catch (e) { /* mantém o estado padrão */ }
  }
  const keys = await safe(() => idb('photos', 'readonly', st => st.getAllKeys())) || [];
  const vals = await safe(() => idb('photos', 'readonly', st => st.getAll())) || [];
  keys.forEach((k, i) => { if (vals[i]) blobs.set(k, vals[i]); });
  render();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();

})();
