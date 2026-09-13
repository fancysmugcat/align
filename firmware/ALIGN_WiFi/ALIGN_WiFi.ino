/*
 * ALIGN — ESP32 posture sensor over Wi-Fi
 *
 * The board runs a small web server; the ALIGN website reads from it over
 * HTTP. Structure follows the Random Nerd Tutorials ESP32 web server pattern
 * (https://randomnerdtutorials.com/esp32-web-server-arduino-ide/), using the
 * bundled WebServer library for routing rather than parsing requests by hand.
 *
 * Why not Bluetooth: on this ESP32-C3 the BLE stack never reports a client as
 * connected, so the library silently discards every notification. Over Wi-Fi
 * the browser does the asking, which also means the site works in Safari and
 * Firefox — neither of which supports Web Bluetooth at all.
 *
 * Board:   ESP32-C3 development board (ESP32C3 Dev Module in Arduino IDE)
 * Sensor:  LSM6DS3 at 0x6B — SparkFun LSM6DS3 library
 * Motor:   GPIO 4
 * I²C:     SDA GPIO 6, SCL GPIO 7  (change SDA_PIN / SCL_PIN if you wired 8/9)
 *
 * Arduino IDE → Tools:
 *   Board:            ESP32C3 Dev Module
 *   USB CDC On Boot:  Enabled   (needed so USB serial and the sketch both run)
 *   Upload Speed:     921600
 *
 * ── Wi-Fi ────────────────────────────────────────────────────────────────
 * Fill in your network below and the board joins it. Leave WIFI_SSID empty
 * (or if joining fails) and it creates its own 2.4 GHz network instead:
 *
 *     network:  ALIGN            password: alignposture
 *     address:  http://192.168.4.1
 *
 * The C3 only makes a 2.4 GHz hotspot (phones set to 5 GHz-only will miss it).
 * Serial prints the address to use; http://align.local works where mDNS does.
 *
 * ── What the website calls ───────────────────────────────────────────────
 *   GET /reading      → {"pitch":1.2,"roll":-3.4,"battery":null,...}
 *   GET /calibrate    → records the current posture as upright
 *   GET /buzz?seconds=2 → 0 (off), 1, 2 or 5
 *   GET /buzz-test    → one short buzz
 *   GET /             → a plain status page you can open yourself
 */

#include <Wire.h>
#include <SparkFunLSM6DS3.h>
#include <math.h>

#include <WiFi.h>
#include <WebServer.h>
#include <ESPmDNS.h>

// ---------------------------------------------------------------- wifi

// Left empty on purpose: this router deauths the board before authentication
// (reason 2, every attempt, on both its 2.4GHz radios), so joining it always
// fails and costs 15 seconds first. Put the network name back here if the
// router is ever changed — the join path below still works.
//   const char *WIFI_SSID = "Wagan Wifi 6";  password "Prince@0909"
const char *WIFI_SSID     = "";          // "" = make our own network
const char *WIFI_PASSWORD = "";

const char *AP_SSID     = "ALIGN";
const char *AP_PASSWORD = "alignposture";   // at least 8 characters
const char *MDNS_NAME   = "align";          // -> http://align.local

const unsigned long WIFI_TIMEOUT_MS = 15000;

// ---------------------------------------------------------------- pins

const int MOTOR_PIN = 4;
const int SDA_PIN   = 6;
const int SCL_PIN   = 7;

// An ADC pin on a battery divider, or -1 to report "unknown".
const int BATTERY_PIN = -1;

// ---------------------------------------------------------------- settings

const float TILT_THRESHOLD = 15.0;          // degrees off upright = bad posture
const unsigned long SAMPLE_INTERVAL = 100;  // ms between sensor reads (10 Hz)

// Buzz once posture has been bad this long, then hold off this long.
const unsigned long BAD_POSTURE_GRACE_MS = 3000;
const unsigned long BUZZ_COOLDOWN_MS     = 10000;
// Hard ceiling on one buzz, whatever the website asks for.
const unsigned long MAX_BUZZ_MS          = 5000;

// 0 = raw, 0.9 = heavily smoothed.
const float SMOOTHING = 0.75;

// ---------------------------------------------------------------- state

LSM6DS3 imu(I2C_MODE, 0x6B);
WebServer server(80);

bool imuPresent = false;
bool apMode = false;

float pitch = 0, roll = 0;              // degrees, smoothed
float basePitch = 0, baseRoll = 0;      // upright reference
uint8_t buzzSeconds = 2;

// Nothing vibrates until the website says what upright means. Without this a
// board lying on a desk reads ~100 degrees off a baseline of zero and buzzes
// forever.
bool calibrated = false;

unsigned long previousMillis = 0;
unsigned long lastPrintMs = 0;
unsigned long badSinceMs = 0;
unsigned long lastBuzzMs = 0;
unsigned long buzzUntilMs = 0;
unsigned long requestCount = 0;

// ---------------------------------------------------------------- sensor

// Pitch and roll in degrees, from the accelerometer alone.
//
// The original sketch reduced tilt to a single number —
// atan2(sqrt(ax²+ay²), az) — which says how far off vertical you are but not
// which way. The website needs both: pitch drives the angle gauge, and the
// sign of roll is what the "Left or Right?" card reads.
//
// If left and right come out swapped, negate rollDeg. If leaning forward reads
// as leaning back, negate pitchDeg.
void readTilt() {
  if (!imuPresent) {
    static float t = 0;
    t += SAMPLE_INTERVAL / 1000.0;
    pitch = 12.0 + sin(t / 14.0) * 13.0 + sin(t / 2.3) * 2.5;
    roll = sin(t / 21.0) * 9.0 + cos(t / 3.1) * 1.5;
    return;
  }

  float ax = imu.readFloatAccelX();
  float ay = imu.readFloatAccelY();
  float az = imu.readFloatAccelZ();

  float pitchDeg = atan2(-ax, sqrt(ay * ay + az * az)) * 180.0 / PI;
  float rollDeg  = atan2(ay, az) * 180.0 / PI;

  pitch = SMOOTHING * pitch + (1 - SMOOTHING) * pitchDeg;
  roll  = SMOOTHING * roll  + (1 - SMOOTHING) * rollDeg;
}

float deviation() {
  float dp = pitch - basePitch;
  float dr = roll - baseRoll;
  return sqrt(dp * dp + dr * dr);
}

int batteryPercent() {
  if (BATTERY_PIN < 0) return -1;       // unknown

  int raw = analogRead(BATTERY_PIN);
  float volts = (raw / 4095.0) * 3.3 * 2.0;
  int pct = (int)((volts - 3.0) / (4.2 - 3.0) * 100.0);
  if (pct < 0) pct = 0;
  if (pct > 100) pct = 100;
  return pct;
}

// ---------------------------------------------------------------- buzzing

// Non-blocking. The prototype's delay(VIBRATION_TIME) froze everything for the
// whole buzz, which would stall the web server too.
void updateBuzz(unsigned long now) {
  if (buzzUntilMs != 0 && now >= buzzUntilMs) {
    digitalWrite(MOTOR_PIN, LOW);
    buzzUntilMs = 0;
  }
  if (buzzSeconds == 0) return;
  if (!calibrated) return;

  if (deviation() < TILT_THRESHOLD) {
    badSinceMs = 0;
    return;
  }
  if (badSinceMs == 0) {
    badSinceMs = now;
    return;
  }
  if (now - badSinceMs < BAD_POSTURE_GRACE_MS) return;
  if (now - lastBuzzMs < BUZZ_COOLDOWN_MS) return;

  Serial.println("Bad posture — buzzing.");
  lastBuzzMs = now;
  unsigned long duration = (unsigned long)buzzSeconds * 1000UL;
  if (duration > MAX_BUZZ_MS) duration = MAX_BUZZ_MS;
  buzzUntilMs = now + duration;
  digitalWrite(MOTOR_PIN, HIGH);
}

// ---------------------------------------------------------------- http

// The website is served from a different origin (localhost), so every reply
// needs this or the browser discards it.
void sendJSON(const String &body) {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Cache-Control", "no-store");
  server.send(200, "application/json", body);
}

String readingJSON() {
  String json = "{";
  json += "\"pitch\":" + String(pitch, 2);
  json += ",\"roll\":" + String(roll, 2);
  json += ",\"battery\":" + (batteryPercent() < 0 ? String("null") : String(batteryPercent()));
  json += ",\"deviation\":" + String(deviation(), 2);
  json += ",\"calibrated\":" + String(calibrated ? "true" : "false");
  json += ",\"buzzSeconds\":" + String(buzzSeconds);
  json += ",\"buzzing\":" + String(millis() < buzzUntilMs ? "true" : "false");
  json += ",\"sensor\":\"" + String(imuPresent ? "lsm6ds3" : "simulated") + "\"";
  json += ",\"uptime\":" + String(millis() / 1000);
  json += "}";
  return json;
}

void handleReading() {
  requestCount++;
  sendJSON(readingJSON());
}

void handleCalibrate() {
  basePitch = pitch;
  baseRoll = roll;
  calibrated = true;
  Serial.println("Calibrated: this is upright.");
  sendJSON(readingJSON());
}

void handleBuzz() {
  if (server.hasArg("seconds")) {
    int seconds = server.arg("seconds").toInt();
    if (seconds < 0) seconds = 0;
    if (seconds > 60) seconds = 60;
    buzzSeconds = (uint8_t)seconds;
    Serial.print("Buzz set to ");
    Serial.print(buzzSeconds);
    Serial.println("s");
  }
  sendJSON(readingJSON());
}

void handleBuzzTest() {
  buzzUntilMs = millis() + 400;
  digitalWrite(MOTOR_PIN, HIGH);
  sendJSON(readingJSON());
}

// A page you can open yourself to check the board without the website.
void handleRoot() {
  String html = "<!DOCTYPE html><html><head><meta charset='utf-8'>";
  html += "<meta name='viewport' content='width=device-width,initial-scale=1'>";
  html += "<title>ALIGN sensor</title><style>";
  html += "body{font-family:system-ui,sans-serif;margin:0;padding:24px;background:#fff;color:#1B6B37}";
  html += "h1{font-size:22px;letter-spacing:1.5px;margin:0 0 4px}";
  html += "p{color:#5E5E5E;margin:4px 0}";
  html += "b{font-size:34px;color:#1B6B37}";
  html += "a{display:inline-block;margin-top:16px;color:#1B6B37}";
  html += "</style></head><body>";
  html += "<h1>ALIGN</h1><p>Posture sensor</p>";
  html += "<p>Pitch <b>" + String(pitch, 1) + "&deg;</b> &nbsp; Roll <b>" + String(roll, 1) + "&deg;</b></p>";
  html += "<p>Off upright: " + String(deviation(), 1) + "&deg;";
  html += calibrated ? "" : " (not calibrated yet)";
  html += "</p><p>Sensor: " + String(imuPresent ? "LSM6DS3" : "simulated") + "</p>";
  html += "<p><a href='/reading'>/reading</a> &nbsp; <a href='/calibrate'>/calibrate</a> &nbsp; <a href='/buzz-test'>/buzz-test</a></p>";
  html += "<p style='margin-top:20px;font-size:13px'>Open the ALIGN website and press Connect.</p>";
  html += "</body></html>";

  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.send(200, "text/html", html);
}

// ---------------------------------------------------------------- wifi setup

// Why a join failed, in words. Without this the board just says "could not
// join" and every cause looks identical from the outside.
const char *disconnectReason(uint8_t reason) {
  switch (reason) {
    case WIFI_REASON_NO_AP_FOUND:            return "no access point with that name is in range";
    case WIFI_REASON_AUTH_FAIL:              return "the network refused the password";
    case WIFI_REASON_ASSOC_FAIL:             return "the access point refused to associate";
    case WIFI_REASON_HANDSHAKE_TIMEOUT:      return "wrong password (the handshake timed out)";
    case WIFI_REASON_AUTH_EXPIRE:            return "authentication expired";
    case WIFI_REASON_BEACON_TIMEOUT:         return "lost sight of the access point";
    case WIFI_REASON_CONNECTION_FAIL:        return "the connection attempt failed";
    default:                                 return "unknown";
  }
}

void onWiFiEvent(WiFiEvent_t event, WiFiEventInfo_t info) {
  if (event == ARDUINO_EVENT_WIFI_STA_DISCONNECTED) {
    uint8_t reason = info.wifi_sta_disconnected.reason;
    Serial.println();
    Serial.print("  [wifi] disconnected, reason ");
    Serial.print(reason);
    Serial.print(" - ");
    Serial.println(disconnectReason(reason));
  }
}

void startWiFi() {
  if (strlen(WIFI_SSID) > 0) {
    Serial.print("Joining \"");
    Serial.print(WIFI_SSID);
    Serial.print("\"");

    WiFi.onEvent(onWiFiEvent);
    WiFi.mode(WIFI_STA);
    // Some Wi-Fi 6 routers advertise WPA3; the C3 negotiates better with power
    // saving off and the minimum security floor dropped to WPA2.
    WiFi.setSleep(false);
    WiFi.setMinSecurity(WIFI_AUTH_WPA_PSK);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

    unsigned long started = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - started < WIFI_TIMEOUT_MS) {
      delay(400);
      Serial.print(".");
    }
    Serial.println();

    if (WiFi.status() == WL_CONNECTED) {
      Serial.print("Connected. Website address: http://");
      Serial.println(WiFi.localIP());
      return;
    }
    Serial.println("Could not join that network — falling back to my own.");
  }

  startAccessPoint();
}

// ESP32-C3 Dev Module: give the radio time after WIFI_AP, pin channel 1
// (2.4 GHz), and crank TX power so phones actually list the SSID.
void startAccessPoint() {
  apMode = true;

  // disconnect(true) means "turn the radio off" on this core — that is why
  // the C3 can run the sketch and still never show up in a Wi-Fi list.
  WiFi.persistent(false);
  WiFi.mode(WIFI_AP);
  delay(200);
  WiFi.setSleep(false);

  // ssid, password, channel, visible, 4 clients
  bool ok = WiFi.softAP(AP_SSID, AP_PASSWORD, 1, 0, 4);
  if (!ok) {
    Serial.println("Password hotspot failed — starting an open ALIGN network.");
    ok = WiFi.softAP(AP_SSID, NULL, 1, 0, 4);
  }

  IPAddress ip(192, 168, 4, 1);
  WiFi.softAPConfig(ip, ip, IPAddress(255, 255, 255, 0));
  delay(300);

  Serial.println();
  Serial.print("softAP returned ");
  Serial.print(ok ? "ok" : "FAIL");
  Serial.print("  ip ");
  Serial.println(WiFi.softAPIP());

  if (!ok || WiFi.softAPIP() == IPAddress(0, 0, 0, 0)) {
    Serial.println("Hotspot did not start. In Arduino: Board = ESP32C3 Dev Module, USB CDC On Boot = Enabled.");
    return;
  }

  Serial.print("Wi-Fi network: \"");
  Serial.print(AP_SSID);
  Serial.print("\"  password: ");
  Serial.println(AP_PASSWORD);
  Serial.println("On the Mac: Wi-Fi → Join Other Network… → ALIGN");
  Serial.println("Then open http://192.168.4.1");
}

// ---------------------------------------------------------------- sketch

void setup() {
  Serial.begin(115200);
  // USB-Serial/JTAG on the C3 will otherwise wait forever for a monitor and
  // never start the hotspot. Zero timeout means prints are skipped if nobody
  // is listening.
  Serial.setTxTimeoutMs(0);
  unsigned long serialWait = millis();
  while (!Serial && millis() - serialWait < 2000) delay(10);

  Serial.println();
  Serial.println("ALIGN Wi-Fi firmware starting.");

  Wire.begin(SDA_PIN, SCL_PIN);
  pinMode(MOTOR_PIN, OUTPUT);
  digitalWrite(MOTOR_PIN, LOW);

  imuPresent = (imu.begin() == 0);
  Serial.println(imuPresent
      ? "LSM6DS3 ready: streaming real tilt."
      : "LSM6DS3 not found on the I2C pins — streaming a demo sweep instead.");

  startWiFi();

  if (MDNS.begin(MDNS_NAME)) {
    MDNS.addService("http", "tcp", 80);
    Serial.print("Also reachable at http://");
    Serial.print(MDNS_NAME);
    Serial.println(".local");
  }

  server.on("/", handleRoot);
  server.on("/reading", handleReading);
  server.on("/calibrate", handleCalibrate);
  server.on("/buzz", handleBuzz);
  server.on("/buzz-test", handleBuzzTest);
  server.onNotFound([]() {
    server.sendHeader("Access-Control-Allow-Origin", "*");
    server.send(404, "application/json", "{\"error\":\"no such endpoint\"}");
  });
  server.begin();
  Serial.println("Web server running.");
}

void loop() {
  server.handleClient();

  unsigned long now = millis();
  if (now - previousMillis >= SAMPLE_INTERVAL) {
    previousMillis = now;
    readTilt();
    updateBuzz(now);
  }

  if (now - lastPrintMs >= 5000) {
    lastPrintMs = now;
    Serial.print("pitch ");
    Serial.print(pitch, 1);
    Serial.print("  roll ");
    Serial.print(roll, 1);
    Serial.print("  off upright ");
    Serial.print(deviation(), 1);
    Serial.print("  calibrated=");
    Serial.print(calibrated ? "yes" : "no");
    Serial.print("  requests=");
    Serial.print(requestCount);
    Serial.print("  wifi=");
    Serial.print(apMode ? AP_SSID : WIFI_SSID);
    Serial.print("  at http://");
    Serial.println(apMode ? WiFi.softAPIP() : WiFi.localIP());
  }
}
