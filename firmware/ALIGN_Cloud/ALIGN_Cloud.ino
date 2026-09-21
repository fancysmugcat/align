/*
 * ALIGN — ESP32-C3 posture sensor, published to the web
 *
 * The two earlier sketches both assumed the board and the browser were in the
 * same room. ALIGN_BLE needed them paired over Bluetooth; ALIGN_WiFi ran a web
 * server the browser polled across the local network. Neither survives the
 * website being published:
 *
 *   - A page served over https cannot fetch http://192.168.4.1. Browsers block
 *     mixed content, and there is no certificate a board on a private address
 *     could present.
 *   - While a laptop is joined to this board's own hotspot it has no route to
 *     the internet, so it cannot load the published page at all.
 *   - Web Bluetooth exists in Chromium only, needs the two within radio range,
 *     and on this C3 the BLE stack never reports a client as connected — every
 *     notification is silently discarded.
 *
 * So the board stops waiting to be asked. It joins a normal Wi-Fi network and
 * publishes its angles to a public MQTT broker; the website subscribes to the
 * same broker over a secure WebSocket, which an https page is allowed to open.
 * Wearer and website can be on opposite sides of the world.
 *
 *     ESP32-C3 --mqtt/1883--> broker.emqx.io <--wss/8084-- align website
 *
 * ── Pairing ──────────────────────────────────────────────────────────────
 * The broker is public and needs no account, so each board takes its own
 * corner of the topic tree named after the last three bytes of its MAC — six
 * hex characters, printed below on boot and on the setup page. Type that into
 * the website once. It is not a secret; it just keeps two ALIGN boards out of
 * each other's gauge.
 *
 * ── First run ────────────────────────────────────────────────────────────
 * With no network saved, the board raises an open hotspot called
 * "ALIGN-setup". Join it from a phone or laptop; the captive-portal page opens
 * by itself (or visit http://192.168.4.1). Pick your Wi-Fi, type the password,
 * and it saves it to flash and reconnects on every boot after that. The C3 has
 * a 2.4 GHz radio only, so pick a 2.4 GHz network.
 *
 * Board:   ESP32-C3 development board (ESP32C3 Dev Module in Arduino IDE)
 * Sensor:  MPU-6050 (0x68/0x69) or LSM6DS3 (0x6A/0x6B) — whichever answers.
 *          The pins are probed too, so nothing here has to be kept in sync
 *          with how the board is actually soldered.
 * Motor:   GPIO 4
 *
 * Libraries: SparkFun LSM6DS3 Breakout, PubSubClient
 *
 * Arduino IDE → Tools:
 *   Board:            ESP32C3 Dev Module
 *   USB CDC On Boot:  Enabled
 *   Upload Speed:     921600
 *
 * ── Topics ───────────────────────────────────────────────────────────────
 *   align/<CODE>/reading   board -> site, JSON, 10 Hz
 *   align/<CODE>/status    board -> site, "online" / "offline", retained
 *   align/<CODE>/cmd       site  -> board, JSON commands
 *
 * The local web server from ALIGN_WiFi is still here on port 80, so the board
 * can also be checked from a browser on the same network without the site.
 */

#include <Wire.h>
#include <SparkFunLSM6DS3.h>
#include <math.h>

#include <WiFi.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <ESPmDNS.h>
#include <Preferences.h>
#include <PubSubClient.h>
#include <esp_mac.h>

// ---------------------------------------------------------------- broker

// EMQX's public broker: free, no account, no password. Plain TCP from here
// (TLS on a C3 costs RAM and a cert store for data that is two angles); the
// browser's leg of the same hop is wss, which is what https requires.
const char *MQTT_HOST = "broker.emqx.io";
const uint16_t MQTT_PORT = 1883;

// ---------------------------------------------------------------- setup portal

const char *SETUP_AP_SSID = "ALIGN-setup";   // open, so joining is one tap
const char *MDNS_NAME     = "align";         // -> http://align.local

const unsigned long WIFI_TIMEOUT_MS = 20000;

// ---------------------------------------------------------------- pins

const int MOTOR_PIN = 4;

// Where the IMU is wired. The previous sketches hard-coded 6/7 and, when
// that was wrong, quietly fell back to a generated sine wave — the gauge moved
// convincingly while the sensor was never read at all. So the pins are probed
// instead: every plausible pair is tried until one answers at the IMU's
// address. The pair that worked is printed on boot and shown on the board's
// own page, so a real wiring change only has to be discovered once.
struct I2CPins { int sda; int scl; };
const I2CPins I2C_CANDIDATES[] = {
  {6, 7},     // what the ALIGN prototypes were wired to
  {8, 9},     // the Arduino core's default for the C3
  {5, 6},
  {7, 8},
  {9, 10},
  {2, 3},
  {20, 21},   // the classic ESP32 pair, on boards that expose them
};

// Two different sensors have been on this hardware. The LSM6DS3 the ALIGN
// prototypes were built around answers at 0x6A/0x6B (SDO low/high); the
// MPU-6050 actually soldered to this board answers at 0x68/0x69 (AD0 low/high)
// and is a completely different chip with different registers. Probing only
// for the LSM6DS3 is why the sensor read as absent while it was working fine.
enum ImuKind { IMU_NONE, IMU_LSM6DS3, IMU_MPU6050 };

struct ImuCandidate {
  uint8_t address;
  uint8_t whoAmIRegister;
  ImuKind kind;
};
const ImuCandidate IMU_CANDIDATES[] = {
  { 0x68, 0x75, IMU_MPU6050 },   // WHO_AM_I reads back 0x68 (clones vary)
  { 0x69, 0x75, IMU_MPU6050 },
  { 0x6B, 0x0F, IMU_LSM6DS3 },   // WHO_AM_I reads 0x69, or 0x6A on the TR-C
  { 0x6A, 0x0F, IMU_LSM6DS3 },
};

int sdaPin = 6, sclPin = 7;
uint8_t imuAddress = 0x68;
ImuKind imuKind = IMU_NONE;

// ---------------------------------------------------------------- battery
//
// The cell's positive terminal through a 2:1 divider — two equal resistors,
// 100k each is plenty — into an ADC pin, with the junction going to the pin.
// The divider is not optional: a full LiPo sits at 4.2V and the C3's ADC tops
// out around 2.5V, so wiring the cell straight to a pin reads nothing useful
// and stresses the input.
//
// ADC1 on the C3 is GPIO 0-4, and GPIO 4 is the motor, so 0-3 are the choices.
// Set to -1 if no divider is fitted and the site will show battery as unknown
// rather than a number made up out of noise.
// -1 means "look for it", which is what the probe below does. Set it to a
// specific GPIO to skip the search.
const int BATTERY_PIN = -1;
/** Searched in this order when BATTERY_PIN is -1. ADC1 on the C3 is GPIO 0-4. */
const int BATTERY_CANDIDATES[] = { 3, 2, 1, 0 };
int batteryPin = -1;
/** (R1 + R2) / R2. Two equal resistors give 2.0. */
const float BATTERY_DIVIDER = 2.0f;
/** A LiPo is flat well before 3.0V and full a shade under 4.2V. */
const float BATTERY_EMPTY_V = 3.30f;
const float BATTERY_FULL_V = 4.15f;

// ---------------------------------------------------------------- settings

float tiltThreshold = 20.5;                 // degrees off upright = bad posture
const unsigned long SAMPLE_INTERVAL  = 100; // ms between sensor reads (10 Hz)
const unsigned long PUBLISH_INTERVAL = 100; // ms between MQTT readings (10 Hz)

// Buzz once posture has been bad this long, then hold off this long.
const unsigned long BAD_POSTURE_GRACE_MS = 3000;
const unsigned long BUZZ_COOLDOWN_MS     = 10000;
const unsigned long MAX_BUZZ_MS          = 5000;

// At the 100ms sample rate this is the trade between drag and jitter: 0.75 took
// about a second to arrive and visibly trailed the wearer, 0.45 passed enough
// accelerometer noise through that the reading twitched while the band sat
// still. 0.62 settles in roughly half a second.
const float SMOOTHING = 0.62;               // 0 = raw, 0.9 = heavily smoothed

// ---------------------------------------------------------------- state

// Built only once the probe below has found the sensor, since the address is
// part of the constructor.
LSM6DS3 *imu = nullptr;
WebServer server(80);
DNSServer dns;
Preferences prefs;
WiFiClient net;
PubSubClient mqtt(net);

bool imuPresent = false;
bool setupMode  = false;      // running the provisioning hotspot

char boardCode[7] = "??????";
String topicReading, topicStatus, topicCommand;

float pitch = 0, roll = 0;                  // degrees, smoothed
float basePitch = 0, baseRoll = 0;          // upright reference
uint8_t buzzSeconds = 2;

// Nothing vibrates until the website says what upright means. Without this a
// board lying on a desk reads ~100 degrees off a baseline of zero and buzzes
// forever.
bool calibrated = false;

unsigned long previousMillis = 0;
unsigned long lastPublishMs  = 0;
unsigned long lastPrintMs    = 0;
unsigned long badSinceMs     = 0;
unsigned long lastBuzzMs     = 0;
unsigned long nextMqttTryMs  = 0;
unsigned long mqttBackoffMs  = 2000;
unsigned long publishCount   = 0;

// ---------------------------------------------------------------- identity

// Six hex characters from the tail of the MAC. Stable across reflashes, unique
// in practice, and short enough to read off a screen and retype.
//
// Read from efuse rather than through WiFi.macAddress(): that one goes via the
// Wi-Fi driver, which has not been started this early in setup(), and answers
// 00:00:00:00:00:00 — every board would have called itself 000000.
void makeBoardCode() {
  uint8_t mac[6] = {0};
  esp_read_mac(mac, ESP_MAC_WIFI_STA);
  snprintf(boardCode, sizeof(boardCode), "%02X%02X%02X", mac[3], mac[4], mac[5]);

  String base = String("align/") + boardCode;
  topicReading = base + "/reading";
  topicStatus  = base + "/status";
  topicCommand = base + "/cmd";
}

// ---------------------------------------------------------------- sensor

/**
 * Finds the IMU by trying each candidate pin pair in turn, for either sensor.
 *
 * An address that ACKs is not proof on its own — a floating pin pair can ACK
 * anything — so WHO_AM_I is read as well. Its value is logged but not required
 * to match: MPU-6050 clones report 0x70, 0x72, 0x75 and 0x98 as readily as the
 * genuine 0x68, and rejecting those would put us right back to calling a
 * working sensor absent.
 */
bool findIMU() {
  for (const I2CPins &pins : I2C_CANDIDATES) {
    if (pins.sda == MOTOR_PIN || pins.scl == MOTOR_PIN) continue;

    Wire.end();
    if (!Wire.begin(pins.sda, pins.scl)) continue;
    Wire.setClock(100000);
    delay(20);

    for (const ImuCandidate &candidate : IMU_CANDIDATES) {
      Wire.beginTransmission(candidate.address);
      if (Wire.endTransmission() != 0) continue;

      Wire.beginTransmission(candidate.address);
      Wire.write(candidate.whoAmIRegister);
      if (Wire.endTransmission(false) != 0) continue;
      if (Wire.requestFrom((int)candidate.address, 1) != 1) continue;

      uint8_t who = Wire.read();
      Serial.printf("  %s at 0x%02X on SDA %d / SCL %d, WHO_AM_I 0x%02X\n",
                    candidate.kind == IMU_MPU6050 ? "MPU-6050" : "LSM6DS3",
                    candidate.address, pins.sda, pins.scl, who);

      sdaPin = pins.sda;
      sclPin = pins.scl;
      imuAddress = candidate.address;
      imuKind = candidate.kind;
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------- MPU-6050

void mpuWrite(uint8_t reg, uint8_t value) {
  Wire.beginTransmission(imuAddress);
  Wire.write(reg);
  Wire.write(value);
  Wire.endTransmission();
}

bool mpuBegin() {
  mpuWrite(0x6B, 0x00);   // wake up — it boots into sleep
  mpuWrite(0x1C, 0x00);   // accel +/- 2g
  mpuWrite(0x1B, 0x00);   // gyro +/- 250 deg/s
  delay(20);
  return true;
}

// Accelerometer only, to match the LSM6DS3 path and the gauge's expectations.
// The gyro is read and discarded rather than fused: a complementary filter
// needs a reliable dt, and this loop's is whatever the web server and MQTT
// keepalive leave behind.
/** Last raw g-readings, printed so the axis mapping can be verified. */
float lastAxg = 0, lastAyg = 0;

/** @returns false if the bus didn't answer, leaving the angles untouched. */
bool mpuReadTilt(float &pitchDeg, float &rollDeg) {
  Wire.beginTransmission(imuAddress);
  Wire.write(0x3B);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((int)imuAddress, 6) < 6) return false;

  int16_t ax = Wire.read() << 8 | Wire.read();
  int16_t ay = Wire.read() << 8 | Wire.read();
  int16_t az = Wire.read() << 8 | Wire.read();

  float axg = ax / 16384.0f, ayg = ay / 16384.0f, azg = az / 16384.0f;

  // Which axis is "sideways" is decided by how the sensor sits in the band, not
  // by the chip. As this one is mounted, leaning left and right rotates the
  // board about its Y axis — that lands on ax — while slouching forward and
  // back rotates about X and lands on ay. The two were the other way round,
  // so the angle that drives everything was tracking slouch rather than lean.
  //
  // Only the axes are chosen here. Whether a positive reading means left or
  // right is Settings -> Device -> "Swap left and right", because it depends on
  // which way the sensor ended up facing and no value compiled in here can be
  // right for every build of the band.
  lastAxg = axg;
  lastAyg = ayg;
  rollDeg  = atan2f(axg, azg) * 180.0f / PI;
  pitchDeg = atan2f(-ayg, sqrtf(axg * axg + azg * azg)) * 180.0f / PI;
  return true;
}

// A failed read used to return silently, so the last angles stayed in place and
// were notified over and over. From the website that is indistinguishable from
// a wearer sitting perfectly still — the link looks healthy, the timestamps
// advance, and the numbers simply stop moving. Counted and recovered from now.
unsigned long imuReadErrors = 0;
uint16_t imuFailStreak = 0;

/** Re-opens the bus and re-wakes the sensor after a run of failed reads. */
void recoverI2C() {
  Wire.end();
  delay(5);
  Wire.begin(sdaPin, sclPin);
  Wire.setClock(100000);
  mpuBegin();
  Serial.printf("I2C stalled after %lu failed reads — bus re-initialised.\n", imuReadErrors);
}

// Pitch and roll in degrees, from the accelerometer alone.
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

  float pitchDeg = pitch, rollDeg = roll;

  if (imuKind == IMU_MPU6050) {
    if (!mpuReadTilt(pitchDeg, rollDeg)) {
      imuReadErrors++;
      if (++imuFailStreak >= 20) { imuFailStreak = 0; recoverI2C(); }
      return;                       // keep the last angles; don't invent one
    }
    imuFailStreak = 0;
  } else {
    float ax = imu->readFloatAccelX();
    float ay = imu->readFloatAccelY();
    float az = imu->readFloatAccelZ();
    pitchDeg = atan2(-ax, sqrt(ay * ay + az * az)) * 180.0 / PI;
    rollDeg  = atan2(ay, az) * 180.0 / PI;
  }

  pitch = SMOOTHING * pitch + (1 - SMOOTHING) * pitchDeg;
  roll  = SMOOTHING * roll  + (1 - SMOOTHING) * rollDeg;
}

// Sideways lean only, matching the website. Combining pitch and roll here made
// the board buzz for a forward slouch that the screen scored as fine, and the
// two disagreeing about what "bad posture" means is worse than either rule.
float deviation() {
  return fabs(roll - baseRoll);
}

/**
 * Averages a pin and reports how much the samples disagreed.
 *
 * analogReadMilliVolts applies the chip's own factory ADC calibration; raw
 * analogRead assumes a perfect 3.3V reference and a linear response, and on a
 * C3 is wrong by enough to move the percentage several points.
 */
float readPinVolts(int pin, float *spreadOut) {
  uint32_t total = 0;
  uint32_t lo = UINT32_MAX, hi = 0;
  for (int i = 0; i < 12; i++) {
    uint32_t mv = analogReadMilliVolts(pin);
    total += mv;
    if (mv < lo) lo = mv;
    if (mv > hi) hi = mv;
  }
  if (spreadOut) *spreadOut = (hi - lo) / 1000.0f * BATTERY_DIVIDER;
  return (total / 12.0f) / 1000.0f * BATTERY_DIVIDER;
}

/**
 * Finds the divider rather than trusting a constant, the same way the IMU pins
 * are found. A pin with a cell behind it sits at a steady, plausible voltage;
 * an unconnected one floats and wanders. Requiring both rules out reading a
 * floating input as a battery — which would put an invented percentage on the
 * wearer's screen, worse than showing nothing.
 */
void findBatteryPin() {
  if (BATTERY_PIN >= 0) { batteryPin = BATTERY_PIN; return; }

  for (int pin : BATTERY_CANDIDATES) {
    if (pin == MOTOR_PIN || pin == sdaPin || pin == sclPin) continue;
    float spread = 0;
    float volts = readPinVolts(pin, &spread);
    Serial.printf("  battery probe GPIO %d: %.2f V (spread %.2f V)\n", pin, volts, spread);
    if (volts >= 3.0f && volts <= 4.35f && spread < 0.12f) {
      batteryPin = pin;
      Serial.printf("Battery divider found on GPIO %d.\n", pin);
      return;
    }
  }
  Serial.println("No battery divider found — the site will show battery as unknown.");
  Serial.println("  Wire: cell + -> 100k -> an ADC pin (GPIO 0-3) -> 100k -> GND.");
}

float batteryVolts() {
  if (batteryPin < 0) return -1.0f;
  return readPinVolts(batteryPin, nullptr);
}

int batteryPercent() {
  float volts = batteryVolts();
  if (volts < 0) return -1;

  // An unconnected pin floats somewhere meaningless. Report "unknown" rather
  // than turning noise into a confident percentage on the wearer's screen.
  if (volts < 2.5f || volts > 5.0f) return -1;

  int pct = lroundf((volts - BATTERY_EMPTY_V) / (BATTERY_FULL_V - BATTERY_EMPTY_V) * 100.0f);
  if (pct < 0) pct = 0;
  if (pct > 100) pct = 100;
  return pct;
}

// ---------------------------------------------------------------- buzzing

/**
 * A small pattern player, so the motor can say more than one thing.
 *
 * Steps alternate on/off starting with on, in milliseconds — {120,100,120} is
 * a double tap. All of it is non-blocking: a delay() here would stall the MQTT
 * keepalive and the web server for the whole length of the buzz, and a dropped
 * keepalive is how the board falls off the broker mid-buzz.
 */
const uint8_t MAX_PATTERN_STEPS = 8;
uint16_t patternSteps[MAX_PATTERN_STEPS];
uint8_t patternLength = 0;
uint8_t patternAt = 0;
unsigned long patternStepEndsMs = 0;

// Two short taps: the website has attached and is watching this board.
const uint16_t PATTERN_SITE_CONNECTED[] = { 120, 110, 120 };
// One short tap: the board itself reached the broker. Confirms Wi-Fi setup
// worked, before any browser is involved.
const uint16_t PATTERN_BOARD_ONLINE[]   = { 200 };
// The "test buzz" from the calibration screen.
const uint16_t PATTERN_TEST[]           = { 400 };

bool patternRunning() { return patternLength > 0; }

void startPattern(const uint16_t *steps, uint8_t count) {
  if (count == 0 || count > MAX_PATTERN_STEPS) return;
  memcpy(patternSteps, steps, count * sizeof(uint16_t));
  patternLength = count;
  patternAt = 0;
  patternStepEndsMs = millis() + patternSteps[0];
  digitalWrite(MOTOR_PIN, HIGH);         // even steps are on
}

void updatePattern(unsigned long now) {
  if (patternLength == 0) return;
  if (now < patternStepEndsMs) return;

  patternAt++;
  if (patternAt >= patternLength) {
    patternLength = 0;
    digitalWrite(MOTOR_PIN, LOW);
    return;
  }
  digitalWrite(MOTOR_PIN, (patternAt % 2 == 0) ? HIGH : LOW);
  patternStepEndsMs = now + patternSteps[patternAt];
}

void updateBuzz(unsigned long now) {
  updatePattern(now);

  // Never cut a pattern short — a posture buzz landing on top of the
  // connection tap would read as one long meaningless rumble.
  if (patternRunning()) return;
  if (buzzSeconds == 0) return;
  if (!calibrated) return;

  if (deviation() < tiltThreshold) {
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
  uint16_t step = (uint16_t)duration;
  startPattern(&step, 1);
}

void calibrateHere() {
  basePitch = pitch;
  baseRoll = roll;
  calibrated = true;
  Serial.println("Calibrated: this is upright.");
}

// ---------------------------------------------------------------- payloads

String readingJSON() {
  String json = "{";
  json += "\"pitch\":" + String(pitch, 2);
  json += ",\"roll\":" + String(roll, 2);
  json += ",\"battery\":" + (batteryPercent() < 0 ? String("null") : String(batteryPercent()));
  json += ",\"deviation\":" + String(deviation(), 2);
  json += ",\"calibrated\":" + String(calibrated ? "true" : "false");
  json += ",\"buzzSeconds\":" + String(buzzSeconds);
  json += ",\"buzzing\":" + String(patternRunning() ? "true" : "false");
  json += ",\"sensor\":\"" + String(!imuPresent ? "simulated" : (imuKind == IMU_MPU6050 ? "mpu6050" : "lsm6ds3")) + "\"";
  json += ",\"code\":\"" + String(boardCode) + "\"";
  json += ",\"uptime\":" + String(millis() / 1000);
  json += "}";
  return json;
}

// ---------------------------------------------------------------- mqtt

// Commands are small and fixed in shape, so they are read by hand rather than
// pulling in a JSON parser for three fields. NAN means "the key wasn't there",
// which is distinct from a real zero — `{"buzz":0}` is how buzzing is turned
// off, so it has to survive the round trip.
float numberAfter(const String &body, const char *key) {
  int at = body.indexOf(key);
  if (at < 0) return NAN;
  at = body.indexOf(':', at);
  if (at < 0) return NAN;
  return body.substring(at + 1).toFloat();
}

void onCommand(char *topic, byte *payload, unsigned int length) {
  String body;
  body.reserve(length + 1);
  for (unsigned int i = 0; i < length; i++) body += (char)payload[i];
  Serial.print("Command: ");
  Serial.println(body);

  // The website says hello as soon as it has subscribed and seen a reading.
  // Two taps on the wearer's back is the confirmation that the page they are
  // looking at is showing *this* board — the only way to tell from the device
  // itself, since the broker sits in between and the board otherwise has no
  // idea anyone is watching.
  if (body.indexOf("\"hello\"") >= 0) {
    Serial.println("The website is watching this board — buzzing to confirm.");
    startPattern(PATTERN_SITE_CONNECTED,
                 sizeof(PATTERN_SITE_CONNECTED) / sizeof(PATTERN_SITE_CONNECTED[0]));
  }

  if (body.indexOf("\"calibrate\"") >= 0) calibrateHere();

  if (body.indexOf("\"buzzTest\"") >= 0) {
    startPattern(PATTERN_TEST, sizeof(PATTERN_TEST) / sizeof(PATTERN_TEST[0]));
  }

  float seconds = numberAfter(body, "\"buzz\"");
  if (!isnan(seconds)) {
    if (seconds < 0) seconds = 0;
    if (seconds > 60) seconds = 60;
    buzzSeconds = (uint8_t)lround(seconds);
    Serial.print("Buzz set to ");
    Serial.print(buzzSeconds);
    Serial.println("s");
  }

  // The site pushes its own bad-posture angle so the vibration and the
  // on-screen verdict can never disagree. Kept as a float: the site's default
  // is 20.5 degrees, and rounding it to 20 would make them disagree by half a
  // degree at exactly the boundary this exists to keep them agreeing on.
  float threshold = numberAfter(body, "\"threshold\"");
  if (!isnan(threshold) && threshold > 0 && threshold < 90) {
    tiltThreshold = threshold;
  }
}

/**
 * One connection attempt, with the will that tells the website the board is
 * gone. Retries are spaced out by the caller — hammering the broker in a tight
 * loop is what gets a client rate-limited off a public one.
 */
void connectMQTT(unsigned long now) {
  if (mqtt.connected() || WiFi.status() != WL_CONNECTED) return;
  if (now < nextMqttTryMs) return;

  String clientId = String("align-") + boardCode + "-" + String((uint32_t)esp_random(), HEX);
  Serial.print("Connecting to broker as ");
  Serial.print(clientId);
  Serial.print(" ... ");

  bool ok = mqtt.connect(
      clientId.c_str(),
      NULL, NULL,                  // public broker: no credentials
      topicStatus.c_str(), 0, true, "offline");

  if (ok) {
    Serial.println("connected.");
    mqtt.publish(topicStatus.c_str(), "online", true);
    mqtt.subscribe(topicCommand.c_str());
    mqttBackoffMs = 2000;
    // One tap: the board is on the internet and reachable. Worth feeling on
    // the wearer's back right after Wi-Fi setup, when there is no screen
    // nearby to say whether it worked.
    startPattern(PATTERN_BOARD_ONLINE,
                 sizeof(PATTERN_BOARD_ONLINE) / sizeof(PATTERN_BOARD_ONLINE[0]));
    return;
  }

  Serial.print("failed, state ");
  Serial.println(mqtt.state());
  nextMqttTryMs = now + mqttBackoffMs;
  mqttBackoffMs = min(mqttBackoffMs * 2, 30000UL);
}

void publishReading(unsigned long now) {
  if (!mqtt.connected()) return;
  if (now - lastPublishMs < PUBLISH_INTERVAL) return;
  lastPublishMs = now;
  if (mqtt.publish(topicReading.c_str(), readingJSON().c_str())) publishCount++;
}

// ---------------------------------------------------------------- http

// Kept from ALIGN_WiFi so the board is still usable from a browser on the same
// network, and so the setup page has somewhere to show the code.
void sendJSON(const String &body) {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Cache-Control", "no-store");
  server.send(200, "application/json", body);
}

void handleReading() { sendJSON(readingJSON()); }

void handleCalibrate() {
  calibrateHere();
  sendJSON(readingJSON());
}

void handleBuzz() {
  if (server.hasArg("seconds")) {
    int seconds = server.arg("seconds").toInt();
    if (seconds < 0) seconds = 0;
    if (seconds > 60) seconds = 60;
    buzzSeconds = (uint8_t)seconds;
  }
  if (server.hasArg("threshold")) {
    float t = server.arg("threshold").toFloat();
    if (t > 0 && t < 90) tiltThreshold = t;
  }
  sendJSON(readingJSON());
}

void handleBuzzTest() {
  startPattern(PATTERN_TEST, sizeof(PATTERN_TEST) / sizeof(PATTERN_TEST[0]));
  sendJSON(readingJSON());
}

String pageHead(const String &title) {
  String html = "<!DOCTYPE html><html><head><meta charset='utf-8'>";
  html += "<meta name='viewport' content='width=device-width,initial-scale=1'>";
  html += "<title>" + title + "</title><style>";
  html += "body{font-family:system-ui,sans-serif;margin:0;padding:28px 22px;background:#F4F4F0;color:#1F1F1F}";
  html += "h1{font-size:20px;letter-spacing:2px;margin:0;color:#1B6B37}";
  html += "p{color:#5E5E5E;margin:6px 0;font-size:14px}";
  html += ".code{font:700 34px ui-monospace,Menlo,monospace;letter-spacing:.24em;color:#1B6B37;margin:6px 0 2px}";
  html += ".box{background:#fff;border-radius:14px;padding:18px;margin:16px 0;border:1px solid #E3E3DC}";
  html += "label{display:block;font-size:12px;font-weight:700;margin:12px 0 4px;color:#1F1F1F}";
  html += "input,select{width:100%;box-sizing:border-box;padding:11px;border:1px solid #CFCFC6;";
  html += "border-radius:9px;font-size:15px;background:#fff}";
  html += "button{margin-top:16px;width:100%;padding:13px;border:0;border-radius:999px;";
  html += "background:#1B6B37;color:#fff;font-size:15px;font-weight:700}";
  html += "b{color:#1B6B37}";
  html += "</style></head><body>";
  return html;
}

// The captive-portal page: pick a network, type the password, done.
void handleSetupRoot() {
  String html = pageHead("Set up ALIGN");
  html += "<h1>ALIGN</h1><p>Posture sensor setup</p>";

  html += "<div class='box'><p style='margin:0'>Your board code</p>";
  html += "<div class='code'>" + String(boardCode) + "</div>";
  html += "<p style='margin:0'>Type this into the ALIGN website to see your angles.</p></div>";

  html += "<div class='box'><form method='POST' action='/save'>";
  html += "<p style='margin:0 0 4px'><b>Join a Wi-Fi network</b></p>";
  html += "<p style='margin:0;font-size:12px'>This board has a 2.4 GHz radio only, so 5 GHz networks won't be listed.</p>";

  // A scan is a snapshot taken right now, and some networks are simply not in
  // it — hidden SSIDs, and phone hotspots, which sleep until something tries
  // to join and so are usually dark at the moment the page loads. The list is
  // a convenience; the text box underneath is what makes those reachable at
  // all. Offering only the dropdown left anyone whose network hadn't appeared
  // with no way to proceed.
  int found = WiFi.scanNetworks();
  html += "<label for='ssid'>Network</label>";
  html += "<select id='ssid' name='ssid'>";
  html += "<option value=''>— pick, or type one below —</option>";
  for (int i = 0; i < found; i++) {
    String name = WiFi.SSID(i);
    if (name.length() == 0) continue;
    name.replace("&", "&amp;");
    name.replace("'", "&#39;");
    name.replace("<", "&lt;");
    html += "<option value='" + name + "'>" + name + "  (" + String(WiFi.RSSI(i)) + " dBm)</option>";
  }
  html += "</select>";
  html += "<p style='margin:8px 0 0;font-size:12px'>" + String(found) + " network";
  html += String(found == 1 ? "" : "s") + " in range. <a href='/'>Scan again</a></p>";
  WiFi.scanDelete();

  html += "<label for='other'>…or type the name yourself</label>";
  html += "<input id='other' name='other' placeholder='e.g. your phone hotspot' ";
  html += "autocapitalize='off' autocorrect='off' spellcheck='false'>";
  html += "<p style='margin:8px 0 0;font-size:12px'>Phone hotspots often don't show up in the ";
  html += "list: they sleep until something joins. Type the name exactly, keep the hotspot ";
  html += "screen open on the phone, and this will find it.</p>";

  html += "<label for='pass'>Password</label>";
  html += "<input id='pass' name='pass' type='password' placeholder='Wi-Fi password'>";
  html += "<button type='submit'>Save and connect</button></form></div>";

  html += "<p style='font-size:12px'>Pitch <b>" + String(pitch, 1) + "&deg;</b> &nbsp; ";
  html += "Roll <b>" + String(roll, 1) + "&deg;</b> &nbsp; sensor: ";
  html += String(!imuPresent ? "simulated" : (imuKind == IMU_MPU6050 ? "MPU-6050" : "LSM6DS3")) + "</p>";
  html += "</body></html>";

  server.send(200, "text/html", html);
}

void handleSave() {
  // A typed name wins over the dropdown: it is the more deliberate of the two,
  // and it is the only way to reach a network the scan never saw.
  String ssid = server.arg("other");
  ssid.trim();
  if (ssid.length() == 0) {
    ssid = server.arg("ssid");
    ssid.trim();
  }
  String pass = server.arg("pass");

  if (ssid.length() == 0) {
    server.send(400, "text/html", pageHead("ALIGN") + "<h1>ALIGN</h1>"
                                  + "<p>Pick a network from the list, or type its name.</p>"
                                  + "<p><a href='/'>Back</a></p></body></html>");
    return;
  }

  prefs.begin("align", false);
  prefs.putString("ssid", ssid);
  prefs.putString("pass", pass);
  prefs.end();

  String html = pageHead("ALIGN");
  html += "<h1>ALIGN</h1><div class='box'><p style='margin:0'>Saved <b>" + ssid + "</b>.</p>";
  html += "<p>The board is restarting to join it. This hotspot will disappear — ";
  html += "rejoin your normal Wi-Fi, open the ALIGN website and enter code</p>";
  html += "<div class='code'>" + String(boardCode) + "</div></div>";
  html += "<p style='font-size:12px'>If it can't join, the hotspot comes back in about 30 seconds.</p>";
  html += "</body></html>";
  server.send(200, "text/html", html);

  Serial.print("Saved network \"");
  Serial.print(ssid);
  Serial.println("\" — restarting.");
  delay(1200);
  ESP.restart();
}

// A page you can open yourself, once the board is on your network.
void handleRoot() {
  String html = pageHead("ALIGN sensor");
  html += "<h1>ALIGN</h1><p>Posture sensor</p>";

  html += "<div class='box'><p style='margin:0'>Your board code</p>";
  html += "<div class='code'>" + String(boardCode) + "</div>";
  html += "<p style='margin:0'>Enter this on the ALIGN website.</p></div>";

  html += "<div class='box'>";
  html += "<p>Pitch <b>" + String(pitch, 1) + "&deg;</b> &nbsp; Roll <b>" + String(roll, 1) + "&deg;</b></p>";
  html += "<p>Off upright: " + String(deviation(), 1) + "&deg;";
  html += calibrated ? "" : " (not calibrated yet)";
  html += "</p><p>Wi-Fi: <b>" + WiFi.SSID() + "</b> at " + WiFi.localIP().toString() + "</p>";
  html += "<p>Broker: <b>" + String(mqtt.connected() ? "connected" : "not connected") + "</b>, ";
  html += String(publishCount) + " readings sent</p>";
  html += "<p>Sensor: " + String(!imuPresent ? "simulated" : (imuKind == IMU_MPU6050 ? "MPU-6050" : "LSM6DS3")) + "</p></div>";

  html += "<p style='font-size:12px'><a href='/reading'>/reading</a> &nbsp; ";
  html += "<a href='/calibrate'>/calibrate</a> &nbsp; <a href='/buzz-test'>/buzz-test</a> &nbsp; ";
  html += "<a href='/forget'>forget this network</a></p>";
  html += "</body></html>";

  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.send(200, "text/html", html);
}

// Wipes the saved network so the setup hotspot comes back. The only way back
// to the portal once a network is stored.
void handleForget() {
  prefs.begin("align", false);
  prefs.clear();
  prefs.end();
  server.send(200, "text/html", pageHead("ALIGN")
              + "<h1>ALIGN</h1><p>Network forgotten. Restarting into setup mode — "
              + "join the <b>ALIGN-setup</b> hotspot.</p></body></html>");
  Serial.println("Network forgotten — restarting into setup mode.");
  delay(1000);
  ESP.restart();
}

// ---------------------------------------------------------------- wifi

const char *disconnectReason(uint8_t reason) {
  switch (reason) {
    case WIFI_REASON_DISASSOC_DUE_TO_INACTIVITY: return "the access point dropped us as idle (reason 4)";
    case WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT: return "wrong password (4-way handshake timed out)";
    case WIFI_REASON_NO_AP_FOUND:       return "no access point with that name is in range";
    case WIFI_REASON_AUTH_FAIL:         return "the network refused the password";
    case WIFI_REASON_ASSOC_FAIL:        return "the access point refused to associate";
    case WIFI_REASON_HANDSHAKE_TIMEOUT: return "wrong password (the handshake timed out)";
    case WIFI_REASON_AUTH_EXPIRE:       return "authentication expired";
    case WIFI_REASON_BEACON_TIMEOUT:    return "lost sight of the access point";
    case WIFI_REASON_CONNECTION_FAIL:   return "the connection attempt failed";
    default:                            return "unknown";
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

bool joinSavedNetwork() {
  prefs.begin("align", true);
  String ssid = prefs.getString("ssid", "");
  String pass = prefs.getString("pass", "");
  prefs.end();

  if (ssid.length() == 0) {
    Serial.println("No network saved yet.");
    return false;
  }

  Serial.print("Joining \"");
  Serial.print(ssid);
  Serial.print("\"");

  WiFi.onEvent(onWiFiEvent);
  WiFi.mode(WIFI_STA);
  // Some Wi-Fi 6 routers advertise WPA3; the C3 negotiates better with power
  // saving off and the minimum security floor dropped to WPA2.
  WiFi.setSleep(false);
  WiFi.setMinSecurity(WIFI_AUTH_WPA_PSK);
  WiFi.setAutoReconnect(true);
  WiFi.begin(ssid.c_str(), pass.c_str());

  unsigned long started = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - started < WIFI_TIMEOUT_MS) {
    delay(400);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("Connected. Board is at http://");
    Serial.println(WiFi.localIP());
    return true;
  }

  Serial.println("Could not join — starting the setup hotspot instead.");
  return false;
}

// ESP32-C3 Dev Module: give the radio time after WIFI_AP, pin channel 1
// (2.4 GHz), and leave the network open so joining it is one tap.
void startSetupPortal() {
  setupMode = true;

  WiFi.persistent(false);
  // AP_STA rather than AP: scanning for networks needs a station interface, and
  // in AP-only mode WiFi.scanNetworks() fails outright — the setup page would
  // fall back to a bare text box and make you type your SSID from memory.
  WiFi.mode(WIFI_AP_STA);
  delay(200);
  WiFi.setSleep(false);

  bool ok = WiFi.softAP(SETUP_AP_SSID, NULL, 1, 0, 4);
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

  // Answering every name with our own address is what makes phones pop the
  // setup page up by themselves instead of waiting to be told an address.
  dns.setTTL(1);
  dns.start(53, "*", ip);

  Serial.println();
  Serial.print("Join the Wi-Fi network \"");
  Serial.print(SETUP_AP_SSID);
  Serial.println("\" (no password).");
  Serial.println("The setup page should open by itself, or visit http://192.168.4.1");
}

// ---------------------------------------------------------------- sketch

void setup() {
  Serial.begin(115200);
  // With "USB CDC On Boot" enabled, Serial is the USB device rather than a
  // UART, and it blocks forever waiting for a monitor to read from it — the
  // board would never reach startSetupPortal(). Zero timeout drops prints
  // nobody is listening to. Guarded because the method only exists on the CDC
  // class, so the sketch still builds with CDC off.
#if ARDUINO_USB_CDC_ON_BOOT
  Serial.setTxTimeoutMs(0);
#endif
  unsigned long serialWait = millis();
  while (!Serial && millis() - serialWait < 2000) delay(10);

  Serial.println();
  Serial.println("ALIGN cloud firmware starting.");

  pinMode(MOTOR_PIN, OUTPUT);
  digitalWrite(MOTOR_PIN, LOW);

  Serial.println("Looking for an IMU (MPU-6050 or LSM6DS3)...");
  if (findIMU()) {
    if (imuKind == IMU_MPU6050) {
      imuPresent = mpuBegin();
    } else {
      imu = new LSM6DS3(I2C_MODE, imuAddress);
      imuPresent = (imu->begin() == 0);
    }
  }
  if (imuPresent) {
    Serial.printf("%s ready at 0x%02X on SDA %d / SCL %d: streaming real tilt.\n",
                  imuKind == IMU_MPU6050 ? "MPU-6050" : "LSM6DS3",
                  imuAddress, sdaPin, sclPin);
  } else {
    Serial.println("No IMU found on any candidate pin pair — streaming a demo sweep.");
    Serial.println("  Check 3V3, GND, SDA and SCL, then add the pair to I2C_CANDIDATES.");
  }

  Serial.println("Looking for a battery divider...");
  findBatteryPin();

  makeBoardCode();
  Serial.println();
  Serial.println("  ┌──────────────────────────────┐");
  Serial.printf("  │   BOARD CODE:  %s        │\n", boardCode);
  Serial.println("  └──────────────────────────────┘");
  Serial.println("  Type that into the ALIGN website to pair.");
  Serial.println();

  if (!joinSavedNetwork()) {
    startSetupPortal();
  } else {
    mqtt.setServer(MQTT_HOST, MQTT_PORT);
    mqtt.setCallback(onCommand);
    mqtt.setBufferSize(512);
    mqtt.setKeepAlive(30);

    if (MDNS.begin(MDNS_NAME)) {
      MDNS.addService("http", "tcp", 80);
      Serial.print("Also reachable at http://");
      Serial.print(MDNS_NAME);
      Serial.println(".local");
    }
  }

  // In setup mode every unknown address returns the portal, which is what a
  // phone's captive-portal probe is looking for.
  if (setupMode) {
    server.on("/", handleSetupRoot);
    server.on("/save", HTTP_POST, handleSave);
    server.onNotFound(handleSetupRoot);
  } else {
    server.on("/", handleRoot);
    server.on("/forget", handleForget);
    server.onNotFound([]() {
      server.sendHeader("Access-Control-Allow-Origin", "*");
      server.send(404, "application/json", "{\"error\":\"no such endpoint\"}");
    });
  }
  server.on("/reading", handleReading);
  server.on("/calibrate", handleCalibrate);
  server.on("/buzz", handleBuzz);
  server.on("/buzz-test", handleBuzzTest);
  server.begin();
  Serial.println("Web server running.");
}

void loop() {
  if (setupMode) dns.processNextRequest();
  server.handleClient();

  unsigned long now = millis();

  if (now - previousMillis >= SAMPLE_INTERVAL) {
    previousMillis = now;
    readTilt();
    updateBuzz(now);
  }

  if (!setupMode) {
    connectMQTT(now);
    mqtt.loop();
    publishReading(now);
  }

  if (now - lastPrintMs >= 5000) {
    lastPrintMs = now;
    Serial.print("code ");
    Serial.print(boardCode);
    Serial.print("  pitch ");
    Serial.print(pitch, 1);
    Serial.print("  roll ");
    Serial.print(roll, 1);
    Serial.print("  off upright ");
    Serial.print(deviation(), 1);
    Serial.print("  calibrated=");
    Serial.print(calibrated ? "yes" : "no");
    if (setupMode) {
      Serial.print("  SETUP MODE - join \"");
      Serial.print(SETUP_AP_SSID);
      Serial.println("\" and open http://192.168.4.1");
    } else {
      Serial.print("  batt=");
    if (batteryPercent() < 0) Serial.print("n/a");
    else { Serial.print(batteryPercent()); Serial.print("%/"); Serial.print(batteryVolts(), 2); Serial.print("V"); }
    Serial.print("  ax=");
    Serial.print(lastAxg, 2);
    Serial.print(" ay=");
    Serial.print(lastAyg, 2);
    Serial.print("  i2cErrors=");
    Serial.print(imuReadErrors);
    Serial.print("  wifi=");
      Serial.print(WiFi.SSID());
      Serial.print("  broker=");
      Serial.print(mqtt.connected() ? "up" : "down");
      Serial.print("  sent=");
      Serial.println(publishCount);
    }
  }
}
