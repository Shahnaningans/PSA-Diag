/* psadiag web — Tools: fault reading (with stored conditions), actuator tests, service/reset, Peugeot live data.
   Driven by a context the app passes in. Uses Diag (KWP/OBD) + Dbx (Diagbox decode). */
(function () {
  'use strict';
  const D = window.Diag, Dbx = window.Dbx, A = window.Analysis;
  const recordings = [];
  const $ = s => document.querySelector(s);
  const el = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };
  const hex = b => b.toString(16).toUpperCase().padStart(2, '0');
  const neg = c => D.NEG[c] || ('code 0x' + hex(c));

  let ctx, liveTimer = null;
  const body = () => $('#tBody');
  const title = t => $('#tTitle').textContent = t;
  function showOnly(id) { document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id)); }
  function stopLive() { if (liveTimer) { clearInterval(liveTimer); liveTimer = null; } }

  function open(c) { ctx = c; menu(); showOnly('screen-tools'); }
  function leave() { stopLive(); ctx.restore(); }

  // ---------------- menu ----------------
  function menu() {
    stopLive(); title(ctx.kind === 'gearbox' ? 'Gearbox tools' : 'Engine tools');
    const b = body(); b.innerHTML = '';
    $('#tFooter').style.display = 'none';
    $('#tBack').onclick = leave;
    const info = el('div', 'ecu-row');
    info.appendChild(el('span', 'dot'));
    info.appendChild(el('span', null, ctx.ecu ? (ctx.ecu.ecu + (ctx.variant ? '  ·  ' + ctx.variant : '')) : (ctx.kind === 'engine' ? 'Engine — standard OBD' : '')));
    b.appendChild(info);

    if (ctx.kind === 'engine' && !ctx.ecu) {
      b.appendChild(toolBtn('Read fault codes (OBD)', 'Stored and pending engine codes.', obdFaults));
      b.appendChild(toolBtn('Emissions readiness (MOT)', 'Warning light and which self-tests have completed.', readiness));
      b.appendChild(toolBtn('Freeze frame', 'Engine conditions when the stored fault was set.', freeze));
      b.appendChild(toolBtn('Vehicle / calibration ID', 'VIN and calibration ID, if the engine reports them.', vehicleId));
      b.appendChild(toolBtn('Battery & charging test', 'Press, then start the engine — rest, cranking and alternator voltage.', battery));
      b.appendChild(toolBtn('Switch to Peugeot mode ▸', 'Identify the engine computer and unlock manufacturer data, actuator tests and the learned-values reset. Takes a few seconds.', switchPeugeot));
      return;
    }
    b.appendChild(toolBtn('Read fault codes', 'Codes with descriptions, and the conditions stored with each.', faults));
    if (ctx.ecu) b.appendChild(toolBtn('Live manufacturer data', 'Everything the dealer tool shows, decoded.', pdata));
    b.appendChild(toolBtn('Actuator tests', 'Drive a component to check it (safety checks first).', testList));
    if (ctx.kind === 'engine') {
      b.appendChild(toolBtn('Reset learned values', 'Throttle / idle / mixture learning, then the re-learn steps.', engineReset));
      b.appendChild(toolBtn('Fault-clearing history', 'When the engine faults were last cleared, and at what mileage.', history));
    }
    if (ctx.kind === 'gearbox') {
      b.appendChild(toolBtn('Record & analyse a drive', 'Log a drive and see every gear change, flare and pressures; open/compare saved CSVs.', drives));
      b.appendChild(toolBtn('Guided switch test', 'Walks you through brake, lever, pedal and buttons; checks each switch.', switchTest));
      b.appendChild(toolBtn('Accelerator pedal learning', 'Only after reprogramming/replacing the gearbox computer or adjusting the pedal.', pedalLearn));
      b.appendChild(toolBtn('Configuration', 'Snow mode from ESP, ESP gear holding, shift-lock / key-lock wiring checks.', coding));
      b.appendChild(toolBtn('Reset learned values (autoadaptives)', "PP2000's gearbox reset. Record a drive first to compare.", gearboxReset));
      b.appendChild(toolBtn('Oil wear counter', 'Read it; reset after an oil change.', oilCounter));
    }
  }
  function preBox(b, text) { const p = document.createElement('pre'); p.className = 'mono'; p.textContent = text; b.appendChild(p); return p; }
  function toolBtn(t, sub, fn) { const b = el('button', 'add-btn'); b.appendChild(el('div', 'tb-t', t)); if (sub) b.appendChild(el('div', 'tb-s', sub)); b.onclick = fn; return b; }
  function header(t, backFn) { stopLive(); title(t); const b = body(); b.innerHTML = ''; $('#tBack').onclick = backFn || menu; $('#tFooter').style.display = 'none'; $('#tFooter').innerHTML = ''; return b; }

  // ---------------- faults ----------------
  async function faults() {
    const b = header('Fault codes'); b.appendChild(el('div', 'busy', 'Reading…'));
    try {
      const r = await ctx.kwp.send([0x17, 0xFF, 0x00]);
      b.innerHTML = '';
      if (!r.ok) { b.appendChild(el('div', 'busy', r.negative != null ? 'Refused: ' + neg(r.negative) : 'No answer.')); return; }
      const u = Dbx.unitOf(ctx.ecu, 'RDSDTC');
      const list = u ? Dbx.faults(u, r.ok) : null;
      if (!list || !list.length) { ok(b, 'No fault codes stored.'); return; }
      warn(b, list.length + ' fault code(s):');
      list.forEach(f => {
        const card = el('div', 'tile'); card.style.gridColumn = '';
        const code = ctx.kind === 'engine' ? sae(f.code) : f.code;
        card.appendChild(el('div', 'f-code', code + (f.present ? '  • present' : '')));
        card.appendChild(el('div', 'f-text', Dbx.faultText(ctx.ecu, f.code) || '(no description)'));
        card.appendChild(el('div', 'f-state', 'Status: ' + f.state));
        if (f.conditions.length) { const c = el('div', 'f-cond'); c.appendChild(el('div', 'f-cond-h', 'Conditions when stored:')); f.conditions.slice(0, 14).forEach(v => c.appendChild(el('div', 'f-cond-r', v.label + ': ' + v.text))); card.appendChild(c); }
        b.appendChild(card);
      });
      const clr = el('button', 'danger-btn', 'Clear fault codes'); clr.onclick = () => clearFaults(); b.appendChild(clr);
    } catch (e) { b.innerHTML = ''; bad(b, e.message || e); }
  }
  async function clearFaults() {
    if (!confirm('Clear all fault codes? Do this with the engine off, ignition on. Codes for a fault still present will come straight back.')) return;
    const b = header('Clear faults'); b.appendChild(el('div', 'busy', 'Clearing…'));
    const r = await ctx.kwp.send([0x14, 0xFF, 0x00]);
    b.innerHTML = '';
    if (r.ok) { ok(b, 'Fault codes cleared.'); if (ctx.kind === 'gearbox') { const d = new Date(); await ctx.kwp.send([0x3B, 0xC0, bcd(d.getDate()), bcd(d.getMonth() + 1), bcd(d.getFullYear() % 100)]); } }
    else bad(b, r.negative != null ? 'Refused: ' + neg(r.negative) : 'No answer.');
    const back = el('button', 'add-btn', '‹ Back to tools'); back.onclick = menu; b.appendChild(back);
  }
  async function obdFaults() {
    const b = header('Engine fault codes (OBD)'); b.appendChild(el('div', 'busy', 'Reading…'));
    try {
      const stored = await ctx.obd.dtcs(false), pending = await ctx.obd.dtcs(true);
      b.innerHTML = '';
      if (!stored.length) ok(b, 'No stored fault codes.'); else { warn(b, 'Stored: ' + stored.join(', ')); }
      if (!pending.length) ok(b, 'No pending fault codes.'); else warn(b, 'Pending: ' + pending.join(', '));
      if (stored.length || pending.length) { const clr = el('button', 'danger-btn', 'Clear (also resets readiness)'); clr.onclick = async () => { if (confirm('Clear engine fault codes? This also resets the emissions readiness checks.')) { const okc = await ctx.obd.clear(); alert(okc ? 'Cleared.' : 'The engine refused to clear.'); menu(); } }; b.appendChild(clr); }
    } catch (e) { b.innerHTML = ''; bad(b, e.message || e); }
  }

  // ---------------- Peugeot live data ----------------
  async function pdata() {
    const b = header('Live manufacturer data'); const listWrap = el('div'); b.appendChild(listWrap);
    const blocks = Dbx.liveBlocks(ctx.ecu);
    async function cycle() {
      let html = '';
      for (const bl of blocks) {
        let r = null; try { r = (await ctx.kwp.send(Dbx.request(bl.unit))).ok; } catch (e) {}
        if (!r) continue;
        const vals = Dbx.decode(bl.unit, r);
        html += '<div class="pd-blk">[' + hex(bl.lid) + ']</div>';
        vals.forEach(v => { const h = lightHealth(v.label, v.n); html += '<div class="pd-row' + (h ? ' ' + h : '') + '"><span>' + esc(v.label) + '</span><b>' + esc(v.text) + '</b></div>'; });
      }
      listWrap.innerHTML = html || '<div class="busy">No data.</div>';
    }
    await cycle(); liveTimer = setInterval(cycle, 400);
  }

  // ---------------- actuator tests ----------------
  function testList() {
    const b = header('Actuator tests'); const list = Dbx.tests(ctx.ecu);
    if (!list.length) { b.appendChild(el('div', 'busy', 'No actuator tests for this computer.')); return; }
    b.appendChild(el('div', 'hint', 'Each test drives one part for a few seconds. Safety checks run first. Watch / listen for the part working.'));
    list.forEach(t => { const btn = el('button', 'add-btn'); btn.appendChild(el('div', 'tb-t', hex(t.id) + '  ' + t.label)); btn.onclick = () => runTest(t); b.appendChild(btn); });
  }
  async function runTest(t) {
    const b = header('Test ' + hex(t.id), testList); b.appendChild(el('div', 'busy', 'Checking the car is safe…'));
    const s = await safety();
    b.innerHTML = '';
    b.appendChild(el('div', 'tb-t2', hex(t.id) + '  ' + t.label));
    s.lines.forEach(l => b.appendChild(el('div', l.ok ? 'chk-ok' : 'chk-bad', (l.ok ? '✓ ' : '✗ ') + l.text)));
    if (/INJECT|POMPE|FUEL/i.test(t.name)) warn(b, 'Fuel part: make sure there is no fuel leak or smell and nobody is under the bonnet.');
    if (/GMV|VENTIL|FAN/i.test(t.name)) warn(b, 'The radiator fan will spin — keep hands clear.');
    if (!s.ok) { bad(b, 'Conditions not met. Fix the above and try again.'); const bk = el('button', 'add-btn', '‹ Back'); bk.onclick = testList; b.appendChild(bk); return; }
    const go = el('button', 'danger-btn', 'Start the test'); const out = el('div', 'run-out');
    go.onclick = async () => {
      go.disabled = true; out.textContent = 'Starting…';
      let started = false;
      try {
        const r = await ctx.kwp.send([0x30, t.id, 0x00]);
        if (!r.ok) { out.textContent = 'Refused: ' + (r.negative != null ? neg(r.negative) : 'no answer'); go.disabled = false; return; }
        started = true; out.textContent = 'Running — watch/listen now…';
        const t0 = Date.now(); let last = r.ok;
        while (Date.now() - t0 < 12000) { await D.sleep(500); const st = await ctx.kwp.send([0x30, t.id, 0x01]); last = st.ok; if (!st.ok || st.ok[2] !== 0x01) break; }
        out.textContent = 'Result: ' + status(last);
      } catch (e) { out.textContent = 'Error: ' + (e.message || e); }
      finally { if (started) { try { await ctx.kwp.send([0x30, t.id, 0x11]); } catch (e) {} } go.disabled = false; }
    };
    b.appendChild(go); b.appendChild(out);
  }
  function status(r) { if (!r || r.length < 3) return r ? 'ok' : 'no answer'; return ({ 0x00: 'not started', 0x01: 'running', 0x02: 'finished OK', 0x04: 'problem reported', 0x11: 'stopped', 0x20: 'active' })[r[2]] || ('code ' + hex(r[2])); }

  // ---------------- resets ----------------
  async function engineReset() {
    const b = header('Reset engine learned values');
    b.appendChild(el('div', 'hint', 'Clears throttle stop, idle and mixture learning. Diagbox does this after replacing the throttle body, injectors or sensors. Best with a cold engine and a good battery.'));
    const s = await safety(); s.lines.forEach(l => b.appendChild(el('div', l.ok ? 'chk-ok' : 'chk-bad', (l.ok ? '✓ ' : '✗ ') + l.text)));
    const u = Dbx.unitOf(ctx.ecu, 'ECURST_RECENTRAGE') || Dbx.unitOf(ctx.ecu, 'ECURESET_INIT_AUTOADAPATTIF') || Dbx.unitOf(ctx.ecu, 'ECURST');
    const req = u ? Dbx.request(u) : [0x11, 0xFF];
    const go = el('button', 'danger-btn', 'Reset now'); const out = el('div', 'run-out');
    go.onclick = async () => { if (!confirm('Reset the engine learned values now?')) return; const r = await ctx.kwp.send(req.length >= 2 ? req : [0x11, 0xFF]); if (r.ok) { out.innerHTML = '<b>Done.</b> Now: 1) ignition OFF 3 min. 2) ignition ON, don\'t touch the throttle, wait 15 s. 3) start, idle with no electrics/AC until the fan comes on, then off. 4) drive ~5 km of town roads.'; } else out.textContent = 'Refused: ' + (r.negative != null ? neg(r.negative) : 'no answer'); };
    b.appendChild(go); b.appendChild(out);
  }
  async function gearboxReset() {
    const b = header('Reset gearbox autoadaptives');
    b.appendChild(el('div', 'hint', 'Wipes learned shift pressures and style. Only for a reason (shift complaints, oil change, repair). Record a drive first to compare.'));
    const s = await safety(); s.lines.forEach(l => b.appendChild(el('div', l.ok ? 'chk-ok' : 'chk-bad', (l.ok ? '✓ ' : '✗ ') + l.text)));
    if (!s.ok) { bad(b, 'Conditions not met.'); return; }
    const fe = (await ctx.kwp.send([0x21, 0xFE])).ok;
    if (!fe || fe.length < 12) { bad(b, 'Could not read the gearbox version.'); return; }
    const sys = fe[7], app = fe[11];
    const groups = sys === 0x91 ? [1, 2, 3, 5] : (sys === 0x92 && (app === 0x08 || app === 0x09)) ? [1, 2, 5, 7] : (sys === 0x92 && (app === 0x0B || app === 0x0E || app === 0x12)) ? [2, 3, 4, 5, 7] : null;
    b.appendChild(el('div', 'hint', 'Version: system 0x' + hex(sys) + ', application 0x' + hex(app) + (groups ? ' → groups ' + groups.join(', ') : '')));
    if (!groups) { bad(b, "This gearbox version isn't one the procedure knows. Nothing reset."); return; }
    const go = el('button', 'danger-btn', 'Initialise autoadaptives'); const out = el('div', 'run-out');
    go.onclick = async () => {
      if (!confirm('Initialise the gearbox autoadaptives now?')) return; go.disabled = true;
      let done = 0;
      for (const g of groups) { const r = await ctx.kwp.send([0x14, 0x00, g]); if (!r.ok) { out.textContent = 'Group ' + g + ' refused: ' + (r.negative != null ? neg(r.negative) : 'no answer') + (done ? ' (stopped after ' + done + ')' : ''); go.disabled = false; return; } done++; out.textContent = 'Group ' + g + ' done…'; }
      out.innerHTML = '<b>Done.</b> Switch the ignition OFF for 15 s, then drive normally in D. Shifts may feel different for a few drives while it re-learns.';
    };
    b.appendChild(go); b.appendChild(out);
  }
  async function oilCounter() {
    const b = header('Oil wear counter'); b.appendChild(el('div', 'busy', 'Reading…'));
    const r = (await ctx.kwp.send([0x21, 0xCB])).ok; b.innerHTML = '';
    if (!r || r.length < 4) { bad(b, 'Could not read the counter.'); return; }
    const cnt = r[2] << 8 | r[3]; const max = 32958;
    b.appendChild(el('div', 'tb-t2', cnt + ' of ' + max + '  (' + Math.min(100, Math.round(cnt * 100 / max)) + '% worn)'));
    if (cnt >= max) warn(b, 'Saturated — the gearbox wants an oil change.');
    b.appendChild(el('div', 'hint', 'After an oil change: set to 0 for a full renewal, or subtract 5,500 per litre of new oil for a drain-and-refill.'));
    const mk = (lbl, val) => { const btn = el('button', 'danger-btn', lbl); btn.onclick = () => writeOil(val, cnt); return btn; };
    b.appendChild(mk('Set to 0 (full renewal)', 0));
    [3, 3.5, 4].forEach(L => b.appendChild(mk('Drain & refill ' + L + ' l  → ' + Math.max(0, cnt - Math.round(L * 5500)), Math.max(0, cnt - Math.round(L * 5500)))));
    const back = el('button', 'add-btn', '‹ Back'); back.onclick = menu; b.appendChild(back);
  }
  async function writeOil(target, before) {
    const s = await safety(); if (!s.ok) { alert('The car must be stationary with the lever in P.'); return; }
    if (!confirm('Set the oil wear counter to ' + target + '? (was ' + before + ')')) return;
    const r = (await ctx.kwp.send([0x3B, 0xCB, target >> 8, target & 0xFF, 0x00, 0x00]));
    if (!r.ok) { alert('Refused: ' + (r.negative != null ? neg(r.negative) : 'no answer')); return; }
    const d = new Date(); await ctx.kwp.send([0x3B, 0xCA, bcd(d.getDate()), bcd(d.getMonth() + 1), bcd(d.getFullYear() % 100)]);
    const after = (await ctx.kwp.send([0x21, 0xCB])).ok; const now = after && after.length >= 4 ? (after[2] << 8 | after[3]) : -1;
    alert(now === target ? 'Done — counter is now ' + target + ', oil-change date recorded.' : 'Written, but it now reads ' + now + '.');
    oilCounter();
  }

  // ---------------- safety + helpers ----------------
  async function safety() {
    const lines = []; let ok = true;
    try {
      let rpm = null, speed = null, lever = null;
      if (ctx.kind === 'gearbox') {
        const c5 = (await ctx.kwp.send([0x21, 0xC5])).ok, c3 = (await ctx.kwp.send([0x21, 0xC3])).ok;
        if (c5 && c5.length > 7) { rpm = c5[5] * 32; speed = c5[7] * 32; }
        if (c3 && c3.length > 4) { lever = ({ 0x10: '1', 0x20: '2', 0x30: '3', 0x40: 'D', 0x50: 'R', 0x60: 'N', 0x70: 'P' })[c3[4]] || '?'; }
      } else {
        for (const bl of Dbx.liveBlocks(ctx.ecu)) { const r = (await ctx.kwp.send(Dbx.request(bl.unit))).ok; if (!r) continue; const v = Dbx.decode(bl.unit, r).find(x => /REGIME_MOTEUR|engine speed/i.test(x.name || '') || /engine speed/i.test(x.label)); if (v && v.n != null) { rpm = v.n; break; } }
      }
      const volts = parseFloat((await ctx.elm.voltage()).replace(/[^0-9.]/g, '')) || null;
      if (rpm == null) { lines.push({ ok: false, text: 'Engine speed could not be read' }); ok = false; }
      else if (rpm > 100) { lines.push({ ok: false, text: 'Engine is running (' + Math.round(rpm) + ' rpm) — switch it OFF' }); ok = false; }
      else lines.push({ ok: true, text: 'Engine off' });
      if (speed != null) { if (speed > 50) { lines.push({ ok: false, text: 'Car is moving' }); ok = false; } else lines.push({ ok: true, text: 'Car stationary' }); }
      if (volts != null) { if (volts < 11.8) { lines.push({ ok: false, text: 'Battery low (' + volts.toFixed(1) + ' V)' }); ok = false; } else lines.push({ ok: true, text: 'Battery ' + volts.toFixed(1) + ' V' }); }
      if (ctx.kind === 'gearbox' && lever != null) { if (lever === 'P' || lever === 'N') lines.push({ ok: true, text: 'Lever in ' + lever }); else { lines.push({ ok: false, text: 'Lever in ' + lever + ' — put it in P' }); ok = false; } }
    } catch (e) { lines.push({ ok: false, text: 'Could not read the car state' }); ok = false; }
    return { ok, lines };
  }
  async function switchPeugeot() {
    const b = header('Switching to Peugeot mode'); b.appendChild(el('div', 'busy', 'Closing OBD and waking the engine (about 7 s)…'));
    try { const res = await ctx.goPeugeot(); if (!res.ok) { b.innerHTML = ''; bad(b, res.message || 'The engine did not answer Peugeot requests. Standard OBD still works.'); const bk = el('button', 'add-btn', '‹ Back'); bk.onclick = menu; b.appendChild(bk); return; } ctx.kwp = res.kwp; ctx.ecu = res.ecu; ctx.variant = res.variant; menu(); }
    catch (e) { b.innerHTML = ''; bad(b, e.message || e); }
  }

  // ---------------- OBD extras (engine) ----------------
  function swRow(b, name, val, bad2) { const row = el('div', 'sw-row'); row.appendChild(el('div', 'sw-label', name)); row.appendChild(el('div', 'sw-val' + (bad2 ? ' bad' : ''), val)); b.appendChild(row); return row; }
  async function readiness() {
    const b = header('Emissions readiness (MOT)'); b.appendChild(el('div', 'busy', 'Reading…'));
    const r = await ctx.obd.readiness(); b.innerHTML = '';
    if (!r) { bad(b, 'No answer.'); return; }
    (r.mil ? warn : ok)(b, r.mil ? ('Warning light ON · ' + r.count + ' stored fault(s)') : 'Warning light off');
    b.appendChild(el('div', 'hint', 'For an MOT these self-tests should read "complete". A recent battery disconnect or fault-clear resets them to "not ready" — drive normally for a while to re-run them.'));
    r.monitors.forEach(m => swRow(b, m.name, m.complete ? 'complete' : 'not ready', !m.complete));
  }
  async function freeze() {
    const b = header('Freeze frame'); b.appendChild(el('div', 'busy', 'Reading…'));
    const dtc = await ctx.obd.freezeDtc(); b.innerHTML = '';
    if (!dtc) { ok(b, 'No freeze frame stored (no fault has set one).'); return; }
    b.appendChild(el('div', 'tb-t2', 'Conditions stored for fault ' + dtc));
    const pids = [[0x0C, 'Engine speed', 'rpm', d => (d[0] * 256 + d[1]) / 4], [0x0D, 'Vehicle speed', 'km/h', d => d[0]], [0x05, 'Coolant', '°C', d => d[0] - 40], [0x0F, 'Intake air', '°C', d => d[0] - 40], [0x04, 'Load', '%', d => d[0] * 100 / 255], [0x11, 'Throttle', '%', d => d[0] * 100 / 255], [0x06, 'Short fuel trim', '%', d => (d[0] - 128) * 100 / 128]];
    for (const [p, n, u, f] of pids) { const d = await ctx.obd.freezePid(p); swRow(b, n, d && d.length ? (Math.round(f(d) * 10) / 10) + ' ' + u : '-'); }
  }
  async function vehicleId() {
    const b = header('Vehicle / calibration ID'); b.appendChild(el('div', 'busy', 'Reading…'));
    const vin = await ctx.obd.vehicleInfo(0x02), cal = await ctx.obd.vehicleInfo(0x04); b.innerHTML = '';
    swRow(b, 'VIN', vin || 'not reported'); swRow(b, 'Calibration ID', cal || 'not reported');
    b.appendChild(el('div', 'hint', 'Some engine computers report a placeholder VIN rather than the real one — that is normal here.'));
  }
  async function battery() {
    const b = header('Battery & charging test');
    b.appendChild(el('div', 'hint', 'Leave the engine OFF. Press Start, wait ~3 seconds, then START the engine and let it idle. Watches rest voltage, the dip while cranking, and alternator charging.'));
    const out = el('div', 'run-out', 'Ready.'); const go = el('button', 'danger-btn', 'Start (22 s)'); b.appendChild(go); b.appendChild(out);
    go.onclick = async () => {
      go.disabled = true; let rest = null, minV = 99, maxV = 0; const t0 = Date.now();
      while (Date.now() - t0 < 22000) { const v = parseFloat((await ctx.elm.voltage()).replace(/[^0-9.]/g, '')); if (isFinite(v)) { if (Date.now() - t0 < 2500) rest = v; if (v < minV) minV = v; if (v > maxV) maxV = v; out.textContent = 'Now ' + v.toFixed(1) + ' V — start the engine…'; } await D.sleep(300); }
      let s = 'Rest ' + (rest ? rest.toFixed(1) : '?') + ' V · lowest while cranking ' + minV.toFixed(1) + ' V · charging ' + maxV.toFixed(1) + ' V.\n';
      if (minV < 9.6) s += '⚠ Big dip when cranking — battery may be weak.\n';
      if (maxV < 13.2) s += '⚠ Charging voltage low — alternator or belt?\n'; else if (maxV > 15.2) s += '⚠ Charging voltage high — regulator?\n';
      if (minV >= 9.6 && maxV >= 13.2 && maxV <= 15.2) s += '✓ Battery and charging look healthy.';
      out.textContent = s; go.disabled = false;
    };
  }
  async function history() {
    const b = header('Fault-clearing history'); b.appendChild(el('div', 'busy', 'Reading…'));
    const u = Dbx.unitOf(ctx.ecu, 'RDBLID_LID_CF'); if (!u) { b.innerHTML = ''; bad(b, 'This computer has no clearing history.'); return; }
    const r = (await ctx.kwp.send(Dbx.request(u))).ok; b.innerHTML = '';
    if (!r || r.length < 14) { bad(b, 'No answer.'); return; }
    const d = r.slice(6, 9), km = r[9] << 16 | r[10] << 8 | r[11];
    b.appendChild(el('div', 'tb-t2', 'Last fault clearing / after-sales work'));
    swRow(b, 'Entry number', String(r[2]));
    swRow(b, 'Date', (d.every(x => x === 0) || d.every(x => x === 0xFF)) ? 'not recorded' : (hex(d[0]) + '/' + hex(d[1]) + '/20' + hex(d[2])));
    swRow(b, 'Mileage', (km === 0 || km === 0xFFFFFF) ? 'not recorded' : km.toLocaleString() + ' km');
    swRow(b, 'Interventions', String(r[13]));
  }

  // ---------------- drive analysis ----------------
  function drives() {
    const b = header('Record & analyse a drive');
    b.appendChild(toolBtn('● Record a drive', 'Log the gearbox while you drive (a passenger holds the phone). Then see every gear change and the flare.', recordDrive));
    const fi = document.createElement('input'); fi.type = 'file'; fi.accept = '.csv,text/csv'; fi.multiple = true; fi.style.display = 'none';
    fi.onchange = async () => { const files = [...fi.files]; if (!files.length) return; const loaded = []; for (const f of files) { const text = await f.text(); loaded.push({ name: f.name.replace(/\.csv$/i, ''), load: A.Load(text) }); } showAnalysis(loaded); };
    b.appendChild(toolBtn('Open CSV file(s)', 'One to analyse, two to compare, several for a trend. Opens files saved here or by the Windows tool.', () => fi.click()));
    b.appendChild(fi);
    if (recordings.length) { b.appendChild(el('div', 'section-h', 'RECORDED THIS SESSION')); recordings.forEach(rec => b.appendChild(toolBtn(rec.name, 'Tap to analyse', () => showAnalysis([{ name: rec.name, load: A.Load(rec.text) }])))); }
  }
  function showAnalysis(loaded) {
    const b = header(loaded.length === 1 ? 'Drive analysis' : loaded.length === 2 ? 'Comparison' : 'Trend', drives);
    let text;
    if (loaded.length === 1) text = A.analyse(loaded[0].load.rows, loaded[0].name) + '\n' + A.guidance(loaded[0].load);
    else if (loaded.length === 2) { const o = loaded.slice().sort((a, b) => (a.load.rows[0] ? a.load.rows[0].time : 0) - (b.load.rows[0] ? b.load.rows[0].time : 0)); text = A.compare({ name: o[0].name, rows: o[0].load.rows }, { name: o[1].name, rows: o[1].load.rows }); }
    else text = A.trend(loaded.map(l => ({ name: l.name, rows: l.load.rows })));
    preBox(b, text);
  }
  function recordDrive() {
    const b = header('Recording a drive', drives);
    b.appendChild(el('div', 'hint', 'Drive in D (Eco). A passenger holds the phone — do not touch it while driving. Press Stop when you are back.'));
    const live = el('div', 'tb-t2', 'Starting…'); b.appendChild(live);
    const recs = []; stopLive();
    $('#tFooter').style.display = 'flex'; $('#tFooter').innerHTML = '';
    const stop = el('button', 'stop', '■ Stop'); $('#tFooter').appendChild(stop);
    liveTimer = setInterval(async () => {
      const c3 = (await ctx.kwp.send([0x21, 0xC3])).ok, c4 = (await ctx.kwp.send([0x21, 0xC4])).ok, c5 = (await ctx.kwp.send([0x21, 0xC5])).ok;
      if (c3 && c5) { const v = A.canonicalRow(c3, c4, c5); recs.push({ t: new Date(), v }); live.textContent = recs.length + ' readings · ' + v.gear + ' · in ' + v.input_rpm + ' rpm · oil ' + v.oil_c + '°C'; }
    }, 320);
    stop.onclick = () => {
      stopLive(); $('#tFooter').style.display = 'none'; $('#tFooter').innerHTML = '';
      if (!recs.length) { drives(); return; }
      const text = A.toCsv(recs); const name = 'drive-' + new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19); recordings.push({ name, text });
      try { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' })); a.download = name + '.csv'; a.click(); } catch (e) {}
      showAnalysis([{ name, load: A.Load(text) }]);
    };
  }

  // ---------------- guided switch test ----------------
  async function switchTest() {
    const b = header('Guided switch test');
    b.appendChild(el('div', 'hint', 'Ignition ON, engine OFF, parked, handbrake on, lever in P. After you press Start you have ~75 s:\n1. Brake: press then release.\n2. Foot on brake: move the lever P→R→N→D→M→P.\n3. Lever in P: press the accelerator slowly to the floor, hold, release.\n4. Press the Sport button, then the Snow button.'));
    const out = el('div', 'run-out', 'Ready.'); const go = el('button', 'danger-btn', 'Start (75 s)'); b.appendChild(go); b.appendChild(out);
    go.onclick = async () => {
      go.disabled = true; const seen = { brakeM: false, brakeS: false, kick: false, sport: false, snow: false, levers: new Set(), pedalMax: 0 };
      const t0 = Date.now();
      while (Date.now() - t0 < 75000) {
        const c3 = (await ctx.kwp.send([0x21, 0xC3])).ok;
        if (c3 && c3.length > 14) {
          if (c3[12] & 0x04) seen.brakeM = true; if (c3[12] & 0x02) seen.brakeS = true; if (c3[12] & 0x08) seen.kick = true;
          if (c3[10] & 0x01) seen.sport = true; if (c3[10] & 0x02) seen.snow = true;
          const lev = A.LEVER[c3[4]]; if (lev) seen.levers.add(lev); seen.pedalMax = Math.max(seen.pedalMax, Math.round(c3[11] * 0.39));
        }
        out.textContent = 'Recording… ' + Math.round((Date.now() - t0) / 1000) + ' s   levers seen: ' + [...seen.levers].join(' ');
        await D.sleep(300);
      }
      let s = 'Results:\n';
      s += (seen.brakeM ? '✓' : '✗') + ' Main brake switch\n' + (seen.brakeS ? '✓' : '✗') + ' Secondary brake switch\n';
      s += (seen.kick ? '✓ Kickdown detected' : '— Kickdown not pressed (this car may not use it)') + '\n';
      s += 'Lever positions seen: ' + ([...seen.levers].join(' ') || 'none') + '\n';
      s += 'Accelerator reached ' + seen.pedalMax + '%\n';
      s += (seen.sport ? '✓ Sport button' : '— Sport button not seen') + '\n' + (seen.snow ? '✓ Snow button' : '— Snow button not seen') + '\n';
      out.textContent = s; go.disabled = false;
    };
  }

  // ---------------- pedal learning + coding ----------------
  async function pedalLearn() {
    const b = header('Accelerator pedal learning');
    b.appendChild(el('div', 'hint', 'Only after reprogramming/replacing the gearbox computer or gearbox, or adjusting the accelerator cable / pedal sensor. Computers that do not need it will say so.'));
    const s = await safety(); s.lines.forEach(l => b.appendChild(el('div', l.ok ? 'chk-ok' : 'chk-bad', (l.ok ? '✓ ' : '✗ ') + l.text)));
    if (!s.ok) { bad(b, 'Conditions not met.'); return; }
    const bits = c1 => c1 && c1.length > 21 ? (c1[21] & 0x06) : null;
    const txt = bt => bt === 0 ? 'learned' : bt === 2 ? 'foot-off not learned' : bt === 4 ? 'foot-to-the-floor not learned' : 'neither position learned';
    const go = el('button', 'danger-btn', 'Start pedal learning'); const out = el('div', 'run-out'); b.appendChild(go); b.appendChild(out);
    go.onclick = async () => {
      go.disabled = true; const r = await ctx.kwp.send([0x11, 0x80]);
      if (!r.ok) { out.innerHTML = r.negative === 0x22 ? '<b>This gearbox version does not need accelerator pedal learning.</b> Nothing to do.' : 'Refused: ' + (r.negative != null ? neg(r.negative) : 'no answer'); go.disabled = false; return; }
      out.textContent = 'Stage 1: press the accelerator fully to the floor and hold it.';
      const t0 = Date.now(); let lastb = -1;
      while (Date.now() - t0 < 60000) {
        await D.sleep(1000); const c1 = (await ctx.kwp.send([0x21, 0xC1])).ok; const bt = bits(c1);
        if (bt != null && bt !== lastb) { out.textContent = Math.round((Date.now() - t0) / 1000) + 's: ' + txt(bt) + (bt === 2 ? ' — now release the pedal.' : (bt === 4 || bt === 6) ? ' — press the pedal fully down.' : ''); lastb = bt; }
        if (bt === 0) { out.innerHTML = '<b>Accelerator pedal learning complete.</b>'; go.disabled = false; return; }
      }
      out.textContent = 'Not confirmed. Switch the ignition off and on, then try again.'; go.disabled = false;
    };
  }
  async function coding() {
    const b = header('Configuration'); b.appendChild(el('div', 'busy', 'Reading…'));
    const c1 = (await ctx.kwp.send([0x21, 0xC1])).ok; b.innerHTML = '';
    if (!c1 || c1.length < 20) { bad(b, 'Could not read the configuration (block C1).'); return; }
    const cfg = c1[19];
    b.appendChild(el('div', 'hint', 'Factory settings are usually right — only change one for a reason. Switch the ignition off and on afterwards for a change to take effect.'));
    const opts = [['Snow mode request from the ESP computer', 0x10, 0x70, 0x71], ['ESP gear holding', 0x08, 0x60, 0x61], ['Shift-lock open-circuit check', 0x04, 0x50, 0x51], ['A/C cut-off / key-lock open-circuit check', 0x01, 0x30, 0x31]];
    opts.forEach(([name, mask, offc, onc]) => {
      const on = (cfg & mask) !== 0; const card = el('div', 'tile');
      card.appendChild(el('div', 'f-code', name)); card.appendChild(el('div', 'f-state', 'Currently: ' + (on ? 'ON' : 'off')));
      const set = el('button', on ? 'add-btn' : 'danger-btn', on ? 'Turn OFF' : 'Turn ON'); set.onclick = () => setCoding(name, on ? offc : onc, !on); card.appendChild(set); b.appendChild(card);
    });
  }
  async function setCoding(name, code, wantOn) {
    const s = await safety(); if (!s.ok) { alert('Engine off and lever in P are required.'); return; }
    if (!confirm('Set "' + name + '" to ' + (wantOn ? 'ON' : 'off') + '?')) return;
    const r = await ctx.kwp.send([0x31, 0xC3, code]);
    alert(r.ok ? 'Done. Switch the ignition OFF and back ON for it to take effect.' : 'Refused: ' + (r.negative != null ? neg(r.negative) : 'no answer'));
    coding();
  }

  const bcd = v => ((Math.floor(v / 10) << 4) | (v % 10));
  const sae = c => { const n = parseInt(c, 16); return 'PCBU'[n >> 14] + (n & 0x3FFF).toString(16).toUpperCase().padStart(4, '0'); };
  const esc = s => String(s).replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
  function lightHealth(label, n) { if (n == null) return ''; const k = label.toLowerCase(); if (/coolant|water/.test(k) && /temp/.test(k) && !/reference|request|target/.test(k)) return n >= 118 ? 'bad' : n >= 107 ? 'warn' : ''; if (/battery|supply/.test(k) && /volt/.test(k)) return n < 11.8 ? 'bad' : ''; if (/oil temp/.test(k)) return n >= 135 ? 'bad' : n >= 120 ? 'warn' : ''; return ''; }
  function ok(b, t) { b.appendChild(el('div', 'res-ok', '✓ ' + t)); }
  function warn(b, t) { b.appendChild(el('div', 'res-warn', '! ' + t)); }
  function bad(b, t) { b.appendChild(el('div', 'res-bad', '✗ ' + t)); }

  window.Tools = { open };
})();
