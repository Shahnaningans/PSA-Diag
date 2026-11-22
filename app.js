/* psadiag web — UI: connect, live dashboards, custom dashboard builder, widgets, CSV logging, guidance. */
(function () {
  'use strict';
  const D = window.Diag, C = window.Catalog, P = C.PARAMS, fmt = C.fmt, Dbx = window.Dbx;
  const VERSION = 'psadiag web v1.5 · build 2026-11-22d';   // bump this on every change
  const $ = s => document.querySelector(s);
  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

  const state = {
    transport: null, elm: null, demo: false, mode: 'gearbox', kwp: null, obd: null,
    polling: false, editing: false, rows: null, startTime: 0, period: 250,
    layouts: load('psadiag.layouts') || { gearbox: clone(C.DEFAULTS.gearbox), engine: clone(C.DEFAULTS.engine) },
    ecuInfo: '',
  };
  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function load(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
  function save() { try { localStorage.setItem('psadiag.layouts', JSON.stringify(state.layouts)); } catch (e) {} }

  // ---------------------------------------------------------------- connection
  async function connect(showAll) {
    try {
      setStatus('Connecting…');
      if (state.demo) { state.transport = new DemoTransport(); }
      else state.transport = new D.BleTransport();
      state.elm = new D.Elm327(state.transport);
      if ($('#verbose').checked) state.elm.log = m => logLine(m, 'dim');
      await state.transport.connect(showAll);
      await state.elm.initialise();
      state.transport.onDisconnect = () => { stopPolling(); setStatus('Adapter disconnected'); showScreen('connect'); };
      $('#adapterName').textContent = state.transport.description;
      showScreen('home');
      setStatus('Connected: ' + state.transport.description);
    } catch (e) { setStatus('Could not connect'); alert(e.message || e); }
  }

  async function openMode(mode) {
    state.mode = mode;
    setStatus('Opening ' + mode + '…');
    try {
      state.enginePeugeotKwp = null; state.variant = null;
      if (mode === 'gearbox') {
        state.kwp = new D.Kwp(state.elm, D.GEARBOX);
        const ok = await state.kwp.connect();
        if (!ok) throw new Error('The gearbox did not answer. Ignition on? Adapter plugged in?');
        state.ecu = Dbx.ecuOf(Dbx.GEARBOX);
        state.ecuInfo = 'AL4  0x' + D.hex(D.GEARBOX);
      } else {
        state.obd = new D.Obd(state.elm);
        const ok = await state.obd.connect();
        if (!ok) throw new Error('The engine did not answer standard OBD. Ignition on?');
        state.ecu = null;
        state.ecuInfo = 'Engine OBD · ' + (state.obd.protocol || '');
      }
      buildDashboard();
      showScreen('dash');
      startPolling();
    } catch (e) { setStatus('Failed'); alert(e.message || e); }
  }

  // ---------------------------------------------------------------- polling
  let updaters = [];
  function neededSources() {
    const items = state.layouts[state.mode];
    if (state.mode === 'gearbox') { const s = new Set(); items.forEach(it => (P[it.id].lids || []).forEach(l => s.add(l))); return [...s]; }
    return [...new Set(items.map(it => P[it.id].pid).filter(x => x != null))];
  }

  async function pollOnce() {
    const items = state.layouts[state.mode];
    let getter, all = {};
    if (state.mode === 'gearbox') {
      const map = {};
      for (const lid of neededSources()) { try { map[lid] = await state.kwp.read(lid); } catch (e) { map[lid] = null; } }
      getter = lid => map[lid] || null;
    } else {
      const map = {};
      for (const pid of neededSources()) { try { map[pid] = await state.obd.pid(pid); } catch (e) { map[pid] = null; } }
      getter = pid => map[pid] || null;
    }
    // decode every param in the layout
    const values = {};
    for (const it of items) {
      const p = P[it.id];
      let v = null;
      try { v = state.mode === 'gearbox' ? p.decode(getter) : p.decode(getter(p.pid)); } catch (e) { v = null; }
      values[it.id] = v;
      if (v && v.n != null) all[it.id] = v.n;
    }
    // health + render
    for (const it of items) {
      const p = P[it.id], v = values[it.id];
      let h = null;
      if (v && v.n != null && p.health) h = p.health(v.n, all);
      if (v && v.bad) h = h || { level: 'bad', note: '' };
      if (updaters[it.id]) updaters[it.id](v, h);
    }
    if (state.rows) logRow(values);
    updateFooter();
  }

  async function loop() {
    while (state.polling) {
      const t0 = Date.now();
      try { await pollOnce(); } catch (e) { logLine('poll error: ' + (e.message || e), 'bad'); }
      const dt = Date.now() - t0;
      await D.sleep(Math.max(0, state.period - dt));
    }
  }
  function startPolling() { if (state.polling) return; state.polling = true; state.startTime = Date.now(); $('#stopBtn').textContent = '■ Stop'; loop(); }
  function stopPolling() { state.polling = false; $('#stopBtn').textContent = '▶ Resume'; }

  // ---------------------------------------------------------------- dashboard rendering
  function buildDashboard() {
    const grid = $('#grid'); grid.innerHTML = ''; updaters = {};
    const items = state.layouts[state.mode];
    $('#ecuPill').textContent = state.ecuInfo;
    $('#dashTitle').textContent = state.mode === 'gearbox' ? 'Gearbox live' : 'Engine live';
    // state cards (gear/lever) side by side at the top, then gauges, then switches — like the mockup
    const states = items.filter(it => P[it.id].kind === 'state');
    const gauges = items.filter(it => P[it.id].kind !== 'state' && P[it.id].kind !== 'switch');
    const switches = items.filter(it => P[it.id].kind === 'switch');
    if (states.length) { const row = el('div', 'state-row'); states.forEach(it => row.appendChild(makeTile(it))); grid.appendChild(row); }
    gauges.forEach(it => grid.appendChild(makeTile(it)));
    if (switches.length) {
      const sec = el('div', 'switches'); sec.appendChild(el('div', 'section-h', 'SWITCHES'));
      switches.forEach(it => sec.appendChild(makeSwitchRow(it)));
      grid.appendChild(sec);
    }
    $('#editBtn').textContent = state.editing ? 'Done' : 'Edit';
    renderPalette();
  }

  function makeTile(it) {
    const p = P[it.id];
    const card = el('div', 'tile w-' + it.w + (p.kind === 'state' ? ' accent' : ''));
    card.appendChild(el('div', 'tile-label', p.label));
    const body = el('div', 'tile-body');
    card.appendChild(body);
    let upd;
    if (it.w === 'dial') upd = dialWidget(body, p);
    else if (it.w === 'bar') upd = barWidget(body, p);
    else upd = numberWidget(body, p, it.w === 'state');
    updaters[it.id] = (v, h) => { upd(v, h); card.classList.toggle('warn', h && h.level === 'warn'); card.classList.toggle('bad', h && h.level === 'bad'); };
    if (state.editing) card.appendChild(editControls(it));
    return card;
  }

  function numberWidget(body, p, isState) {
    const val = el('div', 'big'); const unit = el('span', 'unit', p.unit || '');
    const sub = el('div', 'sub'); const note = el('div', 'note');
    const line = el('div', 'val-line'); line.appendChild(val); if (!isState) line.appendChild(unit);
    body.appendChild(line); body.appendChild(sub); body.appendChild(note);
    return (v, h) => {
      if (v == null) { val.textContent = '--'; sub.textContent = ''; note.textContent = ''; return; }
      val.textContent = v.text != null ? v.text : fmt(p, v.n);
      sub.textContent = v.sub || '';
      note.textContent = h ? h.note : '';
    };
  }

  function barWidget(body, p) {
    const line = el('div', 'val-line'); const val = el('div', 'big'); line.appendChild(val); line.appendChild(el('span', 'unit', p.unit || ''));
    const track = el('div', 'bar'); const fill = el('div', 'bar-fill'); track.appendChild(fill);
    const note = el('div', 'note');
    body.appendChild(line); body.appendChild(track); body.appendChild(note);
    return (v, h) => {
      if (v == null || v.n == null) { val.textContent = '--'; fill.style.width = '0'; note.textContent = ''; return; }
      val.textContent = fmt(p, v.n);
      const pct = Math.max(0, Math.min(100, (v.n - p.min) / (p.max - p.min) * 100));
      fill.style.width = pct + '%';
      fill.style.background = h ? (h.level === 'bad' ? 'var(--bad)' : 'var(--warn)') : 'var(--accent)';
      note.textContent = h ? h.note : '';
    };
  }

  function dialWidget(body, p) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', '0 0 100 72'); svg.setAttribute('class', 'dial');
    const cx = 50, cy = 54, r = 40, a0 = 225, a1 = -45; // 270° sweep
    const pt = ang => [cx + r * Math.cos(ang * Math.PI / 180), cy - r * Math.sin(ang * Math.PI / 180)];
    const arc = (from, to, cls) => { const [x0, y0] = pt(from), [x1, y1] = pt(to); const large = Math.abs(to - from) > 180 ? 1 : 0; const pth = document.createElementNS(NS, 'path'); pth.setAttribute('d', `M${x0} ${y0} A${r} ${r} 0 ${large} 1 ${x1} ${y1}`); pth.setAttribute('class', cls); return pth; };
    svg.appendChild(arc(a0, a1, 'dial-track'));
    const prog = arc(a0, a0, 'dial-prog'); svg.appendChild(prog);
    const txt = document.createElementNS(NS, 'text'); txt.setAttribute('x', cx); txt.setAttribute('y', cy - 2); txt.setAttribute('class', 'dial-val'); txt.setAttribute('text-anchor', 'middle');
    const un = document.createElementNS(NS, 'text'); un.setAttribute('x', cx); un.setAttribute('y', cy + 12); un.setAttribute('class', 'dial-unit'); un.setAttribute('text-anchor', 'middle'); un.textContent = p.unit || '';
    svg.appendChild(txt); svg.appendChild(un); body.appendChild(svg);
    const note = el('div', 'note'); body.appendChild(note);
    return (v, h) => {
      if (v == null || v.n == null) { txt.textContent = '--'; note.textContent = ''; return; }
      txt.textContent = fmt(p, v.n);
      const frac = Math.max(0, Math.min(1, (v.n - p.min) / (p.max - p.min)));
      const to = a0 + (a1 - a0) * frac;
      const [x1, y1] = pt(to), [x0, y0] = pt(a0); const large = Math.abs(to - a0) > 180 ? 1 : 0;
      prog.setAttribute('d', `M${x0} ${y0} A${r} ${r} 0 ${large} 1 ${x1} ${y1}`);
      prog.style.stroke = h ? (h.level === 'bad' ? 'var(--bad)' : 'var(--warn)') : 'var(--accent)';
      note.textContent = h ? h.note : '';
    };
  }

  function makeSwitchRow(it) {
    const p = P[it.id];
    const row = el('div', 'sw-row'); row.appendChild(el('div', 'sw-label', p.label));
    const val = el('div', 'sw-val', '--'); row.appendChild(val);
    if (state.editing) row.appendChild(editControls(it, true));
    updaters[it.id] = (v, h) => { val.textContent = v && v.text != null ? v.text : (v && v.n != null ? fmt(p, v.n) : '--'); val.className = 'sw-val' + (h && h.level === 'bad' ? ' bad' : (v && v.bad ? ' bad' : '')); };
    return row;
  }

  // ---------------------------------------------------------------- editing / builder
  function editControls(it, compact) {
    const wrap = el('div', 'edit-ctrls');
    const p = P[it.id];
    (p.widgets || ['number']).forEach(w => {
      const b = el('button', 'wbtn' + (it.w === w ? ' on' : ''), { number: '123', dial: '◔', bar: '▭', state: 'A', switch: '⦿' }[w] || w);
      b.title = w; b.onclick = () => { it.w = w; save(); buildDashboard(); };
      wrap.appendChild(b);
    });
    const up = el('button', 'wbtn', '↑'); up.onclick = () => move(it, -1); wrap.appendChild(up);
    const dn = el('button', 'wbtn', '↓'); dn.onclick = () => move(it, 1); wrap.appendChild(dn);
    const rm = el('button', 'wbtn rm', '×'); rm.onclick = () => { const a = state.layouts[state.mode]; a.splice(a.indexOf(it), 1); save(); buildDashboard(); }; wrap.appendChild(rm);
    return wrap;
  }
  function move(it, dir) { const a = state.layouts[state.mode]; const i = a.indexOf(it); const j = i + dir; if (j < 0 || j >= a.length) return; a.splice(i, 1); a.splice(j, 0, it); save(); buildDashboard(); }

  function renderPalette() {
    const pal = $('#palette'); pal.innerHTML = ''; pal.style.display = state.editing ? 'block' : 'none';
    if (!state.editing) return;
    pal.appendChild(el('div', 'section-h', 'ADD A READING'));
    const inLayout = new Set(state.layouts[state.mode].map(it => it.id));
    Object.keys(P).filter(id => P[id].group === state.mode && !inLayout.has(id)).forEach(id => {
      const b = el('button', 'add-btn', '+ ' + P[id].label);
      b.onclick = () => { state.layouts[state.mode].push({ id, w: (P[id].widgets || ['number'])[0] }); save(); buildDashboard(); };
      pal.appendChild(b);
    });
    const reset = el('button', 'add-btn reset', '↺ Reset to default layout');
    reset.onclick = () => { if (confirm('Reset this dashboard to the default layout?')) { state.layouts[state.mode] = clone(C.DEFAULTS[state.mode]); save(); buildDashboard(); } };
    pal.appendChild(reset);
  }

  // ---------------------------------------------------------------- CSV logging
  function startRec() { state.rows = []; state.recCols = state.layouts[state.mode].map(it => P[it.id].label); $('#recBtn').textContent = '● Recording'; $('#recBtn').classList.add('on'); }
  function logRow(values) {
    const items = state.layouts[state.mode];
    const row = [new Date().toISOString()];
    items.forEach(it => { const v = values[it.id]; row.push(v == null ? '' : (v.text != null && v.n == null ? v.text : (v.n != null ? v.n : ''))); });
    state.rows.push(row);
  }
  function stopRec() {
    if (!state.rows || !state.rows.length) { state.rows = null; $('#recBtn').textContent = '● Record'; $('#recBtn').classList.remove('on'); return; }
    const header = ['time'].concat(state.recCols).map(csv).join(',');
    const body = state.rows.map(r => r.map(x => csv(String(x))).join(',')).join('\n');
    const blob = new Blob([header + '\n' + body], { type: 'text/csv' });
    const a = el('a'); a.href = URL.createObjectURL(blob); a.download = state.mode + '-' + ts() + '.csv'; document.body.appendChild(a); a.click(); a.remove();
    state.rows = null; $('#recBtn').textContent = '● Record'; $('#recBtn').classList.remove('on');
  }
  const csv = s => /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  const ts = () => new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);

  // ---------------------------------------------------------------- misc UI
  function showScreen(name) { document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === 'screen-' + name)); }
  function setStatus(s) { $('#status').textContent = s; }
  function logLine(s, cls) { const box = $('#log'); const d = el('div', cls || ''); d.textContent = s; box.appendChild(d); box.scrollTop = box.scrollHeight; }
  function updateFooter() { const mins = ((Date.now() - state.startTime) / 60000); $('#footMeta').textContent = state.period + ' ms · ' + (mins < 1 ? Math.round(mins * 60) + ' s in' : mins.toFixed(0) + ' min in'); }

  // ---------------------------------------------------------------- wire up
  window.addEventListener('DOMContentLoaded', () => {
    $('#connectBtn').onclick = () => connect(false);
    $('#connectAll').onclick = () => connect(true);
    $('#demo').onchange = e => { state.demo = e.target.checked; };
    $('#goGearbox').onclick = () => openMode('gearbox');
    $('#goEngine').onclick = () => openMode('engine');
    $('#backBtn').onclick = async () => { stopPolling(); try { state.kwp && await state.kwp.disconnect(); } catch (e) {} showScreen('home'); };
    $('#stopBtn').onclick = () => { if (state.polling) stopPolling(); else startPolling(); };
    $('#editBtn').onclick = () => { state.editing = !state.editing; buildDashboard(); };
    $('#toolsBtn').onclick = openTools;
    $('#recBtn').onclick = () => { if (state.rows) stopRec(); else startRec(); };
    $('#logToggle').onclick = () => $('#logPanel').classList.toggle('open');
    document.querySelectorAll('.ver').forEach(e => e.textContent = VERSION);
    showScreen('connect');
  });

  // ---------------------------------------------------------------- tools (faults / tests / service / Peugeot)
  function openTools() {
    stopPolling();
    window.Tools.open({
      kind: state.mode === 'gearbox' ? 'gearbox' : 'engine',
      kwp: state.mode === 'gearbox' ? state.kwp : state.enginePeugeotKwp,
      ecu: state.ecu, obd: state.obd, variant: state.variant, elm: state.elm,
      goPeugeot: goPeugeot,
      restore: restoreFromTools,
    });
  }
  async function goPeugeot() {
    try {
      const kwp = new D.Kwp(state.elm, D.ENGINE);
      if (!(await kwp.connect())) return { ok: false, message: 'The engine did not answer a Peugeot wake-up.' };
      const fe = await kwp.send([0x21, 0xFE]);
      if (!fe.ok) return { ok: false, message: 'The engine refused identification (21 FE). Standard OBD still works.' };
      const rec = Dbx.recognise(fe.ok, Dbx.ENGINE_ECUS);
      const ecu = rec ? Dbx.ecuOf(rec.ecu) : null;
      if (!ecu) return { ok: false, message: 'Engine computer not recognised from its software reference.' };
      state.enginePeugeotKwp = kwp; state.ecu = ecu; state.variant = rec.variant;
      return { ok: true, kwp, ecu, variant: rec.variant };
    } catch (e) { return { ok: false, message: e.message || String(e) }; }
  }
  async function restoreFromTools() {
    showScreen('dash');
    if (state.mode === 'engine' && state.enginePeugeotKwp) {
      // we were in Peugeot mode; return the engine dashboard to standard OBD
      try { await state.enginePeugeotKwp.disconnect(); } catch (e) {}
      state.enginePeugeotKwp = null; state.ecu = null;
      try { await state.obd.connect(); } catch (e) {}
    }
    startPolling();
  }

  // ---------------------------------------------------------------- demo transport (synthetic car, no hardware)
  function DemoTransport() {
    this.description = 'Demo car'; this.buf = ''; let t0 = Date.now();
    const wave = (lo, hi, period, ph) => lo + (hi - lo) * (0.5 + 0.5 * Math.sin((Date.now() - t0) / period * 2 * Math.PI + (ph || 0)));
    let header = '';
    this.connect = async () => {};
    this.disconnect = () => {};
    this.write = async (line) => { this.buf = this._resp(line.trim().toUpperCase()); };
    this.readUntilPrompt = async () => { const r = this.buf; this.buf = ''; return r + '\r>'; };
    const frame = (src, data) => { const b = [0x80 | data.length, 0xF1, src].concat(data); b.push(b.reduce((a, x) => (a + x) & 0xFF, 0)); return b.map(x => x.toString(16).toUpperCase().padStart(2, '0')).join(' '); };
    function engBlock(lid, rpm) {
      if (!window.Dbx) return null;
      const ecu = window.Dbx.ecuOf('J34P'); if (!ecu) return null;
      const bl = window.Dbx.blocks(ecu).find(b => b.lid === lid); if (!bl) return null;
      const ps = (bl.unit.ok || []).filter(p => p.block == null && p.type !== 'BLOCK');
      let maxEnd = 2; ps.forEach(p => { const pos = parseInt(p.pos) || 0, len = parseInt(p.len) || 1; if (pos + len - 1 > maxEnd) maxEnd = pos + len - 1; });
      const b = new Array(maxEnd).fill(0); b[0] = 0x61; b[1] = lid;
      ps.forEach(p => {
        const factor = parseFloat(p.factor); if (!factor) return;
        const name = (p.name || '').toUpperCase(), unit = p.unit || ''; let phys = null;
        if (/REGIME_MOTEUR/.test(name)) phys = rpm;
        else if (/TENSION_BATTERIE/.test(name) || unit[0] === 'V') phys = 14.1;
        else if (/TEMPERATUR/.test(name) || unit.indexOf('C') >= 0) phys = /AIR/.test(name) ? 24 : 85;
        else if (/PRESSION_COLLECTEUR/.test(name)) phys = 340;
        else if (/ANGLE_PAPILLON|POSITION_PEDALE/.test(name)) phys = 6;
        else if (/TEMPS_INJECTION/.test(name)) phys = rpm > 0 ? 3 : 0;
        else return;
        const offs = parseFloat(p.offset) || 0, len = parseInt(p.len) || 1;
        let raw = Math.round((phys - offs) / factor); raw = Math.max(0, Math.min(raw, Math.pow(256, len) - 1));
        const pos = (parseInt(p.pos) || 1) - 1;
        for (let i = 0; i < len; i++) b[pos + i] = (raw >> (8 * (len - 1 - i))) & 0xFF;
      });
      return b;
    }
    // A looping synthetic drive with real gear changes and flare, so recorded demo drives are worth analysing.
    const DSEQ = [[1.5, 0x00, 0], [2, 0x11, 1900], [0.6, 0x12, 2600], [3, 0x22, 1900], [0.6, 0x23, 2600], [3, 0xBB, 2100], [0.6, 0xBC, 2300], [3, 0xCC, 1800], [0.6, 0xC3, 2100], [2, 0x33, 2000], [0.6, 0x32, 1700], [2, 0x22, 1600]];
    const DTOT = DSEQ.reduce((a, s) => a + s[0], 0);
    function driveState() {
      let p = ((Date.now() - t0) / 1000) % DTOT;
      for (const s of DSEQ) { if (p < s[0]) { const settled = (s[1] & 0xF) === (s[1] >> 4); const inr = s[2]; const out = Math.max(380, Math.round(inr * (settled ? 0.85 : 0.7))); return { gearByte: s[1], inRpm: inr, outRpm: s[1] === 0 ? 0 : out, pedal: s[1] === 0 ? 6 : 24 }; } p -= s[0]; }
      return { gearByte: 0x22, inRpm: 1600, outRpm: 1360, pedal: 24 };
    }
    this._resp = (c) => {
      if (c.startsWith('AT')) { if (c.startsWith('ATSH')) header = c.slice(4).replace(/\s/g, '').substr(2, 2); if (c === 'ATSP0') header = ''; if (c === 'ATRV') return '14.1V'; if (c === 'ATZ') return 'ELM327 v1.5'; if (c === 'ATDP') return 'AUTO, ISO 14230-4'; return 'OK'; }
      c = c.replace(/\s+/g, '');   // the adapter accepts spaced hex; match on the compact form
      const rpm = Math.round(wave(900, 3200, 9000));
      const offEl = document.querySelector('#demoOff');
      const off = !!(offEl && offEl.checked);
      const idleRpm = off ? 0 : rpm;
      const testResp = (src) => frame(src, [0x70, parseInt(c.substr(2, 2), 16), c.substr(4, 2) === '11' ? 0x11 : c.substr(4, 2) === '00' ? 0x01 : 0x02]);
      if (header.toUpperCase() === 'A4') {
        if (c === '81') return frame(0xA4, [0xC1, 0xD0, 0x8F]);
        if (c === '2180') return frame(0xA4, D.fromHex('61 80 96 59 83 86 80 00 04 96 59 83 86 80 0B 0F 20 02 00 03 38 D3 00 94 F8 00'));
        if (c === '21FE') return frame(0xA4, D.fromHex('61 FE 00 00 00 00 04 92 17 03 06 0B 0F 20 02 17 03 06 FE 00 00 00 01 62 78 48'));
        const ds = driveState();
        if (c === '21C3') { const b = D.fromHex('61 C3 22 FF 40 D8 01 1A 5B 8C 08 10 0B 00 32 32 89 00 00 00 00 00 00'); b[2] = off ? 0x00 : ds.gearByte; b[4] = off ? 0x70 : 0x40; b[11] = Math.round((off ? 6 : ds.pedal) / 0.39); b[14] = Math.round((100 + (off ? 0 : 30)) / 2); return frame(0xA4, b); }
        if (c === '21C4') { const b = D.fromHex('61 C4 ' + Array(25).fill('00').join(' ')); b[5] = 0x80; return frame(0xA4, b); }
        if (c === '21C5') { const b = D.fromHex('61 C5 00 FF 70 19 17 00 34 2D 10 00 03 00 40 00 1B 3B 33 FA 00 61 82 08 02 00 08 04'); const inr = off ? 0 : ds.inRpm; b[5] = Math.round((off ? 0 : Math.max(800, inr)) / 32); b[6] = Math.round(inr / 32); b[7] = Math.round((off ? 0 : ds.outRpm) / 32); b[21] = Math.round(wave(60, 95, 60000)) + 50; b[16] = Math.round(wave(20, 90, 9000)); b[18] = Math.round(wave(40, 110, 9000)); b[19] = Math.round(wave(40, 250, 9000)); return frame(0xA4, b); }
        if (c === '21CB') return frame(0xA4, D.fromHex('61 CB 41 CA 7A 33'));
        if (c === '21CA' || c === '21C0') return frame(0xA4, D.fromHex('61 ' + c.substr(2, 2) + ' 00 00 00'));
        if (c === '21C1') { const b = D.fromHex('61 C1 ' + Array(22).fill('00').join(' ')); b[19] = 0x05; return frame(0xA4, b); }
        if (c.startsWith('31C3') && c.length === 6) return frame(0xA4, [0x71, 0x02]);
        if (c === '1180') return frame(0xA4, [0x51, 0x80]);
        if (c === '17FF00') return frame(0xA4, [0x57, 0x00]);
        if (c === '14FF00') return frame(0xA4, [0x54, 0xFF, 0x00]);
        if (c.startsWith('1400') && c.length === 6) return frame(0xA4, [0x54, 0x00, parseInt(c.substr(4, 2), 16)]);
        if (c.startsWith('30') && c.length === 6) return testResp(0xA4);
        if (c.startsWith('3B')) return frame(0xA4, [0x7B, parseInt(c.substr(2, 2), 16)]);
        return frame(0xA4, [0x7F, parseInt(c.substr(0, 2), 16), 0x11]);
      }
      if (header.toUpperCase() === '10') {    // engine Peugeot (demo J34P)
        if (c === '81') return frame(0x10, [0xC1, 0xD0, 0x8F]);
        if (c === '21FE') return frame(0x10, D.fromHex('61 FE 00 00 00 00 03 34 12 05 06 0A 03 01 23 12 05 06 FE 00 00 00 02 61 75 09'));
        if (c === '2180') return frame(0x10, [0x7F, 0x21, 0x12]);
        if (c === '17FF00') return frame(0x10, [0x57, 0x00]);
        if (c === '14FF00') return frame(0x10, [0x54, 0xFF, 0x00]);
        if (c === '11FF') return frame(0x10, [0x51]);
        if (c.startsWith('30') && c.length === 6) return testResp(0x10);
        if (c === '21CF00' || c === '21CF') return frame(0x10, D.fromHex('61 CF 01 00 00 2A 14 03 25 01 B5 F2 03 01'));
        if (c.startsWith('21') && c.length >= 4) { const b = engBlock(parseInt(c.substr(2, 2), 16), idleRpm); if (b) return frame(0x10, b); }
        return frame(0x10, [0x7F, parseInt(c.substr(0, 2), 16), 0x11]);
      }
      // engine OBD
      const pid = c.substr(2, 2);
      const r = { '01': [off ? 0x00 : 0x80, 0x07, 0x65, off ? 0x65 : 0x04], '0C': [idleRpm * 4 >> 8, idleRpm * 4 & 0xFF], '0D': [off ? 0 : Math.round(wave(0, 90, 9000))], '05': [Math.round(wave(80, 95, 60000)) + 40], '0F': [64], '0B': [off ? 101 : Math.round(wave(30, 70, 9000))], '04': [Math.round(wave(40, 180, 9000))], '11': [off ? 16 : Math.round(wave(30, 120, 9000))], '0E': [148], '06': [128 + Math.round(wave(-6, 6, 7000))], '07': [132], '14': [Math.round(wave(20, 180, 2000))], '15': [150], '42': [0x37, 0x2C], '00': [0xBE, 0x3E, 0xB8, 0x11], '20': [0x80, 0, 0, 0], '40': [0x40, 0, 0, 0] };
      const hx2 = a => a.map(x => x.toString(16).toUpperCase().padStart(2, '0')).join(' ');
      if (c === '03' || c === '07') return '4' + c[1] + ' 00 00 00';
      if (c === '0902') return '49 02 01 00 00 00 56\r49 02 02 46 33 32 44\r49 02 03 45 4D 4F 32\r49 02 04 30 36 43 43\r49 02 05 32 30 30 36';
      if (c === '0904') return '49 04 01 30 31 32 30\r49 04 02 33 34 41 20';
      if (c.length === 6 && c.startsWith('02')) { const fp = c.substr(2, 2); if (fp === '02') return '42 02 00 01 13'; if (r[fp]) return '42 ' + fp + ' 00 ' + hx2(r[fp]); return '42 ' + fp + ' 00 00 00'; }
      if (r[pid]) return '41 ' + pid + ' ' + hx2(r[pid]);
      return 'NO DATA';
    };
  }
})();
