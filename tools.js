/* psadiag web — Tools: fault reading (with stored conditions), actuator tests, service/reset, Peugeot live data.
   Driven by a context the app passes in. Uses Diag (KWP/OBD) + Dbx (Diagbox decode). */
(function () {
  'use strict';
  const D = window.Diag, Dbx = window.Dbx;
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
      b.appendChild(toolBtn('Switch to Peugeot mode ▸', 'Identify the engine computer and unlock manufacturer data, actuator tests and the learned-values reset. Takes a few seconds.', switchPeugeot));
      return;
    }
    b.appendChild(toolBtn('Read fault codes', 'Codes with descriptions, and the conditions stored with each.', faults));
    if (ctx.ecu) b.appendChild(toolBtn('Live manufacturer data', 'Everything the dealer tool shows, decoded.', pdata));
    b.appendChild(toolBtn('Actuator tests', 'Drive a component to check it (safety checks first).', testList));
    if (ctx.kind === 'engine') b.appendChild(toolBtn('Reset learned values', 'Throttle / idle / mixture learning, then the re-learn steps.', engineReset));
    if (ctx.kind === 'gearbox') {
      b.appendChild(toolBtn('Reset learned values (autoadaptives)', "PP2000's gearbox reset. Record a drive first to compare.", gearboxReset));
      b.appendChild(toolBtn('Oil wear counter', 'Read it; reset after an oil change.', oilCounter));
    }
  }
  function toolBtn(t, sub, fn) { const b = el('button', 'add-btn'); b.appendChild(el('div', 'tb-t', t)); if (sub) b.appendChild(el('div', 'tb-s', sub)); b.onclick = fn; return b; }
  function header(t, backFn) { title(t); const b = body(); b.innerHTML = ''; $('#tBack').onclick = backFn || menu; $('#tFooter').style.display = 'none'; return b; }

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

  const bcd = v => ((Math.floor(v / 10) << 4) | (v % 10));
  const sae = c => { const n = parseInt(c, 16); return 'PCBU'[n >> 14] + (n & 0x3FFF).toString(16).toUpperCase().padStart(4, '0'); };
  const esc = s => String(s).replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
  function lightHealth(label, n) { if (n == null) return ''; const k = label.toLowerCase(); if (/coolant|water/.test(k) && /temp/.test(k) && !/reference|request|target/.test(k)) return n >= 118 ? 'bad' : n >= 107 ? 'warn' : ''; if (/battery|supply/.test(k) && /volt/.test(k)) return n < 11.8 ? 'bad' : ''; if (/oil temp/.test(k)) return n >= 135 ? 'bad' : n >= 120 ? 'warn' : ''; return ''; }
  function ok(b, t) { b.appendChild(el('div', 'res-ok', '✓ ' + t)); }
  function warn(b, t) { b.appendChild(el('div', 'res-warn', '! ' + t)); }
  function bad(b, t) { b.appendChild(el('div', 'res-bad', '✗ ' + t)); }

  window.Tools = { open };
})();
