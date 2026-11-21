/* psadiag web — Diagbox data: build requests, decode answers, list tests, decode faults.
   Port of DiagboxData.cs. Uses window.PSADIAG_PACK (pack.js). answer = full positive reply incl. service byte at [0]. */
(function (root) {
  'use strict';
  const PACK = root.PSADIAG_PACK || {};
  const ENGINE_ECUS = ['J34P', 'ME745', 'ME749', 'ME747', 'MM6LP', 'S2000PM2'];
  const GEARBOX = 'BVA_AL4';

  const ecuOf = name => PACK.ecus && PACK.ecus.find(e => e.ecu.toUpperCase() === (name || '').toUpperCase());
  const unitOf = (ecu, name) => ecu && ecu.units.find(u => u.name.toUpperCase() === name.toUpperCase());

  // ---- param accessors ----
  const pPos = p => parseInt(p.pos, 10) || 0;
  const pLen = p => { const l = parseInt(p.len, 10); return l > 0 ? l : (p.bits === '16' ? 2 : 1); };
  const pMask = p => (p.mask && p.mask.length) ? parseInt(p.mask, 2) : null;
  const pFactor = p => p.factor != null && p.factor !== '' ? parseFloat(p.factor) : null;
  const pOffset = p => p.offset != null && p.offset !== '' ? parseFloat(p.offset) : 0;

  function prettify(s) {
    if (!s) return '';
    if (s.indexOf('_') >= 0 && s === s.toUpperCase()) {
      for (const pre of ['CA_POS_LEVIER_VITESSE_', 'DTC_STATUT_', 'MP_', 'CA_']) if (s.startsWith(pre)) { s = s.slice(pre.length); break; }
      s = s.replace(/_/g, ' ').toLowerCase();
    }
    return s.length ? s[0].toUpperCase() + s.slice(1) : s;
  }
  const label = p => { const l = p.label && p.label.trim(); return (!l || l === p.name) ? prettify((p.name || '').replace('MP_DATE_FAB', 'date of manufacture')) : l; };

  function unitName(uRaw) {
    const map = { 'Tr/Mn': 'rpm', 'Tour/Minute': 'rpm', 'tr/min': 'rpm', 'Pourcent': '%', 'Volt(s)': 'V', 'Volt': 'V', 'milliSeconde': 'ms', 'ms (milliseconds)': 'ms', 'Kilomètre/Heure': 'km/h', 'kph': 'km/h', 'Degrés Celsius': '°C', 'Newton*Mètre': 'Nm', 'N.m': 'Nm', 'Bar': 'bar', 'bar(s)': 'bar', 'bars': 'bar', 'Ampère': 'A', 'mv': 'mV', 'mbars': 'mbar', 'Open cycle ratio': '%' };
    if (!uRaw || uRaw === 'Undefined' || uRaw === '-') return '';
    const t = uRaw.trim(); return map[t] || t;
  }

  // ---- big-endian helpers ----
  const be = (data, at, len) => { let n = 0; for (let i = 0; i < len; i++) n = n * 256 + data[at + i]; return n; };

  function value(p, data, at) {
    const len = pLen(p), mask = pMask(p), unit = unitName(p.unit);
    if (at < 0 || at + len > data.length) return null;
    if (mask != null) {
      const raw = len >= 2 && at + 1 < data.length ? (data[at] << 8 | data[at + 1]) : data[at];
      const masked = raw & mask; let shift = 0; while (shift < 16 && ((mask >> shift) & 1) === 0) shift++;
      const val = masked >> shift;
      const bin = masked.toString(2).padStart(len * 8, '0');
      const st = (p.states || []).find(s => s.v === bin) || (p.states || []).find(s => s.v === String(val)) || (p.states || []).find(s => /^[0-9a-fA-F]+$/.test(s.v) && parseInt(s.v, 16) === masked);
      const single = (mask & (mask - 1)) === 0;
      const text = st ? stateText(st) : (single ? (val === 1 ? 'yes' : 'no') : String(val));
      return { name: p.name, label: label(p), text, n: val, unit: '' };
    }
    const bytes = data.slice(at, at + Math.min(len, data.length - at));
    const hex = bytes.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join('');
    const exact = (p.states || []).find(s => s.min == null && s.v && s.v.toUpperCase() === hex);
    const enc = (p.enc || '').toUpperCase();
    const factor = pFactor(p);
    if (enc === 'UNM' || enc === 'SNM' || enc === 'FLOAT' || factor != null) {
      let n = be(bytes, 0, bytes.length);
      if (enc === 'SNM' && bytes.length && (bytes[0] & 0x80)) n -= Math.pow(2, 8 * bytes.length);
      const phys = n * (factor != null ? factor : 1) + pOffset(p);
      if (exact && exact.label) return { name: p.name, label: label(p), text: stateText(exact), n: phys, unit };
      const range = (p.states || []).find(s => s.min != null && s.max != null && n >= parseFloat(s.min) && n <= parseFloat(s.max));
      if (range && range.label) return { name: p.name, label: label(p), text: stateText(range), n: phys, unit };
      return { name: p.name, label: label(p), text: num(phys) + (unit ? ' ' + unit : ''), n: phys, unit };
    }
    if (exact) return { name: p.name, label: label(p), text: stateText(exact), n: null, unit: '' };
    if (bytes.length === 3 && /DATE/i.test(p.name)) {
      if (bytes.every(b => b === 0) || bytes.every(b => b === 0xFF)) return { name: p.name, label: label(p), text: 'not recorded', n: null };
      if (bytes.every(b => (b >> 4) < 10 && (b & 15) < 10)) return { name: p.name, label: label(p), text: `${hx(bytes[0])}/${hx(bytes[1])}/20${hx(bytes[2])}`, n: null };
    }
    if (enc === 'ASCII') return { name: p.name, label: label(p), text: bytes.map(b => String.fromCharCode(b)).join('').replace(/[\0 ]+$/, ''), n: null };
    if ((p.states || []).length && bytes.length === 1) return { name: p.name, label: label(p), text: 'code ' + hex, n: bytes[0] };
    return { name: p.name, label: label(p), text: hex, n: null };
  }
  const hx = b => b.toString(16).toUpperCase().padStart(2, '0');
  const stateText = s => prettify(s.label && s.label.trim() ? s.label : s.name);
  const num = v => Math.abs(v - Math.round(v)) < 1e-6 ? String(Math.round(v)) : (Math.abs(v) >= 100 ? (Math.round(v * 10) / 10) : (Math.round(v * 100) / 100)).toString();

  function decode(unit, answer, includeRaw) {
    const out = [], seen = new Set();
    for (const p of (unit.ok || []).filter(p => p.block == null && p.type !== 'BLOCK').sort((a, b) => pPos(a) - pPos(b))) {
      if (pPos(p) <= 2 && (p.name === 'SID' || p.name === 'LID')) continue;
      if (!includeRaw && (/^OCTET/i.test(p.name) || /^BYTE/i.test(p.name))) continue;
      const key = pPos(p) + ':' + pMask(p); if (seen.has(key)) continue; seen.add(key);
      if (pPos(p) < 1 || pPos(p) - 1 + pLen(p) > answer.length) continue;
      const v = value(p, answer, pPos(p) - 1); if (v) out.push(v);
    }
    return out;
  }

  function request(unit, variable) {
    variable = variable || []; const bytes = []; let vi = 0;
    for (const p of (unit.req || []).filter(p => p.type !== 'BLOCK').sort((a, b) => pPos(a) - pPos(b))) {
      if (p.value && p.value.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(p.value)) for (let i = 0; i < p.value.length; i += 2) bytes.push(parseInt(p.value.substr(i, 2), 16));
      else for (let i = 0; i < pLen(p) && vi < variable.length; i++) bytes.push(variable[vi++]);
    }
    return bytes;
  }

  function recognise(answer, among) {
    if (!answer || answer.length < 2) return null;
    const req = '21' + hx(answer[1]);
    const allow = among ? among.map(x => x.toUpperCase()) : null;
    for (const r of (PACK.reco || [])) {
      if (r.req.toUpperCase() !== req || (allow && allow.indexOf(r.ecu.toUpperCase()) < 0)) continue;
      const pos = parseInt(r.pos, 10), len = parseInt(r.len, 10);
      if (!pos || !len || pos < 1 || pos - 1 + len > answer.length) continue;
      const hexv = answer.slice(pos - 1, pos - 1 + len).map(hx).join('');
      if (hexv.toUpperCase() === r.value.toUpperCase()) return { ecu: r.ecu, variant: r.variant };
    }
    return null;
  }

  function tidy(s) {
    const words = [['Relais compresseur de climatisation', 'air conditioning compressor relay'], ['Electrovanne EGR', 'EGR valve'], ['Electrovanne purge canister', 'canister purge valve'], ['Pompe à essence', 'fuel pump'], ['Papillon motorisé', 'motorised throttle'], ['Groupe motoventilateur grande vitesse', 'radiator fan, high speed'], ['Groupe motoventilateur petite vitesse', 'radiator fan, low speed'], ['Chauffage sonde amont', 'upstream oxygen sensor heater'], ['Chauffage sonde aval', 'downstream oxygen sensor heater'], ['Relais pompe à air', 'air pump relay'], ['Bobine', 'coil'], ['Injecteur', 'injector'], ['Injectors', 'injector'], ['Voyant', 'warning lamp']];
    for (const [fr, en] of words) s = s.split(fr).join(en);
    s = s.replace(' / ( / ', ' (').replace(' / )', ')').replace(' / / / ', ' / ').trim();
    return s.length ? s[0].toUpperCase() + s.slice(1) : s;
  }
  function testLabel(ecu, u) {
    if (PACK.tests && PACK.tests[u.name]) return tidy(PACK.tests[u.name]);
    const d = (u.desc || u.name).replace('Test actionneur', '').trim();
    return tidy(d.length ? d : u.name);
  }
  function tests(ecu) {
    const seen = {}, out = [];
    for (const u of ecu.units.filter(u => u.service === 'IOCBLID' && u.name.startsWith('IOCBLID_TA_'))) {
      const r = request(u, [0x00]); if (r.length < 2 || r[0] !== 0x30) continue;
      if (seen[r[1]]) continue; seen[r[1]] = 1;
      out.push({ id: r[1], name: u.name, label: testLabel(ecu, u) });
    }
    return out.sort((a, b) => a.id - b.id);
  }

  function faultText(ecu, code) {
    if (!ecu) return null;
    for (const c of [code, code.replace(/^0+/, ''), code.padStart(4, '0')]) if (c && ecu.faults[c]) return tidy(ecu.faults[c]);
    return null;
  }
  function faults(unit, answer) {
    if (!answer || answer.length < 2) return null;
    const inBlock = (unit.ok || []).filter(p => p.block != null && p.type !== 'BLOCK');
    const blk = inBlock.length ? inBlock[0].block : null;
    const start = blk && parseInt(blk.pos, 10) ? parseInt(blk.pos, 10) : 3;
    const size = blk && parseInt(blk.len, 10) ? parseInt(blk.len, 10) : 3;
    const codeP = inBlock.find(p => p.name === 'DTC_CODE');
    const statP = inBlock.find(p => p.name.startsWith('DTC_STATUS'));
    const out = [];
    for (let at = start - 1; at + size <= answer.length; at += size) {
      const rec = answer.slice(at, at + size);
      let raw = rec.length >= 2 ? (rec[0] << 8 | rec[1]) : rec[0];
      if (codeP && pMask(codeP) != null) raw &= pMask(codeP);
      const code = raw.toString(16).toUpperCase().padStart(4, '0');
      let state = 'stored', present = false;
      if (statP && (statP.states || []).some(s => s.v && s.v.length) && value(statP, rec, pPos(statP) - 1)) {
        const sv = value(statP, rec, pPos(statP) - 1); state = sv.text; present = /permanent|present/i.test(sv.text);
      } else if (rec.length >= 3) { const st = rec[2]; const s2 = (st >> 5) & 3; present = s2 === 3; state = s2 === 3 ? 'present' : s2 === 2 ? 'intermittent' : s2 === 1 ? 'stored (not present now)' : 'stored'; }
      const cond = []; const seen = new Set();
      for (const p of inBlock.filter(p => p !== codeP && p !== statP).sort((a, b) => pPos(a) - pPos(b))) {
        const key = pPos(p) + ':' + pMask(p); if (seen.has(key)) continue; seen.add(key);
        if (pPos(p) >= 1 && pPos(p) - 1 + pLen(p) <= rec.length) { const v = value(p, rec, pPos(p) - 1); if (v) cond.push(v); }
      }
      out.push({ code, state: prettify(state), present, conditions: cond });
    }
    return out;
  }

  // live-measurement blocks (RDBLID "MESURES PARAMETRES")
  function blocks(ecu) {
    const seen = {}, out = [];
    for (const u of ecu.units.filter(u => u.service === 'RDBLID')) {
      const r = request(u); if (r.length < 2 || r[0] !== 0x21) continue;
      if (seen[r[1]]) continue; seen[r[1]] = 1; out.push({ lid: r[1], unit: u });
    }
    return out.sort((a, b) => a.lid - b.lid);
  }
  const liveBlocks = ecu => blocks(ecu).filter(b => /MESURE/i.test(b.unit.desc || ''));

  root.Dbx = { PACK, ENGINE_ECUS, GEARBOX, ecuOf, unitOf, decode, request, recognise, tests, faults, faultText, blocks, liveBlocks, label, unitName, NEGtext: null };
})(typeof window !== 'undefined' ? window : globalThis);
if (typeof module !== 'undefined') module.exports = (typeof window !== 'undefined' ? window : globalThis).Dbx;
