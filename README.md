# ALIGN — website

A static website for the ALIGN posture device. The ESP32 measures the wearer's
tilt, the site calibrates against their upright posture, and tracks how far
they drift from it over time.

No build step — plain HTML, CSS and ES modules, plus one vendored script
(`web/vendor/mqtt.min.js`) for the board connection.

## How the board reaches the site

Once the site is published, the board and the browser can no longer talk
directly. An `https://` page may not fetch `http://192.168.4.1` — browsers
block mixed content — and a laptop joined to the board's own hotspot has no
route to load the page at all. So the board stops waiting to be asked and
publishes instead:

```
ESP32-C3  --mqtt/1883-->  broker.emqx.io  <--wss/8084--  the website
```

Both ends meet at a public MQTT broker. The board's leg is plain TCP; the
browser's is a secure WebSocket, which an https page is allowed to open. The
two ends never need to be on the same network, in the same building, or in the
same country.

Pairing is one six-character code — the last three bytes of the board's MAC,
printed over serial and on the board's own setup page. Each board gets its own
topics under `align/<CODE>/`, so two ALIGN boards never land in each other's
gauge. The code is not a secret; the payload is two angles.

| Topic | Direction | Payload |
| --- | --- | --- |
| `align/<CODE>/reading` | board → site | JSON: `pitch`, `roll`, `battery`, `deviation`, `calibrated`, 10 Hz |
| `align/<CODE>/status` | board → site | `online` / `offline`, retained, `offline` set as the board's will |
| `align/<CODE>/cmd` | site → board | JSON: `{"hello":true}`, `{"calibrate":true}`, `{"buzzTest":true}`, `{"buzz":2,"threshold":20.5}` |

### What the motor tells you

In MQTT a subscriber is invisible to a publisher, so the board has no way of
knowing anyone is watching — the broker sits in between. The site therefore
says `{"hello":true}` as soon as it has subscribed, and the board answers on
the wearer's back:

| Pattern | Meaning |
| --- | --- |
| One tap (200 ms) | The board reached the broker. Wi-Fi setup worked — the only feedback there is with no screen nearby. |
| Two taps | The website is attached and showing *this* board. |
| One long buzz | Bad posture, after the grace period. Length is the buzz setting. |

Nothing interrupts a pattern mid-play: a posture buzz landing on top of the
connection tap would read as one long meaningless rumble.

Bluetooth and same-network polling are both still in the site, offered under
the board code on the home screen. They only work when you run the site
locally — which is exactly when they're useful.

## Running it

Web Bluetooth only works in a *secure context*, which means `https://` or
`localhost` — opening `index.html` straight from the file system won't do (ES
modules are blocked there too). Serve the folder:

```sh
cd web
python3 -m http.server 8000
# then open http://localhost:8000
```

Any static server works (`npx serve`, `php -S localhost:8000`, nginx…).

### Deploying

Upload the contents of `web/` to any static host — GitHub Pages, Netlify,
Cloudflare Pages, S3. The only requirement is HTTPS, which all of them give you
by default, and which the board connection needs in order to open its
WebSocket.

`./deploy.sh` does it for GitHub Pages: it pushes this repository and turns
Pages on, serving from `web/` on the `gh-pages` branch. Run `gh auth login`
once first.

## Browser support

| Browser | Bluetooth | Everything else |
| --- | --- | --- |
| Chrome / Edge — desktop, Android | ✅ | ✅ |
| Brave | after enabling Web Bluetooth in `brave://settings/privacy` | ✅ |
| Safari (macOS + iOS), Firefox | ❌ no Web Bluetooth | ✅ |
| iOS, any browser | ❌ (use the [Bluefy](https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055) browser if you need it) | ✅ |

**No device nearby?** Press **Demo mode** on the connection banner (or Settings
→ Device → Start demo mode). Readings are generated that drift in and out of
good posture, so every screen works end to end. For charts with a history
behind them: Settings → Data → **Load demo data** (35 days of plausible
samples, including two skipped days so the streak logic is visible).

Unlike a native app, a browser can only start a Bluetooth scan from a click —
so connecting is always a deliberate press of **Connect**, never automatic.
Chrome will silently reconnect to a device you have already paired when it's in
range.

## Features

| Feature | Where |
| --- | --- |
| Calibration — records the upright baseline | `web/js/ui/calibration.js` |
| Current angle + good/bad verdict | `web/js/ui/home.js` (`createAngleCard`) |
| Progress over 1 week / 2 weeks / 1 month | `web/js/ui/home.js` (`createProgressCard`) |
| Left vs right lean preference | `web/js/ui/home.js` (`createLeanCard`) |
| Wear streak (Mon–Sun + running count) | `web/js/ui/home.js` (`createStreakCard`) |
| Buzz adjustment (OFF / 1s / 2s / 5s) and battery | `web/js/ui/settings.js` |
| Sign in / log out, one profile per wearer | `web/js/ui/signin.js`, `web/js/stores/profile.js` |
| Google Sheets sync | `web/js/sync.js`, `web/google-apps-script/Code.gs` |
| Gauge, lean arc, chart, pill selector | `web/js/ui/components.js` (hand-drawn SVG) |

How the numbers are derived, all in `web/js/stores/postureStore.js`:

- **Angle** is the total tilt away from the calibrated upright posture:
  `sqrt(pitchDelta² + rollDelta²)`, in degrees.
- **Zones** follow the design's chart bands — 0–10° good, 11–20° fair,
  21–30° poor, 30°+ bad (`zoneFor` in `models.js`).
- **Lean** uses signed roll. More than 4° off center counts as a lean to that
  side; the card reports the share of off-center samples on each side.
- **Streak** counts consecutive days with at least 10 minutes of wear. A day
  still in progress doesn't break a streak that ran through yesterday.
- History is sampled every 10 seconds and kept for 60 days.

### Where the data lives

Everything stays in the browser — nothing is uploaded.

- **History** → IndexedDB (`align` / `kv` / `history`), stored as packed typed
  arrays so 60 days of wear stays small. Falls back to `localStorage` where
  IndexedDB is blocked, e.g. some private windows.
- **Calibration and preferences** → `localStorage`.

Clearing site data erases both. Settings → Data → *Erase history and
calibration* does the same from inside the site.

## Profiles

The site asks who is wearing the band before it records anything. Each profile
gets its own calibration, history, streak and buzz setting — stored under keys
scoped to that profile, so two people sharing a laptop never see each other's
numbers.

- **Log out** — Settings → Profile → *Log out*. This keeps the profile and its
  history on the device; signing back in under the same name picks it up where
  it left off. It syncs to the sheet on the way out.
- **New wearer** — log out, then type a new name on the sign-in screen. Fresh
  calibration, fresh streak.
- **Existing wearers** are listed under *or continue as* on the sign-in screen,
  with when they last wore the band.

History written before profiles existed is adopted by the first profile
created, so nothing is lost by upgrading.

## Recording to Google Sheets

Daily rollups go to
[this spreadsheet](https://docs.google.com/spreadsheets/d/1c_eGhhe6cjcHa3_eNffbmaz8KT7xVE_XTLFEbAm0bzs/edit)
— one row per person per day, plus a `Profiles` tab summarising each wearer.

A browser can't write to Sheets directly, so the site posts to a Google Apps
Script bound to the spreadsheet. There is nothing to configure in the app —
one line of `web/js/config.js` points it at the script, and every wearer syncs
from then on. **Until that line is filled in, nothing is uploaded.**

1. Open the spreadsheet → **Extensions → Apps Script**.
2. Paste in `web/google-apps-script/Code.gs` (the spreadsheet id is already
   filled in) and save.
3. **Deploy → New deployment → Web app**, *Execute as* **Me**, *Who has access*
   **Anyone**. Approve the permission prompt and copy the `/exec` URL.
4. Put that URL in `web/js/config.js` as `SHEET_WEB_APP_URL`, and redeploy the
   site.

The URL you need looks like `https://script.google.com/macros/s/AKfycb…/exec`.
The spreadsheet's own `docs.google.com/spreadsheets/…` address will not work —
a spreadsheet can't receive posts, only the script can. Settings → Data shows
whether syncing is working; the browser console explains it if the URL is the
wrong kind.

Anyone holding the `/exec` URL can post rows to the sheet (they can't read it).
If that matters, set `SHARED_SECRET` in `Code.gs`.

**What gets uploaded:** for each of the last 14 days — date, profile name and
email, profile id, sample count, minutes worn, average angle, good-posture
share, left/right split, current streak, and whether the readings came from a
device or demo mode. Individual 10-second readings never leave the browser.

**When:** on page load if anything is outstanding, every 5 minutes while new
readings are arriving, on log out, and once more as the page closes. Rows are
keyed on profile + date, so a re-sent day corrects the existing row instead of
duplicating it — a missed sync is caught up by the next one rather than lost.

## Connecting your ESP32

1. **Flash the board.** Pick the sketch that matches your hardware, open it in
   the Arduino IDE, choose your ESP32 board, and upload. Both compile on
   Arduino-ESP32 2.x, 3.x and 4.0-alpha. The serial monitor (115200 baud)
   prints `Advertising as "ALIGN"` when it is up.

   | Sketch | Sensor | Pins |
   | --- | --- | --- |
   | `firmware/G7Prototype2/G7Prototype2.ino` | LSM6DS3 @ 0x6B | SDA 6, SCL 7, motor 4 |
   | `firmware/align_esp32.ino` | MPU-6050 | SDA 21, SCL 22, motor 25, battery 34 |

   `G7Prototype2` is the G7 prototype sketch with Bluetooth added — it needs the
   **SparkFun Qwiic 6DoF - LSM6DS3** library from *Sketch → Include Library →
   Manage Libraries*.
2. **Open the site** in Chrome or Edge over `https://` or `localhost`.
3. **Press Connect** and choose ALIGN in the browser's device chooser.

**No sensor wired yet?** Flash `align_esp32.ino` anyway. If no MPU-6050 answers
on I²C, the board streams a slow sweep instead of real tilt, says so over
serial, and everything else works — so you can prove the Bluetooth link on a
bare dev board and add the sensor after.

**Getting left and right backwards?** Which way the sensor sits decides the sign
of the roll. In `readTilt()` (G7) or `mpuUpdate()` (ALIGN), negate `rollDeg` to
swap left and right, or `pitchDeg` if leaning forward reads as leaning back.

### What the site will talk to

Boards are matched in this order, so the ALIGN firmware always wins if it's
there. The characteristic UUIDs are a hint: if a board exposes one of these
services but different characteristics, whatever notifies inside that service
is used instead.

| Firmware | Service | Data it expects |
| --- | --- | --- |
| ALIGN (`firmware/align_esp32.ino`) | `a11c0001-…0001` | 8-byte packet |
| Nordic UART (NUS) | `6e400001-…` | lines of text |
| The stock Arduino `BLE_notify` / `BLE_server` example | `4fafc201-…` | lines of text |
| HM-10 style BLE serial | `ffe0` | lines of text |

Text can be as loose as `12.3,-4.5` or `pitch: 12.3 roll: -4.5 batt: 80` — the
first two numbers are pitch and roll, a third is battery percent. Lines split
across notifications are stitched back together. Settings that go *to* a
serial-style board are sent as `buzz:2`, `calibrate` and `buzz-test`.

If your board advertises none of those services, press **Show all devices** —
the button appears after a scan finds nothing — and pick it by name. The site
still needs a service it knows to read from; add yours to `DEVICE_PROFILES` in
`web/js/protocol.js` if it uses custom UUIDs.

### If it doesn't show up

- **Nothing in the chooser** — the board must advertise the *service UUID*, not
  just its name. `advertising->addServiceUUID(...)` in the sketch does this.
  Also check nothing else is already connected to it; BLE allows one central at
  a time, so close the phone app or serial BLE tool holding it.
- **"Web Bluetooth needs a secure page"** — you're on `http://` with a hostname
  other than `localhost`. Use https, or `localhost`.
- **Connects, then "none of its services stream posture data"** — the board is
  reachable but nothing notifies. Check the characteristic has
  `PROPERTY_NOTIFY` and a `BLE2902` descriptor.
- **Connects but the angle never moves** — Settings → Device shows the last
  reading's timestamp and which firmware shape matched. If readings are landing
  but the gauge sits at zero, you haven't calibrated yet.
- **Brave** needs Web Bluetooth switched on in `brave://settings/privacy`.

## The BLE contract

Defined once, in `web/js/protocol.js`. If your firmware already uses different
UUIDs, change them there — nothing else hard-codes them. Web Bluetooth requires
the UUIDs in lowercase.

| Characteristic | Properties | Payload |
| --- | --- | --- |
| Posture `a11c0002-…0002` | Notify | 8 bytes: `int16` pitch ×100, `int16` roll ×100, `uint8` battery %, `uint8` flags, `uint16` sequence (little-endian) |
| Buzz `a11c0003-…0003` | Write | 1 byte: buzz duration in seconds — 0, 1, 2 or 5 |
| Command `a11c0004-…0004` | Write | 1 byte: `0x01` calibrate, `0x02` test buzz |

Service `a11c0001-…0001`, advertised as `ALIGN`. The standard Battery Service
(`180f` / `2a19`) is also read if the device exposes it.

`firmware/align_esp32.ino` is the matching Arduino sketch: MPU-6050 over I²C, a
complementary filter for pitch/roll, 10 Hz notifications, battery from an ADC
divider, and a vibration motor that fires after posture has been bad for 4
seconds (with a 15 second cooldown). Wiring is documented at the top of the file.

## Things you'll want to change

- **Google form link** — `DEFAULT_FEEDBACK_URL` in
  `web/js/stores/settingsStore.js`, currently
  <https://forms.gle/Qm7nZAyVtLU3f4Kc7>.
- **Sheet endpoint** — `SHEET_WEB_APP_URL` in `web/js/config.js`, plus
  `SYNC_INTERVAL_MINUTES` and `SYNC_WINDOW_DAYS`.
- **Colors and spacing** — `web/css/styles.css` (`:root`) and
  `web/js/theme.js`, which mirror each other because SVG attributes can't read
  CSS custom properties.
- **App icon** — `web/icon.svg`, used by the manifest and the tab favicon.
- **Bad-posture threshold on the device** — `BAD_ANGLE_DEG` in the sketch (15°).
  The site's own zone boundaries are in `zoneFor()` in `web/js/models.js`.

## Firmware

| File | What it drives |
| --- | --- |
| `firmware/ALIGN_Cloud/ALIGN_Cloud.ino` | **The one to flash.** Joins your Wi-Fi and publishes to the broker, so it reaches the published site from anywhere |
| `firmware/ALIGN_WiFi/ALIGN_WiFi.ino` | Local-only: runs a web server the site polls across the same network |
| `firmware/ALIGN_BLE/ALIGN_BLE.ino` | Web Bluetooth. On this ESP32-C3 the stack never reports a client as connected, so notifications are discarded |
| `firmware/G7Prototype2/G7Prototype2.ino` | The G7 prototype board — LSM6DS3, motor on GPIO 4, I²C on 6/7 |
| `firmware/align_esp32.ino` | MPU-6050 reference build, with a battery divider and a no-sensor fallback |

### Flashing ALIGN_Cloud

Needs the **SparkFun Qwiic 6DoF - LSM6DS3** and **PubSubClient** libraries.
Board `ESP32C3 Dev Module`, **USB CDC On Boot: Enabled** — without it `Serial`
blocks forever waiting for a monitor and the board never gets as far as raising
its setup hotspot.

```sh
arduino-cli compile --fqbn esp32:esp32:esp32c3:CDCOnBoot=cdc firmware/ALIGN_Cloud
arduino-cli upload -p /dev/cu.usbmodem14201 --fqbn esp32:esp32:esp32c3:CDCOnBoot=cdc firmware/ALIGN_Cloud
```

On first boot it raises an open hotspot called **ALIGN-setup**. Join it; the
setup page opens by itself (or visit `http://192.168.4.1`). Pick your 2.4 GHz
network — the C3 has no 5 GHz radio — type the password, and it saves it to
flash and rejoins on every boot after that. The page also shows the board code.
`http://align.local/forget` wipes the saved network and brings the hotspot
back.

The sketch finds the LSM6DS3 by probing pin pairs rather than trusting a
constant, and prints which pair answered. The earlier sketches hard-coded SDA 6
/ SCL 7 and, when that was wrong, quietly fell back to a generated sine wave —
the gauge moved convincingly while the sensor was never read at all. If no pair
answers it still says so on every status line rather than pretending.

## The original iOS app

The SwiftUI version this site was ported from is still here: `ALIGN/` and
`ALIGN.xcodeproj`. It is no longer needed for the website and can be deleted if
you're going web-only. Everything it did, the site does — with the caveat that
browsers can't run Bluetooth in the background.

## Layout

```
web/
  index.html            markup shell
  manifest.webmanifest  installable-to-homescreen metadata
  icon.svg
  css/styles.css        design tokens + every screen's styling
  google-apps-script/
    Code.gs             paste into the spreadsheet to receive syncs
  js/
    app.js              profile gate, wires the stores together, mounts the app
    config.js           sheet endpoint and sync cadence
    theme.js            colors for SVG
    models.js           zones, lean, ranges, buzz, date helpers
    protocol.js         BLE UUIDs + packet decoding
    device.js           Web Bluetooth manager, plus demo mode
    sync.js             daily rollups -> Google Sheets
    stores/
      profile.js        who is wearing the band; scopes every storage key
      postureStore.js   calibration, history, every derived statistic
      settingsStore.js  buzz interval, feedback link
      storage.js        IndexedDB/localStorage persistence
    ui/
      components.js     DOM helpers, gauge, lean arc, chart, pill
      signin.js         name entry and returning-wearer list
      home.js           banners, streak, angle, progress, lean
      calibration.js    3-2-1 countdown and baseline capture
      settings.js       profile, battery, buzz, device, sheet, data
      sheet.js          modal sheet used by the screens above
```
