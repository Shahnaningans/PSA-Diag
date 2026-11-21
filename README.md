# psadiag web: live diagnostics in the browser

A web version of psadiag for the **Peugeot 206 / 206 CC (AL4 automatic)** that talks to a **BLE ELM327** adapter straight
from the browser, with a **custom dashboard** you build yourself.

## What you need

- Your **BLE ELM327** adapter (the one that already works with Car Scanner on your iPhone).
- On **iPhone**: the free **Bluefy – Web BLE Browser** app (Safari and Chrome on iOS can't use Bluetooth).
- On **Android**: just **Chrome**.

## Run it 
**In web browser**
1. Open up **Bluefy** (iPhone) or **Chrome** (Android).
2. Enter https://shahnaningans.github.io/PSA-Diag/
3. Connect to your ELM device

## Using it

1. Ignition **on**, adapter plugged in. Open the page, tap **Connect adapter**, pick your adapter from the list.
2. Tap **Gearbox live** or **Engine live**. The dashboard starts updating ~4×/second.
3. **Build your own dashboard:** tap **Edit**. On each reading, pick how it's shown:  `123` number, `◔` dial, `▭` bar 
   reorder with `↑ ↓`, remove with `×`, and **add more readings** from the list at the bottom. Your layout is saved on the
   phone. "Reset to default layout" restores it.
4. **Record** logs the live data; tap again to download a CSV. **Stop** pauses; tap to resume.
5. Readings that look wrong are flagged in amber/red with a short reason (overheating, weak charging, hot gearbox oil…).
6. **Tools** (top-right on either dashboard) the manufacturer features:
   - **Read fault codes** with the conditions stored with each fault, and clear them.
   - **Actuator tests** drive a part to check it (gearbox solenoids; engine injectors, coils, fuel pump, fans, throttle…). Safety checks run first (engine off, stationary, lever in P); watch/listen for it working.
   - **Live manufacturer data**  everything the dealer tool shows, decoded.
   - **Reset learned values** (engine throttle/idle/mixture, or the gearbox autoadaptives) and the **oil wear counter** (read, and reset after an oil change).
   - On the engine, tap **Switch to Peugeot mode** first it identifies the engine computer and unlocks all of the above. (Faults via standard OBD are available without it.)

To try the tools without a car, tick **Demo: engine off** on the connect screen (tests need the engine off).

Try it first with **Demo mode** (on the connect screen) it runs a synthetic car so you can see everything without the
adapter.

## What it reads

- **Gearbox (AL4, 0xA4):** gear + lock-up, lever, input/output speed, oil temperature, oil & guide pressure, EVM & EVLU
  duty, pedal, torque, converter lock-up, programme, and the switches (brakes, kickdown, Sport/Snow, P/N). Oil-change flag.
- **Engine (standard OBD):** rpm, vehicle speed, coolant & intake temp, manifold pressure, load, throttle, timing, fuel
  trims, oxygen sensors, ECU voltage.
- **Engine (Peugeot mode, via Tools):** identifies the computer (Sagem J34P, Bosch ME7.4.x, Marelli MM6LP…) and shows its
  manufacturer data, faults with stored conditions, actuator tests and the learned-values reset.

## Notes & limits

- **BLE only** (Web Bluetooth can't use Wi-Fi or old Bluetooth-3.0 adapters). 
- Engine readings here are **standard OBD**.
- **Don't operate the phone while driving** use Record and review the CSV afterwards.
- If the adapter doesn't appear when you tap Connect: make sure you're in **Bluefy** (not Safari), and the ignition is on.
