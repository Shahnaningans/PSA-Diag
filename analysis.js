/* psadiag web — drive analysis (shift detection, flare, timing, pressures, compare, trend) + CSV guidance.
   Port of Analysis.cs / CsvView.cs / GearCodes.cs. Works on gearbox drive CSVs (canonical columns). */
(function (root) {
  'use strict';
  const hx = b => b.toString(16).toUpperCase().padStart(2, '0');

  // ---- gear codes (same logic as the Windows tool) ----
  const GEAR_TEXT = { 0x00: 'Neutral or neutral cold', 0x11: 'Off or 1st de-bypassed', 0x22: '2nd de-bypassed', 0x33: '3rd de-bypassed', 0x44: '4th de-bypassed', 0x55: '1st slipping', 0x66: '2nd slipping', 0x77: '3rd slipping', 0x88: '4th slipping', 0x99: '1st locked up', 0xAA: '2nd locked up', 0xBB: '3rd locked up', 0xCC: '4th locked up', 0xDD: 'Clutch release when stationary or manual neutral', 0xEE: 'Reverse gear', 0xFF: 'Refuge (Hydraulic 3rd)' };
  const LEVER = { 0x10: '1', 0x20: '2', 0x30: '3', 0x40: 'D', 0x50: 'R', 0x60: 'N', 0x70: 'P' };
  const gearText = b => GEAR_TEXT[b] || ('0x' + hx(b));
  function stateCode(g) {
    if (g == null) return null;
    if (g.startsWith('Off or 1st')) return '1';
    if (g.startsWith('2nd locked')) return 'A'; if (g.startsWith('3rd locked')) return 'B'; if (g.startsWith('4th locked')) return 'C';
    if (g.startsWith('2nd')) return '2'; if (g.startsWith('3rd')) return '3'; if (g.startsWith('4th')) return '4';
    if (g.startsWith('Neutral')) return '0'; if (g.startsWith('Reverse')) return 'E';
    return null;
  }
  const isTransition = g => g != null && /^0x[0-9A-F]{2}$/.test(g);
  const gearNumber = c => ({ '1': 1, '2': 2, 'A': 2, '3': 3, 'B': 3, '4': 4, 'C': 4 })[c] || 0;
  const lockedDigit = c => c === 'A' || c === 'B' || c === 'C';
  const nameOf = c => ({ '0': 'N', '1': '1st', '2': '2nd', '3': '3rd', '4': '4th', 'A': '2nd locked', 'B': '3rd locked', 'C': '4th locked', 'E': 'R' })[c] || c;
  const lockupTxt = g => { const c = stateCode(g); return c ? (lockedDigit(c) ? 'yes' : 'no') : ''; };

  // ---- CSV parsing ----
  function parseCsv(text) {
    const rows = []; let i = 0, field = '', row = [], q = false;
    while (i < text.length) {
      const ch = text[i];
      if (q) { if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += ch; }
      else if (ch === '"') q = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; if (field.length || row.length) { row.push(field); rows.push(row); } field = ''; row = []; }
      else field += ch;
      i++;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows;
  }
  function parseTime(s, day) {
    let m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)(?:\.(\d+))?/.exec(s);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], m[7] ? +(m[7] + '00').slice(0, 3) : 0);
    m = /^(\d\d):(\d\d):(\d\d)(?:\.(\d+))?/.exec(s);
    if (m) { const d = new Date(day); d.setHours(+m[1], +m[2], +m[3], m[4] ? +(m[4] + '00').slice(0, 3) : 0); return d; }
    return null;
  }

  function Load(text) {
    const raw = parseCsv(text);
    if (!raw.length) return { headers: [], rows: [] };
    const headers = raw[0].map(h => h.trim());
    const ti = headers.findIndex(h => /^time$|^datetime$/i.test(h));
    const list = []; let day = new Date(); day.setHours(0, 0, 0, 0); let prev = null;
    for (let r = 1; r < raw.length; r++) {
      const f = raw[r]; if (f.length < headers.length) continue;
      const V = {}; for (let c = 0; c < headers.length; c++) V[headers[c]] = f[c];
      let t = ti >= 0 ? parseTime(f[ti], day) : new Date(prev ? prev.getTime() + 300 : Date.now());
      if (!t) continue;
      if (ti >= 0 && /^\d\d:/.test(f[ti]) && prev && t < new Date(prev.getTime() - 3600e3)) { day = new Date(day.getTime() + 86400e3); t = new Date(t.getTime() + 86400e3); }
      prev = t;
      list.push({ time: t, V, N: k => { const v = parseFloat(String(V[k] ?? '').replace(/[^0-9.\-]/g, '')); return isFinite(v) ? v : null; }, S: k => V[k] ?? '' });
    }
    return { headers, rows: list };
  }

  // ---- shift detection ----
  function Shifts(rows) {
    const shifts = []; let settled = null, lastSettledIdx = -1, i = 0;
    const avg = xs => { const v = xs.filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; };
    const min = xs => { const v = xs.filter(x => x != null); return v.length ? Math.min(...v) : 0; };
    while (i < rows.length) {
      const g = rows[i].S('gear'); const code = stateCode(g);
      if (code != null) { settled = code; lastSettledIdx = i; i++; continue; }
      if (!isTransition(g) || settled == null) { i++; continue; }
      const start = i;
      while (i < rows.length && isTransition(rows[i].S('gear'))) i++;
      if (i >= rows.length) break;
      const to = stateCode(rows[i].S('gear'));
      if (to == null || to === settled) continue;
      const during = rows.slice(start, i), pre = rows.slice(Math.max(0, start - 4), start);
      const s = {
        time: rows[start].time, from: settled, to, secs: (rows[i].time - rows[start].time) / 1000,
        inBefore: rows[lastSettledIdx].N('input_rpm') || 0, inPeak: Math.max(...during.map(r => r.N('input_rpm') || 0)), inAfter: rows[i].N('input_rpm') || 0,
        pedal: rows[start].N('pedal_pct') || 0, outRpm: rows[start].N('output_rpm') || 0, oilC: rows[start].N('oil_c') || 0,
        oilBefore: avg(pre.map(r => r.N('oil_bar'))), oilMin: min(during.map(r => r.N('oil_bar'))), evmDuring: avg(during.map(r => r.N('evm_pct'))),
      };
      s.fromGear = gearNumber(s.from); s.toGear = gearNumber(s.to);
      s.isUpshift = s.fromGear > 0 && s.toGear > s.fromGear; s.isDownshift = s.toGear > 0 && s.toGear < s.fromGear;
      s.flare = s.isUpshift ? Math.max(0, s.inPeak - s.inBefore) : 0;
      s.name = nameOf(s.from) + ' -> ' + nameOf(s.to);
      shifts.push(s); settled = to; lastSettledIdx = i;
    }
    return shifts;
  }

  const median = xs => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[(s.length - 1) >> 1] : 0; };
  const pct = (xs, p) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0; };
  const r0 = x => Math.round(x), r1 = x => Math.round(x * 10) / 10;

  function Summary(rows) {
    const d = {};
    const moving = rows.filter(r => (r.N('output_rpm') || 0) >= 300 && r.N('input_rpm') != null);
    const settled = moving.filter(r => stateCode(r.S('gear')) != null);
    const shifts = Shifts(rows);
    d['Length'] = rows.length > 1 ? `${r0((rows[rows.length - 1].time - rows[0].time) / 60000)} min, ${rows.length} readings` : `${rows.length} readings`;
    const oil = rows.map(r => r.N('oil_c')).filter(x => x != null);
    if (oil.length) d['Gearbox oil temperature'] = `${r0(Math.min(...oil))}-${r0(Math.max(...oil))} °C`;
    d['Gear changes (up / down)'] = `${shifts.filter(s => s.isUpshift).length} / ${shifts.filter(s => s.isDownshift).length}`;
    [[1, 2], [2, 3], [3, 4]].forEach(([f, t]) => {
      const s = shifts.filter(x => x.fromGear === f && x.toGear === t); if (!s.length) return;
      const flared = s.filter(x => x.flare >= 300).length;
      d[`${f}->${t} changes: flared (>=300 rpm)`] = `${flared} of ${s.length}  (median flare ${r0(median(s.map(x => x.flare)))} rpm, worst ${r0(Math.max(...s.map(x => x.flare)))} rpm)`;
      d[`${f}->${t} changes: median time`] = `${r1(median(s.map(x => x.secs)))} s`;
    });
    if (settled.length) d['Time with converter locked (moving)'] = `${r0(100 * settled.filter(r => lockupTxt(r.S('gear')) === 'yes').length / settled.length)}%`;
    if (moving.length) {
      d['Time above 3000 rpm (moving)'] = `${r1(100 * moving.filter(r => r.N('input_rpm') > 3000).length / moving.length)}%`;
      d['Time above 4000 rpm (moving)'] = `${r1(100 * moving.filter(r => r.N('input_rpm') > 4000).length / moving.length)}%`;
      const fast = moving.filter(r => r.N('output_rpm') >= 2500);
      if (fast.length) d['Revs at higher speeds (median / top 10%)'] = `${r0(median(fast.map(r => r.N('input_rpm'))))} / ${r0(pct(fast.map(r => r.N('input_rpm')), 0.9))} rpm`;
      const ped = moving.map(r => r.N('pedal_pct')).filter(x => x != null);
      if (ped.length) d['Throttle used (median / top 10%)'] = `${r0(median(ped))}% / ${r0(pct(ped, 0.9))}%`;
    }
    const kick = shifts.filter(s => s.isDownshift && s.pedal >= 80);
    if (kick.length) d['Kickdowns'] = kick.map(s => `${s.name} at ${r0(s.pedal)}%`).join('; ');
    return d;
  }

  const pad = (s, n) => { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); };
  const padL = (s, n) => { s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; };
  const hhmmss = t => t.toTimeString().slice(0, 8);
  const trim = (s, n) => s.length <= n ? s : s.slice(0, n - 1) + '…';

  function analyse(rows, name) {
    let o = 'Drive: ' + (name || '') + '\n' + '─'.repeat(22) + '\n';
    const sum = Summary(rows);
    for (const k in sum) o += '  ' + pad(k, 42) + ' ' + sum[k] + '\n';
    const shifts = Shifts(rows).filter(s => s.isUpshift || s.isDownshift);
    o += '\n  Every gear change:\n';
    o += '  ' + pad('time', 9) + ' ' + pad('change', 20) + ' ' + padL('secs', 5) + ' ' + padL('before', 7) + ' ' + padL('peak', 6) + ' ' + padL('flare', 6) + ' ' + padL('thr', 5) + ' ' + padL('oil bar', 9) + ' ' + padL('°C', 4) + '\n';
    shifts.forEach(s => {
      o += '  ' + pad(hhmmss(s.time), 9) + ' ' + pad(s.name, 20) + ' ' + padL(r1(s.secs), 5) + ' ' + padL(r0(s.inBefore), 7) + ' ' + padL(r0(s.inPeak), 6) + ' ' + padL(s.isUpshift ? r0(s.flare) : '', 6) + ' ' + padL(r0(s.pedal) + '%', 5) + ' ' + padL(r1(s.oilBefore) + '>' + r1(s.oilMin), 9) + ' ' + padL(r0(s.oilC), 4) + (s.flare >= 300 ? '  <- flare' : '') + '\n';
    });
    o += '\n  Flare = gearbox input revs rising during an upshift (clutch slip before the next gear grips).\n';
    return o;
  }

  function compare(a, b) {
    const sa = Summary(a.rows), sb = Summary(b.rows);
    let o = 'Comparison\n' + '─'.repeat(22) + '\n';
    o += '  ' + pad('', 40) + ' ' + pad(trim(a.name, 20), 22) + ' ' + trim(b.name, 20) + '\n';
    const keys = [...new Set([...Object.keys(sa), ...Object.keys(sb)])];
    keys.forEach(k => { o += '  ' + pad(k, 40) + ' ' + pad(trim(sa[k] || '-', 20), 22) + ' ' + (sb[k] || '-') + '\n'; });
    o += '\n  Flare under higher throttle (>=30%) during 1->2 and 2->3:\n';
    [a, b].forEach(dr => { const hi = Shifts(dr.rows).filter(s => s.isUpshift && s.toGear <= 3 && s.pedal >= 30); o += '    ' + pad(trim(dr.name, 24), 26) + ' ' + (hi.length === 0 ? 'none' : `${hi.filter(s => s.flare >= 300).length} of ${hi.length} flared, worst ${r0(Math.max(...hi.map(s => s.flare)))} rpm`) + '\n'; });
    o += '\n  Compare drives on the same route, in D, at similar oil temperature.\n';
    return o;
  }

  function trend(drives) {
    drives = drives.filter(d => d.rows.length).sort((a, b) => a.rows[0].time - b.rows[0].time);
    let o = 'Shift quality trend\n' + '─'.repeat(22) + '\n';
    o += '  ' + pad('drive', 22) + ' ' + pad('date', 12) + ' ' + pad('oil°C', 8) + ' ' + pad('1->2', 10) + ' ' + padL('worst', 6) + ' ' + pad('2->3', 10) + ' ' + padL('worst', 6) + '\n';
    const scores = [];
    drives.forEach(dr => {
      const sh = Shifts(dr.rows);
      const s12 = sh.filter(s => s.fromGear === 1 && s.toGear === 2), s23 = sh.filter(s => s.fromGear === 2 && s.toGear === 3);
      const oil = dr.rows.map(r => r.N('oil_c')).filter(x => x != null);
      const F = l => l.length === 0 ? '-' : `${l.filter(x => x.flare >= 300).length} of ${l.length}`;
      const w12 = s12.length ? Math.max(...s12.map(x => x.flare)) : 0, w23 = s23.length ? Math.max(...s23.map(x => x.flare)) : 0;
      const dt = dr.rows[0].time; const date = dt.toLocaleDateString(undefined, { day: '2-digit', month: 'short' }) + ' ' + dt.toTimeString().slice(0, 5);
      o += '  ' + pad(trim(dr.name, 21), 22) + ' ' + pad(date, 12) + ' ' + pad(oil.length ? `${r0(Math.min(...oil))}-${r0(Math.max(...oil))}` : '-', 8) + ' ' + pad(F(s12), 10) + ' ' + padL(r0(w12), 6) + ' ' + pad(F(s23), 10) + ' ' + padL(r0(w23), 6) + '\n';
      const flares = s12.map(x => x.flare).concat(s23.filter(x => x.from === '2').map(x => x.flare));
      scores.push(flares.length ? median(flares) : NaN);
    });
    const valid = scores.filter(x => !isNaN(x));
    o += '\n';
    if (valid.length >= 2) {
      const first = valid[0], last = valid[valid.length - 1];
      if (last < first * 0.7) o += `  ✓ Flare on 1->2 and 2->3 (from unlocked 2nd) is improving: median ${r0(first)} -> ${r0(last)} rpm.\n`;
      else if (last > first * 1.3) o += `  ! Flare is getting worse: median ${r0(first)} -> ${r0(last)} rpm. Check gearbox oil, then the valve body/solenoids.\n`;
      else o += `  Flare is about the same: median ${r0(first)} -> ${r0(last)} rpm.\n`;
    }
    o += '  Same route, in D, similar oil temperature. A gearbox re-learns over several drives after a reset.\n';
    return o;
  }

  // ---- generic CSV guidance (value ranges + what looks out of range) ----
  function guidance(load) {
    const { headers, rows } = load; if (!rows.length) return 'No data rows.';
    const ti = headers.findIndex(h => /^time$/i.test(h));
    let o = rows.length + ' rows'; if (rows[0].time && rows[rows.length - 1].time) o += ', ' + r0((rows[rows.length - 1].time - rows[0].time) / 1000) + ' s'; o += '\n\n';
    const flags = [];
    const stats = headers.map((h, c) => {
      if (c === ti) return null;
      let n = 0, sum = 0, mn = Infinity, mx = -Infinity, last = null, worst = 0, note = '';
      rows.forEach(r => { const v = r.N(h); if (v == null) return; n++; sum += v; last = v; if (v < mn) mn = v; if (v > mx) mx = v; const hh = colHealth(h, v); if (hh && hh.level > worst) { worst = hh.level; note = hh.note; } });
      if (!n) return null;
      if (worst) flags.push({ h, worst, note, mn, avg: sum / n, mx });
      return { h, last, mn, avg: sum / n, mx, worst };
    }).filter(Boolean);
    if (!flags.length) o += '  ✓ Nothing in this log looks out of range.\n';
    else { o += '  Readings worth a look:\n'; flags.forEach(f => o += '  ' + (f.worst === 2 ? '✗' : '!') + ' ' + f.h + ': ' + f.note + '  (min ' + nn(f.mn) + ', avg ' + nn(f.avg) + ', max ' + nn(f.mx) + ')\n'); }
    o += '\n  ' + pad('reading', 24) + padL('last', 10) + padL('min', 10) + padL('avg', 10) + padL('max', 10) + '\n';
    stats.forEach(s => o += '  ' + pad(trim(s.h, 24), 24) + padL(nn(s.last), 10) + padL(nn(s.mn), 10) + padL(nn(s.avg), 10) + padL(nn(s.mx), 10) + (s.worst === 2 ? ' ✗' : s.worst === 1 ? ' !' : '') + '\n');
    return o;
  }
  const nn = v => v == null ? '-' : (Math.abs(v - Math.round(v)) < 1e-6 ? String(Math.round(v)) : (Math.abs(v) >= 100 ? r1(v) : Math.round(v * 100) / 100));
  function colHealth(h, v) {
    const k = h.toLowerCase();
    if (/coolant|oil_c eau/.test(k) && /temp|_c/.test(k) && !/reference|target/.test(k)) return v >= 118 ? { level: 2, note: 'overheating' } : v >= 107 ? { level: 1, note: 'running hot' } : null;
    if (k === 'oil_c' || /oil temp/.test(k)) return v >= 135 ? { level: 2, note: 'gearbox oil very hot' } : v >= 120 ? { level: 1, note: 'gearbox oil hot' } : null;
    if (/volt|battery/.test(k)) return v < 11.8 ? { level: 2, note: 'battery low' } : null;
    if (/trim/.test(k)) return Math.abs(v) > 25 ? { level: 2, note: 'mixture well off' } : Math.abs(v) > 10 ? { level: 1, note: 'mixture correction high' } : null;
    return null;
  }

  // ---- canonical drive row from the gearbox live blocks (same columns as the Windows recordings) ----
  const CANON = ['input_rpm', 'output_rpm', 'gear', 'lever', 'pedal_pct', 'torque_nm', 'brake_no', 'oil_bar', 'guide_bar', 'evm_pct', 'evlu_pct', 'oil_c', 'lockup', 'law', 'programme'];
  function canonicalRow(c3, c4, c5) {
    const at = (b, i) => b && i < b.length ? b[i] : null;
    const gear = at(c3, 2) != null ? gearText(c3[2]) : '';
    const o = {
      input_rpm: at(c5, 6) != null ? c5[6] * 32 : '', output_rpm: at(c5, 7) != null ? c5[7] * 32 : '',
      gear, lever: at(c3, 4) != null ? (LEVER[c3[4]] || '?') : '',
      pedal_pct: at(c3, 11) != null ? r1(c3[11] * 0.39) : '', torque_nm: at(c3, 14) != null ? c3[14] * 2 - 100 : '',
      brake_no: at(c3, 12) != null ? ((c3[12] & 0x04) ? 'Closed' : 'Open') : '',
      oil_bar: at(c5, 18) != null ? Math.round(c5[18] * 0.05 * 100) / 100 : '', guide_bar: at(c5, 16) != null ? r1(c5[16] * 0.1) : '',
      evm_pct: at(c5, 19) != null ? Math.round(c5[19] * 0.4) : '', evlu_pct: at(c5, 20) != null ? Math.round(c5[20] * 0.4) : '',
      oil_c: at(c5, 21) != null ? c5[21] - 50 : '', lockup: lockupTxt(gear),
      law: at(c4, 24) != null ? c4[24] : '', programme: at(c4, 11) != null ? ({ 1: 'Manual', 2: 'Sport' }[(c4[11] & 0x30) >> 4] || 'Eco') : '',
    };
    return o;
  }
  const toCsv = (recs) => { const esc = s => /[",\n]/.test(String(s)) ? '"' + String(s).replace(/"/g, '""') + '"' : s; let o = 'time,' + CANON.join(',') + '\n'; recs.forEach(r => { o += r.t.toISOString().replace('T', ' ').slice(0, 21) + ',' + CANON.map(c => esc(r.v[c] == null ? '' : r.v[c])).join(',') + '\n'; }); return o; };

  root.Analysis = { Load, Shifts, Summary, analyse, compare, trend, guidance, gearText, LEVER, lockupTxt, stateCode, canonicalRow, CANON, toCsv };
})(typeof window !== 'undefined' ? window : globalThis);
if (typeof module !== 'undefined') module.exports = (typeof window !== 'undefined' ? window : globalThis).Analysis;
