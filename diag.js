/* psadiag web — adapter transport + ELM327 + OBD + KWP2000 (Peugeot/AL4).
   Works in a browser with Web Bluetooth (Bluefy on iOS, Chrome on Android), and in Node with a mock transport for tests. */
(function (root) {
  'use strict';

  // ---- helpers ----
  const hex = b => b.toString(16).toUpperCase().padStart(2, '0');
  const toHex = arr => Array.from(arr, hex).join(' ');
  const fromHex = s => { const t = s.replace(/[^0-9a-fA-F]/g, ''); const a = []; for (let i = 0; i + 1 < t.length; i += 2) a.push(parseInt(t.substr(i, 2), 16)); return a; };
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ---------------------------------------------------------------- transport (Web Bluetooth)
  // ELM327 BLE adapters expose a serial bridge. Known service/char UUID sets; we discover whichever is present.
  const BLE_PROFILES = [
    { svc: '0000fff0-0000-1000-8000-00805f9b34fb', write: '0000fff2-0000-1000-8000-00805f9b34fb', notify: '0000fff1-0000-1000-8000-00805f9b34fb' },
    { svc: '0000ffe0-0000-1000-8000-00805f9b34fb', write: '0000ffe1-0000-1000-8000-00805f9b34fb', notify: '0000ffe1-0000-1000-8000-00805f9b34fb' },
    { svc: '0000ffe5-0000-1000-8000-00805f9b34fb', write: '0000ffe9-0000-1000-8000-00805f9b34fb', notify: '0000ffe4-0000-1000-8000-00805f9b34fb' },
    { svc: '18f0', write: '2af1', notify: '2af0' },
  ];
  const BLE_SERVICES = ['0000fff0-0000-1000-8000-00805f9b34fb', '0000ffe0-0000-1000-8000-00805f9b34fb', '0000ffe5-0000-1000-8000-00805f9b34fb', 0x18f0];

  class BleTransport {
    constructor() { this.buf = ''; this._write = null; this.description = 'BLE ELM327'; this.device = null; }
    async connect() {
      if (!navigator.bluetooth) throw new Error('This browser has no Web Bluetooth. On iPhone use the Bluefy browser; on Android use Chrome.');
      const device = await navigator.bluetooth.requestDevice({ optionalServices: BLE_SERVICES, acceptAllDevices: true });
      this.device = device; this.description = device.name || 'BLE ELM327';
      const server = await device.gatt.connect();
      let lastErr;
      for (const p of BLE_PROFILES) {
        try {
          const svc = await server.getPrimaryService(p.svc);
          const wc = await svc.getCharacteristic(p.write);
          const nc = await svc.getCharacteristic(p.notify);
          await nc.startNotifications();
          nc.addEventListener('characteristicvaluechanged', e => {
            const v = e.target.value; let s = '';
            for (let i = 0; i < v.byteLength; i++) s += String.fromCharCode(v.getUint8(i));
            this.buf += s;
          });
          this._write = async (line) => {
            const data = new TextEncoder().encode(line + '\r');
            for (let i = 0; i < data.length; i += 20) {
              const chunk = data.slice(i, i + 20);
              if (wc.writeValueWithoutResponse) await wc.writeValueWithoutResponse(chunk); else await wc.writeValue(chunk);
            }
          };
          device.addEventListener('gattserverdisconnected', () => { if (this.onDisconnect) this.onDisconnect(); });
          return;
        } catch (e) { lastErr = e; }
      }
      throw new Error('Could not find the ELM327 serial service on this adapter. ' + (lastErr ? lastErr.message : ''));
    }
    write(line) { this.buf = ''; return this._write(line); }
    async readUntilPrompt(timeoutMs) {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) { if (this.buf.indexOf('>') >= 0) { const r = this.buf; this.buf = ''; return r; } await sleep(20); }
      const r = this.buf; this.buf = ''; return r;
    }
    disconnect() { try { this.device && this.device.gatt && this.device.gatt.disconnect(); } catch (e) {} }
  }

  // ---------------------------------------------------------------- ELM327
  class Elm327 {
    constructor(transport) { this.t = transport; this.verbose = false; this.obdSessionOpen = false; this.log = null; }
    async cmd(line, timeoutMs = 4000) {
      await this.t.write(line);
      const raw = await this.t.readUntilPrompt(timeoutMs);
      if (this.log) this.log('>> ' + line + '  << ' + raw.replace(/[\r\n]+/g, ' ').trim());
      return raw.split(/[\r\n]+/).map(s => s.trim()).filter(s => s && s.toUpperCase() !== line.toUpperCase() && !/^SEARCHING/i.test(s));
    }
    async at(line, timeoutMs = 2500) { const lines = await this.cmd(line, timeoutMs); return lines.join(' '); }
    async initialise() {
      await this.cmd('ATZ', 2000); await sleep(300);
      for (const c of ['ATE0', 'ATL0', 'ATS1', 'ATH0', 'ATAT1']) await this.at(c);
    }
    async voltage() { try { return (await this.at('ATRV')).trim(); } catch (e) { return '?'; } }
    // Parsed frames (headers on): {fmt, source, data[]} with checksum verified.
    async requestFrames(payload, timeoutMs = 6000) {
      const lines = await this.cmd(payload, timeoutMs);
      const frames = [];
      for (let line of lines) {
        line = line.replace(/BUS INIT:.*OK/i, '').replace(/^\.*/, '').trim();
        const b = fromHex(line);
        if (b.length < 4) continue;
        const sum = b.slice(0, b.length - 1).reduce((a, x) => (a + x) & 0xFF, 0);
        if (sum !== b[b.length - 1]) continue;              // bad checksum
        const fmt = b[0]; let len = fmt & 0x3F, dataStart = 3;
        if (len === 0) { len = b[3]; dataStart = 4; }
        const source = b[2];
        frames.push({ source, data: b.slice(dataStart, dataStart + len) });
      }
      return frames;
    }
    // OBD reply lines (headers off): array of byte arrays.
    async requestObd(payload, timeoutMs = 6000) {
      const lines = await this.cmd(payload, timeoutMs);
      return lines.map(l => l.replace(/BUS INIT:.*OK/i, '').trim()).map(fromHex).filter(a => a.length);
    }
  }

  // ---------------------------------------------------------------- standard OBD-II
  class Obd {
    constructor(elm) { this.elm = elm; this.protocol = ''; }
    async connect() {
      await this.elm.at('ATPC'); await this.elm.at('ATSP0'); await this.elm.at('ATH0');
      this.elm.obdSessionOpen = true;
      const r = await this.pid(0x00);
      if (!r) return false;
      this.protocol = await this.elm.at('ATDP');
      return true;
    }
    async pid(p) {
      const msgs = await this.elm.requestObd('01' + hex(p), 6000);
      const m = msgs.find(x => x.length >= 2 && x[0] === 0x41 && x[1] === p);
      return m ? m.slice(2) : null;
    }
    async dtcs(pending) {
      const msgs = await this.elm.requestObd(pending ? '07' : '03', 6000);
      const out = [];
      for (const m of msgs) {
        if (!m.length || m[0] !== (pending ? 0x47 : 0x43)) continue;
        const start = m.length % 2 === 0 ? 2 : 1;
        for (let i = start; i + 1 < m.length; i += 2) { const c = (m[i] << 8) | m[i + 1]; if (c) out.push('PCBU'[c >> 14] + (c & 0x3FFF).toString(16).toUpperCase().padStart(4, '0')); }
      }
      return [...new Set(out)];
    }
    async clear() { const m = await this.elm.requestObd('04', 6000); return m.some(x => x.length && x[0] === 0x44); }

    // mode 01 PID 01: MIL + monitor completeness
    async readiness() {
      const d = await this.pid(0x01); if (!d || d.length < 4) return null;
      const cont = ['Misfire', 'Fuel system', 'Components'];
      const spark = ['Catalyst', 'Heated catalyst', 'Evaporative system', 'Secondary air', 'A/C refrigerant', 'Oxygen sensor', 'Oxygen sensor heater', 'EGR system'];
      const diesel = ['NMHC catalyst', 'NOx after-treatment', '', 'Boost pressure', '', 'Exhaust gas sensor', 'Particulate filter', 'EGR/VVT system'];
      const mon = [];
      for (let i = 0; i < 3; i++) if (d[1] & (1 << i)) mon.push({ name: cont[i], complete: (d[1] & (1 << (i + 4))) === 0 });
      const isDiesel = (d[1] & 0x08) !== 0, names = isDiesel ? diesel : spark;
      for (let i = 0; i < 8; i++) if ((d[2] & (1 << i)) && names[i]) mon.push({ name: names[i], complete: (d[3] & (1 << i)) === 0 });
      return { mil: (d[0] & 0x80) !== 0, count: d[0] & 0x7F, diesel: isDiesel, monitors: mon };
    }
    // mode 02 freeze frame
    async freezePid(p) { const msgs = await this.elm.requestObd('02' + hex(p) + '00', 8000); const m = msgs.find(x => x.length >= 3 && x[0] === 0x42 && x[1] === p); return m ? m.slice(3) : null; }
    async freezeDtc() { const d = await this.freezePid(0x02); if (!d || d.length < 2) return null; const c = d[0] << 8 | d[1]; return c === 0 ? null : 'PCBU'[c >> 14] + (c & 0x3FFF).toString(16).toUpperCase().padStart(4, '0'); }
    // mode 09 vehicle info (02 VIN, 04 cal id)
    async vehicleInfo(t) { const msgs = (await this.elm.requestObd('09' + hex(t), 10000)).filter(m => m.length >= 3 && m[0] === 0x49 && m[1] === t).sort((a, b) => a[2] - b[2]); if (!msgs.length) return null; const bytes = []; msgs.forEach(m => m.slice(3).forEach(b => { if (b >= 0x20 && b < 0x7F) bytes.push(b); })); const s = bytes.map(b => String.fromCharCode(b)).join('').trim(); return s || null; }
  }

  // ---------------------------------------------------------------- KWP2000 over K-line (Peugeot / AL4)
  const ENGINE = 0x10, GEARBOX = 0xA4, TESTER = 0xF1;
  class Kwp {
    constructor(elm, target) { this.elm = elm; this.target = target; }
    async connect() {
      // If OBD was used, the engine stays in that session ~5 s and refuses Peugeot requests. Close and wait.
      if (this.target === ENGINE && this.elm.obdSessionOpen) { try { await this.elm.at('ATPC'); } catch (e) {} await sleep(6000); this.elm.obdSessionOpen = false; }
      await this.elm.at('ATPC'); await sleep(400);
      await this.elm.at('ATSP5');
      await this.elm.at('ATSH 81 ' + hex(this.target) + ' F1');
      await this.elm.at('ATAL'); await this.elm.at('ATH1');
      await this.elm.at('ATWM 81 ' + hex(this.target) + ' F1 3E');
      const r = await this.send([0x81]);
      return !!(r && (r.ok || r.negative != null));
    }
    // Returns {ok: data[]|null, negative: code|null}. Filters to frames from our target; handles 0x78 pending.
    async send(req) {
      const frames = (await this.elm.requestFrames(toHex(req), 6000)).filter(f => f.source === this.target);
      let ok = null, negative = null;
      for (const f of frames) {
        const m = f.data;
        if (m.length >= 3 && m[0] === 0x7F && m[1] === req[0]) { if (m[2] === 0x78) continue; negative = m[2]; continue; }
        if (m.length && m[0] === ((req[0] + 0x40) & 0xFF)) ok = ok ? ok.concat(m.slice(1)) : m;
      }
      return { ok, negative };
    }
    async read(lid) { const r = await this.send([0x21, lid]); return r.ok; }                 // full reply incl 61 <lid>
    async disconnect() { try { await this.send([0x82]); } catch (e) {} try { await this.elm.at('ATPC'); await this.elm.at('ATH0'); } catch (e) {} }
  }

  const NEG = { 0x11: 'not supported', 0x12: 'not supported in this form', 0x21: 'busy, retry', 0x22: 'conditions not correct (engine off? lever in P?)', 0x31: 'out of range', 0x33: 'security access required', 0x78: 'pending', 0x80: 'wrong session' };

  root.Diag = { BleTransport, Elm327, Obd, Kwp, ENGINE, GEARBOX, TESTER, NEG, hex, toHex, fromHex, sleep };
})(typeof window !== 'undefined' ? window : globalThis);
if (typeof module !== 'undefined') module.exports = (typeof window !== 'undefined' ? window : globalThis).Diag;
