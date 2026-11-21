# psadiag web — live diagnostics in the browser

A web version of psadiag for the **Peugeot 206 / 206 CC (AL4 automatic)** that talks to a **BLE ELM327** adapter straight
from the browser, with a **custom dashboard** you build yourself (big numbers, round dials, or bars).

![it looks like the mockup: gear + lever cards, a 3-up grid of readings, a switches list]

## What you need

- Your **BLE ELM327** adapter (the one that already works with Car Scanner on your iPhone).
- On **iPhone**: the free **Bluefy – Web BLE Browser** app (Safari and Chrome on iOS can't use Bluetooth).
- On **Android**: just **Chrome**.

## Run it — two ways

**A. Host it (recommended, works on any phone):**
1. Put the five files (`index.html`, `app.css`, `diag.js`, `catalog.js`, `README.md`) in a **GitHub repo**.
2. Repo **Settings → Pages → Deploy from branch → main / root**. GitHub gives you an `https://…github.io/…` link.
3. On the phone, open that link **in Bluefy** (iPhone) or **Chrome** (Android).

**B. Local file (iPhone, no hosting):** AirDrop/email `index.html` + the 4 other files to the phone into one folder, then
open `index.html` in **Bluefy** (Bluefy → menu → open file). Web Bluetooth works from a local file too.

> It must be **https** or a local file — plain `http://` (except `localhost`) won't allow Bluetooth. GitHub Pages is https.

## Using it

1. Ignition **on**, adapter plugged in. Open the page, tap **Connect adapter**, pick your adapter from the list.
2. Tap **Gearbox live** or **Engine live**. The dashboard starts updating ~4×/second.
3. **Build your own dashboard:** tap **Edit**. On each reading, pick how it's shown — `123` number, `◔` dial, `▭` bar —
   reorder with `↑ ↓`, remove with `×`, and **add more readings** from the list at the bottom. Your layout is saved on the
   phone. "Reset to default layout" restores it.
4. **Record** logs the live data; tap again to download a CSV. **Stop** pauses; tap to resume.
5. Readings that look wrong are flagged in amber/red with a short reason (overheating, weak charging, hot gearbox oil…).
6. **Tools** (top-right on either dashboard) — everything the Windows tool does:
   - **Read fault codes** with the conditions stored with each fault, and clear them.
   - **Actuator tests** — drive a part to check it (gearbox solenoids; engine injectors, coils, fuel pump, fans, throttle…). Safety checks run first (engine off, stationary, lever in P); watch/listen for it working.
   - **Live manufacturer data** — everything the dealer tool shows, decoded.
   - **Record & analyse a drive** — log a drive, then see every gear change, the flare (clutch slip), timing and pressures. **Open CSV file(s)** to analyse one, compare two, or trend several — including recordings made by the Windows tool.
   - **Guided switch test** — walks you through brake, lever, pedal and buttons and reports which switches worked.
   - **Accelerator pedal learning**, **Configuration** (snow mode from ESP, ESP gear holding, wiring checks), **Reset learned values** (engine or gearbox) and the **oil wear counter**.
   - **Engine, standard OBD:** emissions **readiness (MOT)**, **freeze frame**, **VIN / calibration ID**, **battery & charging test**.
   - **Switch to Peugeot mode** (engine) first to identify the computer and unlock its manufacturer data, tests, reset and **fault-clearing history**.

To try the tools without a car, tick **Demo: engine off** on the connect screen (tests need the engine off).

Try it first with **Demo mode** (on the connect screen) — it runs a synthetic car so you can see everything without the
adapter.

## What it reads

- **Gearbox (AL4, 0xA4):** gear + lock-up, lever, input/output speed, oil temperature, oil & guide pressure, EVM & EVLU
  duty, pedal, torque, converter lock-up, programme, and the switches (brakes, kickdown, Sport/Snow, P/N). Oil-change flag.
- **Engine (standard OBD):** rpm, vehicle speed, coolant & intake temp, manifold pressure, load, throttle, timing, fuel
  trims, oxygen sensors, ECU voltage.
- **Engine (Peugeot mode, via Tools):** identifies the computer (Sagem J34P, Bosch ME7.4.x, Marelli MM6LP…) and shows its
  manufacturer data, faults with stored conditions, actuator tests and the learned-values reset.

## Notes & limits

- **BLE only** (Web Bluetooth can't use Wi-Fi or old Bluetooth-3.0 adapters). Yours is BLE, so fine.
- Engine readings here are **standard OBD**. The Windows psadiag also does the engine's Peugeot mode and the actuator
  tests, resets, oil-counter and coding writes — those involve changing the car, so they stay in the full tool for now.
- **Don't operate the phone while driving** — a passenger holds it, or use Record and review the CSV afterwards.
- If the adapter doesn't appear when you tap Connect: make sure you're in **Bluefy** (not Safari), the ignition is on, and
  the adapter isn't already connected to another app (Car Scanner) — close that first.

## Files (all of them must be in the same folder)
`index.html` · `app.css` · `app.js` (UI, dashboards, builder) · `diag.js` (ELM327/OBD/KWP) · `catalog.js` (dashboard
parameters + guidance) · `pack.js` (Diagbox definitions) · `dbx.js` (Diagbox decoder) · `analysis.js` (drive analysis) ·
`tools.js` (faults, tests, service, Peugeot, drives) · `README.md`. No build step, no dependencies.

This web app now does everything the Windows psadiag does, except it talks only to a BLE adapter (so no old Bluetooth-3.0
dongles) and it can't reach computers that aren't on the OBD socket (BSI, ABS, airbag, etc. — same limit as the Windows tool).
