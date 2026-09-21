/*
 * ALIGN — ESP32-C3 posture sensor over Bluetooth (NimBLE)
 *
 * Same job as firmware/ALIGN_WiFi, over BLE instead of HTTP, so the board
 * works as a wearable with no router in reach.
 *
 * Why NimBLE and not the BLE library bundled with the ESP32 core: on this
 * board the bundled Bluedroid stack never registers the client. onConnect
 * never fires, getConnectedCount() stays 0 while a browser is connected and
 * subscribed, and BLECharacteristic::notify() drops every packet on that
 * check before it reaches the air. Two core versions behaved identically
 * (4.0.0-alpha1 and 3.3.11). NimBLE tracks connections separately and its
 * notify() returns a bool, so the serial log can prove a packet went out.
 *
 * Board:   XIAO ESP32-C3
 * Sensor:  MPU-6050 (0x68/0x69) or LSM6DS3 (0x6A/0x6B), pins probed — the
 *          board in hand has an MPU-6050 on SDA 6 / SCL 7
 * Motor:   GPIO 4
 * Library: NimBLE-Arduino 2.x
 *
 * The UUIDs below must match web/js/protocol.js.
 *
 * ── What the website does ────────────────────────────────────────────────
 *   subscribes to POSTURE_UUID  → 8-byte packet, 10x/second
 *   writes 1 byte to BUZZ_UUID  → buzz duration in seconds (0 = off)
 *   writes 1 byte to COMMAND_UUID → 0x01 calibrate, 0x02 test buzz
 */

#include <NimBLEDevice.h>
#include <Wire.h>
#include <SparkFunLSM6DS3.h>
#include <math.h>

// ---------------------------------------------------------------- protocol

#define SERVICE_UUID "a11c0001-7e9c-4d2b-9b3a-2f5c9d1e0001"
#define POSTURE_UUID "a11c0002-7e9c-4d2b-9b3a-2f5c9d1e0002"
#define BUZZ_UUID    "a11c0003-7e9c-4d2b-9b3a-2f5c9d1e0003"
#define COMMAND_UUID "a11c0004-7e9c-4d2b-9b3a-2f5c9d1e0004"

static const char *DEVICE_NAME = "ALIGN";

// Command bytes, from protocol.js `Command`.
static const uint8_t CMD_CALIBRATE = 0x01;
static const uint8_t CMD_TEST_BUZZ = 0x02;
// One side at a time, so the wiring and the left/right mapping can be checked
// without having to hold a lean past the threshold for three seconds first.
static const uint8_t CMD_TEST_LEFT = 0x03;
static const uint8_t CMD_TEST_RIGHT = 0x04;

// ---------------------------------------------------------------- pins

// One motor either side of the spine. Only the one on the side you are leaning
// toward fires, so the buzz says which way to correct without having to be
// interpreted — you straighten away from whichever side is humming.
//
// Set MOTOR_RIGHT_PIN to -1 for a band with a single motor; it then buzzes for
// either direction, as it did before.
// Found with the buzz-counting finder sketch: GPIO 0 pulsed three times and it
// was the right-hand motor that answered, leaving GPIO 4 as the left. The
// battery probe had already hinted at it — GPIO 0 read 1.89V with a 1.15V
// spread, the noisiest of the four, which is a motor coil rather than a
// floating input.
const int MOTOR_LEFT_PIN  = 4;
const int MOTOR_RIGHT_PIN = 0;

/** Kept for the pin probes, which must avoid anything already driving a motor. */
const int MOTOR_PIN = MOTOR_LEFT_PIN;

enum BuzzSide { BUZZ_LEFT, BUZZ_RIGHT, BUZZ_BOTH };
const int SDA_PIN   = 6;
const int SCL_PIN   = 7;

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

// Degrees off upright that count as bad posture. The website overwrites this
// over BLE with its own "Bad posture" boundary, so the buzz and the on-screen
// verdict always agree; this default matches the site as shipped.
float tiltThreshold = 20.5;
const unsigned long SAMPLE_INTERVAL = 100;  // ms between reads / notifies (10 Hz)

const unsigned long BAD_POSTURE_GRACE_MS = 3000;
const unsigned long BUZZ_COOLDOWN_MS     = 10000;
// Hard ceiling on one buzz, whatever the website asks for.
const unsigned long MAX_BUZZ_MS          = 5000;

// At the 100ms sample rate this is the trade between drag and jitter: 0.75 took
// about a second to arrive and visibly trailed the wearer, 0.45 passed enough
// accelerometer noise through that the reading twitched while the band sat
// still. 0.62 settles in roughly half a second.
const float SMOOTHING = 0.62;               // 0 = raw, 0.9 = heavily smoothed

// ---------------------------------------------------------------- state

LSM6DS3 *imu = nullptr;   // built once the probe knows the address

NimBLEServer         *server      = nullptr;
NimBLECharacteristic *postureChar = nullptr;

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

int sdaPin = SDA_PIN, sclPin = SCL_PIN;
uint8_t imuAddress = 0x68;
ImuKind imuKind = IMU_NONE;

bool imuPresent = false;

float pitch = 0, roll = 0;              // degrees, smoothed
float basePitch = 0, baseRoll = 0;      // upright reference
uint8_t buzzSeconds = 2;
uint16_t sequence = 0;

// Nothing vibrates until the website says what upright means. Without this a
// board lying on a desk reads far off a baseline of zero and buzzes forever.
bool calibrated = false;

// Mirrors Settings -> Device -> "Swap left and right". Without it the screen
// could say you are leaning right while the left motor buzzed.
bool swapSides = false;

// How many clients have actually subscribed to posture notifications. A
// connection alone isn't enough — the browser has to write the CCCD too.
uint16_t subscriberCount = 0;

// Purely diagnostic: the log is the only way to tell a board nobody
// connected to from one that connected and then never subscribed.
bool clientConnected = false;

unsigned long previousMillis = 0;
unsigned long lastPrintMs = 0;
unsigned long badSinceMs = 0;
unsigned long lastBuzzMs = 0;
unsigned long buzzUntilMs = 0;
unsigned long notifiesSent = 0;
unsigned long notifiesFailed = 0;

// ---------------------------------------------------------------- sensor

// Pitch and roll in degrees, from the accelerometer alone. The website needs
// both: pitch drives the angle gauge, and the sign of roll is what the
// "Left or Right?" card reads.
//
// If left and right come out swapped, negate rollDeg. If leaning forward reads
// as leaning back, negate pitchDeg.
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
    if (pins.sda == MOTOR_LEFT_PIN || pins.scl == MOTOR_LEFT_PIN) continue;
    if (MOTOR_RIGHT_PIN >= 0 && (pins.sda == MOTOR_RIGHT_PIN || pins.scl == MOTOR_RIGHT_PIN)) continue;

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
  // Negated so that positive means leaning right, which is what the site
  // assumes everywhere. This depends purely on which way the sensor faces, so
  // Settings -> Device -> "Swap left and right" flips it without a reflash if
  // the band is ever rebuilt the other way round.
  lastAxg = axg;
  lastAyg = ayg;
  rollDeg  = -atan2f(axg, azg) * 180.0f / PI;
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

void readTilt() {
  if (!imuPresent) {
    static float t = 0;
    t += SAMPLE_INTERVAL / 1000.0;
    pitch = 12.0 + sin(t / 14.0) * 13.0 + sin(t / 2.3) * 2.5;
    roll = sin(t / 21.0) * 9.0 + cos(t / 3.1) * 1.5;
    return;
  }

  if (imuKind == IMU_MPU6050) {
    float p = pitch, r = roll;
    if (!mpuReadTilt(p, r)) {
      imuReadErrors++;
      // Roughly two seconds of failures at the 100ms sample rate.
      if (++imuFailStreak >= 20) { imuFailStreak = 0; recoverI2C(); }
      return;                       // keep the last angles; don't invent one
    }
    imuFailStreak = 0;
    pitch = SMOOTHING * pitch + (1 - SMOOTHING) * p;
    roll  = SMOOTHING * roll  + (1 - SMOOTHING) * r;
    return;
  }

  float ax = imu->readFloatAccelX();
  float ay = imu->readFloatAccelY();
  float az = imu->readFloatAccelZ();

  float pitchDeg = atan2(-ax, sqrt(ay * ay + az * az)) * 180.0 / PI;
  float rollDeg  = atan2(ay, az) * 180.0 / PI;

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
    if (pin == MOTOR_LEFT_PIN || pin == MOTOR_RIGHT_PIN) continue;
    if (pin == sdaPin || pin == sclPin) continue;
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

/** What the ADC pin itself sees, in millivolts, divider ratio not applied. */
float rawPinMillivolts() {
  if (batteryPin < 0) return 0.0f;
  return readPinVolts(batteryPin, nullptr) / BATTERY_DIVIDER * 1000.0f;
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

void motorsOff() {
  digitalWrite(MOTOR_LEFT_PIN, LOW);
  if (MOTOR_RIGHT_PIN >= 0) digitalWrite(MOTOR_RIGHT_PIN, LOW);
}

void startBuzz(unsigned long now, unsigned long durationMs, BuzzSide side) {
  if (durationMs > MAX_BUZZ_MS) durationMs = MAX_BUZZ_MS;
  buzzUntilMs = now + durationMs;

  // With one motor fitted it answers for both sides, so a single-motor band
  // keeps working exactly as it did rather than going silent on one side.
  const bool single = (MOTOR_RIGHT_PIN < 0);
  motorsOff();
  if (single || side == BUZZ_BOTH) {
    digitalWrite(MOTOR_LEFT_PIN, HIGH);
    if (!single) digitalWrite(MOTOR_RIGHT_PIN, HIGH);
  } else if (side == BUZZ_RIGHT) {
    digitalWrite(MOTOR_RIGHT_PIN, HIGH);
  } else {
    digitalWrite(MOTOR_LEFT_PIN, HIGH);
  }
}

/** Which way the wearer is leaning, as the website reports it. */
BuzzSide leaningSide() {
  float lean = roll - baseRoll;
  if (swapSides) lean = -lean;
  return lean >= 0 ? BUZZ_RIGHT : BUZZ_LEFT;
}

// Non-blocking: a delay() here would stall the BLE stack for the whole buzz.
void updateBuzz(unsigned long now) {
  if (buzzUntilMs != 0 && now >= buzzUntilMs) {
    motorsOff();
    buzzUntilMs = 0;
  }
  // Every reason the motors could stay silent, reported once each rather than
  // leaving "nothing happened" to be guessed at.
  static unsigned long lastWhyMs = 0;
  const bool explain = (now - lastWhyMs >= 5000);
  if (explain) lastWhyMs = now;

  if (buzzSeconds == 0) {
    if (explain) Serial.println("  [buzz] off — buzz duration is set to OFF on the site.");
    return;
  }
  if (!calibrated) {
    if (explain) Serial.println("  [buzz] idle — not calibrated yet, so there is no upright to be off from.");
    return;
  }

  if (deviation() < tiltThreshold) {
    if (explain) Serial.printf("  [buzz] idle — leaning %.1f deg, needs %.1f.\n", deviation(), tiltThreshold);
    badSinceMs = 0;
    return;
  }
  if (badSinceMs == 0) {
    badSinceMs = now;
    return;
  }
  if (now - badSinceMs < BAD_POSTURE_GRACE_MS) {
    if (explain) Serial.printf("  [buzz] waiting out the %lums grace period.\n", BAD_POSTURE_GRACE_MS);
    return;
  }
  if (now - lastBuzzMs < BUZZ_COOLDOWN_MS) {
    if (explain) Serial.println("  [buzz] in cooldown since the last buzz.");
    return;
  }

  BuzzSide side = leaningSide();
  Serial.printf("Bad posture (%.1f deg) — buzzing %s.\n",
                deviation(), side == BUZZ_RIGHT ? "right" : "left");
  lastBuzzMs = now;
  startBuzz(now, (unsigned long)buzzSeconds * 1000UL, side);
}

// ---------------------------------------------------------------- BLE

class ServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer *s, NimBLEConnInfo &info) override {
    clientConnected = true;
    Serial.print("Website connected (");
    Serial.print(info.getAddress().toString().c_str());
    Serial.println(") — waiting for it to subscribe.");
  }

  void onDisconnect(NimBLEServer *s, NimBLEConnInfo &info, int reason) override {
    Serial.print("Website disconnected (reason ");
    Serial.print(reason);
    Serial.println(") — advertising again.");
    subscriberCount = 0;
    clientConnected = false;
    NimBLEDevice::startAdvertising();
  }
};

// subValue bit 0 = notifications on, bit 1 = indications on.
class PostureCallbacks : public NimBLECharacteristicCallbacks {
  void onSubscribe(NimBLECharacteristic *c, NimBLEConnInfo &info, uint16_t subValue) override {
    if (subValue > 0) {
      subscriberCount++;
      Serial.println("Subscribed to posture — streaming now.");
    } else if (subscriberCount > 0) {
      subscriberCount--;
      Serial.println("Unsubscribed from posture.");
    }
  }
};

class BuzzCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic *c, NimBLEConnInfo &info) override {
    const NimBLEAttValue value = c->getValue();
    if (value.length() == 0) return;

    int seconds = value[0];
    if (seconds < 0) seconds = 0;
    if (seconds > 60) seconds = 60;
    buzzSeconds = (uint8_t)seconds;

    // Bytes 1-2, when present, carry the site's bad-posture angle in tenths of
    // a degree. Without them this is an older one-byte write, so the current
    // threshold stands.
    if (value.length() >= 3) {
      float degrees = (float)(value[1] | (value[2] << 8)) / 10.0f;
      if (degrees >= 5.0f && degrees <= 45.0f) tiltThreshold = degrees;
    }

    // Byte 3, when present, mirrors the site's left/right swap so the motor
    // that buzzes is on the side the screen is naming.
    if (value.length() >= 4) {
      swapSides = (value[3] & 0x01) != 0;
      Serial.printf("Sides are %s.\n", swapSides ? "swapped" : "normal");
    }

    // Bytes 4-5 carry the wearer's upright roll in tenths of a degree, sent
    // every time the site connects.
    //
    // The board forgets `calibrated` on every reboot while the site keeps its
    // baseline in storage, so after a reset the site showed a calibrated band
    // and correct angles — it subtracts its own baseline — while the board had
    // no idea what upright was and could never decide anyone was leaning. The
    // motors simply stayed silent, and nothing said why. Handing the baseline
    // over on connect keeps the two from drifting apart at all.
    if (value.length() >= 6) {
      int16_t tenths = (int16_t)(value[4] | (value[5] << 8));
      baseRoll = tenths / 10.0f;
      if (!calibrated) {
        calibrated = true;
        badSinceMs = 0;
        Serial.printf("Baseline from the site: upright roll %.1f deg.\n", baseRoll);
      }
    }

    Serial.print("Buzz set to ");
    Serial.print(buzzSeconds);
    Serial.print("s past ");
    Serial.print(tiltThreshold, 1);
    Serial.println(" degrees");
  }
};

class CommandCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic *c, NimBLEConnInfo &info) override {
    const NimBLEAttValue value = c->getValue();
    if (value.length() == 0) return;

    switch (value[0]) {
      case CMD_CALIBRATE:
        basePitch = pitch;
        baseRoll = roll;
        calibrated = true;
        badSinceMs = 0;
        Serial.println("Calibrated: this is upright.");
        // A short buzz is how the wearer knows it took.
        startBuzz(millis(), 300, BUZZ_BOTH);
        break;
      case CMD_TEST_LEFT:
        Serial.printf("Test buzz: LEFT motor, GPIO %d.\n", MOTOR_LEFT_PIN);
        startBuzz(millis(), 600, BUZZ_LEFT);
        break;
      case CMD_TEST_RIGHT:
        Serial.printf("Test buzz: RIGHT motor, GPIO %d.\n", MOTOR_RIGHT_PIN);
        startBuzz(millis(), 600, BUZZ_RIGHT);
        break;
      case CMD_TEST_BUZZ:
        Serial.println("Test buzz.");
        startBuzz(millis(), 400, BUZZ_BOTH);
        break;
      default:
        Serial.print("Unknown command byte 0x");
        Serial.println(value[0], HEX);
        break;
    }
  }
};

// Packet layout decoded by decodeReading() in web/js/protocol.js.
//
//   [0..1] int16  pitch, degrees x 100, little-endian
//   [2..3] int16  roll,  degrees x 100, little-endian
//   [4]    uint8  battery percent (0...100)
//   [5]    uint8  flags (bit 0: buzzing)
//   [6..7] uint16 sequence number
void notifyPosture() {
  if (postureChar == nullptr) return;

  // Deliberately NOT gated on subscriberCount.
  //
  // That counter only moves when onSubscribe fires, so it made the entire data
  // stream depend on one callback. When it didn't fire the board went totally
  // silent while looking healthy from every other angle — connected,
  // advertising, sensor read, no errors, nothing in the log — and the website
  // could only report that no readings arrived. A guard whose failure mode is
  // "silently send nothing, forever" is worse than no guard.
  //
  // It also bought nothing: NimBLE's notify() already transmits only to
  // clients that enabled notifications, and is a cheap no-op otherwise. At
  // 10 Hz the wasted work is unmeasurable.

  int16_t p = (int16_t)roundf(pitch * 100.0f);
  int16_t r = (int16_t)roundf(roll * 100.0f);
  int battery = batteryPercent();

  // Bytes 8-9 carry the raw voltage at the sense pin, before the divider ratio
  // is applied. A percentage alone can't be argued with — if the ratio is wrong
  // the number is confidently wrong and nothing on screen says so — whereas the
  // millivolts can be checked against a meter. The site ignores trailing bytes
  // it doesn't know, so older builds keep working.
  uint16_t pinMv = (batteryPin >= 0) ? (uint16_t)lroundf(rawPinMillivolts()) : 0;

  uint8_t packet[10];
  packet[0] = p & 0xFF;
  packet[1] = (p >> 8) & 0xFF;
  packet[2] = r & 0xFF;
  packet[3] = (r >> 8) & 0xFF;
  // The site treats anything outside 0...100 as "no battery reading".
  packet[4] = (battery < 0) ? 0xFF : (uint8_t)battery;
  packet[5] = (millis() < buzzUntilMs) ? 0x01 : 0x00;
  packet[6] = sequence & 0xFF;
  packet[7] = (sequence >> 8) & 0xFF;
  packet[8] = pinMv & 0xFF;
  packet[9] = (pinMv >> 8) & 0xFF;
  sequence++;

  if (postureChar->notify(packet, sizeof(packet))) notifiesSent++;
  else notifiesFailed++;
}

void startBLE() {
  NimBLEDevice::init(DEVICE_NAME);
  // The browser is not a phone in a pocket; a stronger signal makes the
  // chooser find the board on the first scan.
  NimBLEDevice::setPower(ESP_PWR_LVL_P9);

  server = NimBLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());

  NimBLEService *service = server->createService(SERVICE_UUID);

  postureChar = service->createCharacteristic(POSTURE_UUID, NIMBLE_PROPERTY::NOTIFY);
  postureChar->setCallbacks(new PostureCallbacks());

  NimBLECharacteristic *buzzChar = service->createCharacteristic(
      BUZZ_UUID, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR);
  buzzChar->setCallbacks(new BuzzCallbacks());

  NimBLECharacteristic *commandChar = service->createCharacteristic(
      COMMAND_UUID, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR);
  commandChar->setCallbacks(new CommandCallbacks());

  service->start();

  // The site filters the chooser by service UUID, so it has to be in the
  // advertisement itself, not only in the GATT table.
  NimBLEAdvertising *advertising = NimBLEDevice::getAdvertising();
  advertising->addServiceUUID(SERVICE_UUID);
  advertising->setName(DEVICE_NAME);
  advertising->enableScanResponse(true);

  // start() can fail (stack not ready, oversized advertisement payload).
  // Report what actually happened instead of assuming it worked.
  bool advOK = advertising->start();

  Serial.print("BLE MAC: ");
  Serial.println(NimBLEDevice::getAddress().toString().c_str());
  Serial.print("advertising->start() returned ");
  Serial.println(advOK ? "true" : "FALSE");
  Serial.print("isAdvertising() = ");
  Serial.println(advertising->isAdvertising() ? "YES" : "NO");
  Serial.print("Advertising as \"");
  Serial.print(DEVICE_NAME);
  Serial.println("\". Open the ALIGN website and press Bluetooth.");
}

// ---------------------------------------------------------------- sketch

void setup() {
  Serial.begin(115200);
  delay(1000);

  // Pins and chip are both probed — see findIMU().
  pinMode(MOTOR_LEFT_PIN, OUTPUT);
  if (MOTOR_RIGHT_PIN >= 0) pinMode(MOTOR_RIGHT_PIN, OUTPUT);
  motorsOff();

  if (findIMU()) {
    if (imuKind == IMU_MPU6050) {
      imuPresent = mpuBegin();
    } else {
      imu = new LSM6DS3(I2C_MODE, imuAddress);
      imuPresent = (imu->begin() == 0);
    }
  }
  Serial.println();
  if (imuPresent) {
    Serial.printf("%s ready at 0x%02X on SDA %d / SCL %d: streaming real tilt.\n",
                  imuKind == IMU_MPU6050 ? "MPU-6050" : "LSM6DS3",
                  imuAddress, sdaPin, sclPin);
  } else {
    Serial.println("No IMU found on any candidate pin pair — streaming a demo sweep.");
  }

  Serial.println("Looking for a battery divider...");
  findBatteryPin();

  startBLE();
}

void loop() {
  unsigned long now = millis();

  if (now - previousMillis >= SAMPLE_INTERVAL) {
    previousMillis = now;
    readTilt();
    updateBuzz(now);
    notifyPosture();
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
    Serial.print("  batt=");
    if (batteryPercent() < 0) Serial.print("n/a");
    else { Serial.print(batteryPercent()); Serial.print("%/"); Serial.print(batteryVolts(), 2); Serial.print("V"); }
    Serial.print("  ax=");
    Serial.print(lastAxg, 2);
    Serial.print(" ay=");
    Serial.print(lastAyg, 2);
    Serial.print("  i2cErrors=");
    Serial.print(imuReadErrors);
    Serial.print("  connected=");
    Serial.print(clientConnected ? "yes" : "no");
    Serial.print("  subscribers=");
    Serial.print(subscriberCount);
    Serial.print("  sent=");
    Serial.print(notifiesSent);
    Serial.print("  failed=");
    Serial.print(notifiesFailed);
    Serial.print("  advertising=");
    Serial.println(NimBLEDevice::getAdvertising()->isAdvertising() ? "yes" : "NO");
  }

  delay(5);
}
