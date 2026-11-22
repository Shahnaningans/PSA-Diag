/* psadiag web — parameter catalogue for the Peugeot 206 AL4 gearbox and engine.
   Decode specs verified against psadiag (PSA-RE AL4 layouts + Diagbox), checked on the real car's data.
   Each parameter knows how to read itself and (optionally) how to judge its value. */
(function (root) {
  'use strict';

  // ---- decode helpers (kwp reply = full positive response incl. 0x61 <lid>; obd data = bytes after 41 <pid>) ----
  const u = (b, i, n = 1) => { if (!b || i + n > b.length) return null; let v = 0; for (let k = 0; k < n; k++) v = (v << 8) | b[i + k]; return v; };
  const bit = (b, i, m) => { if (!b || i >= b.length) return null; return (b[i] & m) !== 0; };
  const r1 = x => Math.round(x); const r2 = x => Math.round(x * 100) / 100;

  // kwp numeric: get(lid) -> reply bytes; idx is 0-based index into the full reply (0x61 at 0)
  const kNum = (lid, idx, factor, offset = 0, len = 1) => ({ src: 'kwp', lids: [lid], decode: g => { const v = u(g(lid), idx, len); return v == null ? null : { n: v * factor + offset }; } });
  const kBit = (lid, idx, mask, onText, offText, bad) => ({ src: 'kwp', lids: [lid], decode: g => { const v = bit(g(lid), idx, mask); return v == null ? null : { n: v ? 1 : 0, text: v ? onText : offText, bad: bad && v }; } });
  const oNum = (pid, fn) => ({ src: 'obd', pid, decode: d => { const v = fn(d); return v == null ? null : { n: v }; } });

  // Instant fuel economy (UK mpg). Uses OBD fuel rate (0x5E) if the car has it, else MAF (0x10), else a speed-density
  // estimate from manifold pressure + rpm + intake temp (this 1.6 petrol has no MAF, so the estimate is what's used —
  // it's approximate, within ~10-15%). Stationary = 0; on the overrun (fuel cut) it's capped.
  function mpgFrom(g) {
    const spd = g(0x0D); if (!spd || !spd.length) return null;
    const mph = spd[0] * 0.621371;
    if (mph < 1) return 0;
    let lph = null;
    const fr = g(0x5E);
    if (fr && fr.length >= 2) lph = (fr[0] * 256 + fr[1]) * 0.05;
    else {
      const maf = g(0x10);
      if (maf && maf.length >= 2) lph = ((maf[0] * 256 + maf[1]) / 100) / 14.7 / 745 * 3600;
      else {
        const map = g(0x0B), rpm = g(0x0C), iat = g(0x0F);
        if (map && map.length && rpm && rpm.length >= 2 && iat && iat.length) {
          const MAP = map[0], RPM = (rpm[0] * 256 + rpm[1]) / 4, Tk = (iat[0] - 40) + 273.15;
          const gs = (MAP * 1000 / (287 * Tk)) * ((RPM / 60) * (0.0016 / 2) * 0.80) * 1000;
          lph = gs / 14.7 / 745 * 3600;
        }
      }
    }
    if (lph == null) return null;
    if (lph <= 0.05) return 80;
    return Math.min(80, mph / (lph / 4.546));
  }

  const GEARS = { 0x00: 'N', 0x11: '1st', 0x22: '2nd', 0x33: '3rd', 0x44: '4th' };
  const LEVER = { 0x10: '1', 0x20: '2', 0x30: '3', 0x40: 'D', 0x50: 'R', 0x60: 'N', 0x70: 'P' };
  const PROG = { 1: 'Manual', 2: 'Sport' };

  // ---- health rules (return null | {level:'warn'|'bad', note}) ----
  const H = {
    coolant: n => n >= 118 ? { level: 'bad', note: 'overheating — stop and let it cool' } : n >= 107 ? { level: 'warn', note: 'running hot' } : n <= -39 ? { level: 'bad', note: 'sensor fault likely' } : null,
    oilTemp: n => n >= 135 ? { level: 'bad', note: 'gearbox oil very hot' } : n >= 120 ? { level: 'warn', note: 'gearbox oil hot' } : null,
    voltRun: n => n > 15.2 ? { level: 'bad', note: 'overcharging' } : n < 12.4 ? { level: 'bad', note: 'not charging' } : n < 13.2 ? { level: 'warn', note: 'weak charging' } : null,
    volt: (n, all) => (all.engineRpm > 400 || all.inputRpm > 400) ? H.voltRun(n) : (n < 11.8 ? { level: 'bad', note: 'battery low' } : n < 12.3 ? { level: 'warn', note: 'battery a little low' } : null),
    trim: n => Math.abs(n) > 25 ? { level: 'bad', note: 'mixture well off (leak/MAF/injectors)' } : Math.abs(n) > 10 ? { level: 'warn', note: 'mixture correction high' } : null,
    linePress: (n, all) => ((all.engineRpm > 1000 || all.inputRpm > 1000) && n < 0.8) ? { level: 'warn', note: 'very low line pressure while driving' } : null,
  };

  // ---- the catalogue ----
  // group: 'gearbox' (KWP 0xA4) or 'engine' (OBD). widgets: which display types suit it. def: in the default dashboard.
  const PARAMS = {
    // ---------- gearbox ----------
    gear: { group: 'gearbox', label: 'Gear engaged', kind: 'state', def: true, widgets: ['state'],
      src: 'kwp', lids: [0xC3, 0xC4],
      decode: g => { const c3 = g(0xC3), c4 = g(0xC4); const gv = u(c3, 2); if (gv == null) return null; let t = GEARS[gv] || 'shifting'; const lk = bit(c4, 5, 0x80); const sub = (lk && /2|3|4/.test(t)) ? 'lock-up on' : (lk === false && /2|3|4/.test(t) ? 'lock-up off' : ''); return { text: t, sub }; } },
    lever: { group: 'gearbox', label: 'Lever', kind: 'state', def: true, widgets: ['state'],
      src: 'kwp', lids: [0xC3], decode: g => { const v = u(g(0xC3), 4); return v == null ? null : { text: LEVER[v] || '?' }; } },
    inputRpm: Object.assign({ group: 'gearbox', label: 'Input speed', unit: 'rpm', min: 0, max: 6000, def: true, widgets: ['number', 'dial', 'bar'] }, kNum(0xC5, 6, 32)),
    outputRpm: Object.assign({ group: 'gearbox', label: 'Output speed', unit: 'rpm', min: 0, max: 5000, def: true, widgets: ['number', 'dial', 'bar'] }, kNum(0xC5, 7, 32)),
    oilTemp: Object.assign({ group: 'gearbox', label: 'Oil temperature', unit: '°C', min: 0, max: 140, def: true, widgets: ['number', 'dial', 'bar'], health: H.oilTemp }, kNum(0xC5, 21, 1, -50)),
    oilPress: Object.assign({ group: 'gearbox', label: 'Oil pressure', unit: 'bar', min: 0, max: 12, dp: 2, def: true, widgets: ['number', 'dial', 'bar'], health: H.linePress }, kNum(0xC5, 18, 0.05)),
    guidePress: Object.assign({ group: 'gearbox', label: 'Guide pressure', unit: 'bar', min: 0, max: 12, dp: 2, def: true, widgets: ['number', 'dial', 'bar'] }, kNum(0xC5, 16, 0.1)),
    evm: Object.assign({ group: 'gearbox', label: 'EVM duty', unit: '%', min: 0, max: 100, def: true, widgets: ['number', 'dial', 'bar'] }, kNum(0xC5, 19, 0.4)),
    evlu: Object.assign({ group: 'gearbox', label: 'EVLU duty', unit: '%', min: 0, max: 100, def: true, widgets: ['number', 'dial', 'bar'] }, kNum(0xC5, 20, 0.4)),
    engineRpmG: Object.assign({ group: 'gearbox', label: 'Engine speed', unit: 'rpm', min: 0, max: 6000, widgets: ['number', 'dial', 'bar'] }, kNum(0xC5, 5, 32)),
    pedal: Object.assign({ group: 'gearbox', label: 'Pedal', unit: '%', min: 0, max: 100, def: true, widgets: ['number', 'dial', 'bar'] }, kNum(0xC3, 11, 0.39)),
    torque: Object.assign({ group: 'gearbox', label: 'Torque', unit: 'Nm', min: -100, max: 300, def: true, widgets: ['number', 'dial', 'bar'] }, kNum(0xC3, 14, 2, -100)),
    brake1: Object.assign({ group: 'gearbox', label: 'Brake contact 1 (normally open)', kind: 'switch', def: true, widgets: ['switch'] }, kBit(0xC3, 12, 0x04, 'Closed', 'Open')),
    brake2: Object.assign({ group: 'gearbox', label: 'Brake contact 2 (normally closed)', kind: 'switch', def: true, widgets: ['switch'] }, kBit(0xC3, 12, 0x02, 'Closed', 'Open')),
    kickdown: Object.assign({ group: 'gearbox', label: 'Kickdown', kind: 'switch', def: true, widgets: ['switch'] }, kBit(0xC3, 12, 0x08, 'Closed', 'Open')),
    sport: Object.assign({ group: 'gearbox', label: 'Sport button', kind: 'switch', widgets: ['switch'] }, kBit(0xC3, 10, 0x01, 'On', 'Off')),
    snow: Object.assign({ group: 'gearbox', label: 'Snow button', kind: 'switch', widgets: ['switch'] }, kBit(0xC3, 10, 0x02, 'On', 'Off')),
    pn: { group: 'gearbox', label: 'Multifunction P/N', kind: 'switch', def: true, widgets: ['switch'], src: 'kwp', lids: [0xC3], decode: g => { const v = bit(g(0xC3), 5, 0x20); return v == null ? null : { n: v ? 0 : 1, text: v ? 'inactive' : 'Active' }; } },
    lockup: Object.assign({ group: 'gearbox', label: 'Converter lock-up', kind: 'switch', widgets: ['switch'] }, kBit(0xC4, 5, 0x80, 'Locked', 'Open')),
    program: { group: 'gearbox', label: 'Shift programme', kind: 'state', widgets: ['state'], src: 'kwp', lids: [0xC4], decode: g => { const b = g(0xC4); if (!b || b.length < 12) return null; const v = (b[11] & 0x30) >> 4; return { text: PROG[v] || 'Auto' }; } },
    oilChangeDue: Object.assign({ group: 'gearbox', label: 'Oil change required', kind: 'switch', widgets: ['switch'] }, kBit(0xC4, 3, 0x04, 'YES', 'no', true)),

    // ---------- engine (standard OBD) ----------
    engineRpm: Object.assign({ group: 'engine', label: 'Engine speed', unit: 'rpm', min: 0, max: 7000, def: true, widgets: ['number', 'dial', 'bar'] }, oNum(0x0C, d => u(d, 0, 2) == null ? null : u(d, 0, 2) / 4)),
    speed: Object.assign({ group: 'engine', label: 'Vehicle speed', unit: 'mph', min: 0, max: 130, def: true, widgets: ['number', 'dial', 'bar'] }, oNum(0x0D, d => u(d, 0) == null ? null : u(d, 0) * 0.621371)),
    mpg: { group: 'engine', label: 'Fuel economy (instant)', unit: 'mpg', min: 0, max: 80, dp: 1, def: true, widgets: ['number', 'dial', 'bar'], src: 'computed', needs: [0x0D, 0x5E, 0x10, 0x0B, 0x0C, 0x0F], compute: mpgFrom },
    coolant: Object.assign({ group: 'engine', label: 'Coolant temperature', unit: '°C', min: -40, max: 130, def: true, widgets: ['number', 'dial', 'bar'], health: H.coolant }, oNum(0x05, d => u(d, 0) == null ? null : u(d, 0) - 40)),
    iat: Object.assign({ group: 'engine', label: 'Intake air temp', unit: '°C', min: -20, max: 90, widgets: ['number', 'dial', 'bar'] }, oNum(0x0F, d => u(d, 0) == null ? null : u(d, 0) - 40)),
    map: Object.assign({ group: 'engine', label: 'Manifold pressure', unit: 'kPa', min: 0, max: 255, widgets: ['number', 'dial', 'bar'] }, oNum(0x0B, d => u(d, 0))),
    load: Object.assign({ group: 'engine', label: 'Calculated load', unit: '%', min: 0, max: 100, def: true, widgets: ['number', 'dial', 'bar'] }, oNum(0x04, d => u(d, 0) == null ? null : u(d, 0) * 100 / 255)),
    throttle: Object.assign({ group: 'engine', label: 'Throttle position', unit: '%', min: 0, max: 100, def: true, widgets: ['number', 'dial', 'bar'] }, oNum(0x11, d => u(d, 0) == null ? null : u(d, 0) * 100 / 255)),
    advance: Object.assign({ group: 'engine', label: 'Ignition advance', unit: '°', min: -20, max: 50, widgets: ['number', 'dial', 'bar'] }, oNum(0x0E, d => u(d, 0) == null ? null : u(d, 0) / 2 - 64)),
    stft: Object.assign({ group: 'engine', label: 'Short-term fuel trim', unit: '%', min: -30, max: 30, def: true, widgets: ['number', 'dial', 'bar'], health: H.trim }, oNum(0x06, d => u(d, 0) == null ? null : (u(d, 0) - 128) * 100 / 128)),
    ltft: Object.assign({ group: 'engine', label: 'Long-term fuel trim', unit: '%', min: -30, max: 30, def: true, widgets: ['number', 'dial', 'bar'], health: H.trim }, oNum(0x07, d => u(d, 0) == null ? null : (u(d, 0) - 128) * 100 / 128)),
    o2a: Object.assign({ group: 'engine', label: 'O2 sensor 1 (upstream)', unit: 'V', min: 0, max: 1, dp: 2, widgets: ['number', 'dial', 'bar'] }, oNum(0x14, d => u(d, 0) == null ? null : u(d, 0) / 200)),
    o2b: Object.assign({ group: 'engine', label: 'O2 sensor 2 (downstream)', unit: 'V', min: 0, max: 1, dp: 2, widgets: ['number', 'dial', 'bar'] }, oNum(0x15, d => u(d, 0) == null ? null : u(d, 0) / 200)),
    voltage: Object.assign({ group: 'engine', label: 'ECU voltage', unit: 'V', min: 8, max: 16, dp: 1, def: true, widgets: ['number', 'dial', 'bar'], health: H.volt }, oNum(0x42, d => u(d, 0, 2) == null ? null : u(d, 0, 2) / 1000)),
  };

  // default dashboards (order matters)
  const DEFAULTS = {
    gearbox: [
      { id: 'gear', w: 'state' }, { id: 'lever', w: 'state' },
      { id: 'inputRpm', w: 'number' }, { id: 'outputRpm', w: 'number' }, { id: 'oilTemp', w: 'number' },
      { id: 'oilPress', w: 'number' }, { id: 'guidePress', w: 'number' }, { id: 'evm', w: 'number' },
      { id: 'pedal', w: 'number' }, { id: 'torque', w: 'number' }, { id: 'evlu', w: 'number' },
      { id: 'brake1', w: 'switch' }, { id: 'brake2', w: 'switch' }, { id: 'kickdown', w: 'switch' }, { id: 'pn', w: 'switch' },
    ],
    engine: [
      { id: 'engineRpm', w: 'dial' }, { id: 'speed', w: 'number' }, { id: 'mpg', w: 'number' },
      { id: 'coolant', w: 'number' }, { id: 'throttle', w: 'bar' }, { id: 'load', w: 'bar' },
      { id: 'voltage', w: 'number' }, { id: 'stft', w: 'number' }, { id: 'ltft', w: 'number' },
    ],
  };

  root.Catalog = { PARAMS, DEFAULTS, fmt: (p, n) => n == null ? '--' : (p.dp === 2 ? r2(n) : p.dp === 1 ? Math.round(n * 10) / 10 : r1(n)) };
})(typeof window !== 'undefined' ? window : globalThis);
if (typeof module !== 'undefined') module.exports = (typeof window !== 'undefined' ? window : globalThis).Catalog;
