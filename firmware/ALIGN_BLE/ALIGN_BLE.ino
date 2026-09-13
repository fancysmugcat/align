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
 * Sensor:  LSM6DS3 at 0x6B on SDA 6 / SCL 7 — SparkFun LSM6DS3 library
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

// ---------------------------------------------------------------- pins

const int MOTOR_PIN = 4;
const int SDA_PIN   = 6;
const int SCL_PIN   = 7;

// An ADC pin on a battery divider, or -1 to report "unknown".
const int BATTERY_PIN = -1;

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

const float SMOOTHING = 0.75;               // 0 = raw, 0.9 = heavily smoothed

// ---------------------------------------------------------------- state

LSM6DS3 imu(I2C_MODE, 0x6B);

NimBLEServer         *server      = nullptr;
NimBLECharacteristic *postureChar = nullptr;

bool imuPresent = false;

float pitch = 0, roll = 0;              // degrees, smoothed
float basePitch = 0, baseRoll = 0;      // upright reference
uint8_t buzzSeconds = 2;
uint16_t sequence = 0;

// Nothing vibrates until the website says what upright means. Without this a
// board lying on a desk reads far off a baseline of zero and buzzes forever.
bool calibrated = false;

// How many clients have actually subscribed to posture notifications. A
// connection alone isn't enough — the browser has to write the CCCD too.
uint16_t subscriberCount = 0;

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

void startBuzz(unsigned long now, unsigned long durationMs) {
  if (durationMs > MAX_BUZZ_MS) durationMs = MAX_BUZZ_MS;
  buzzUntilMs = now + durationMs;
  digitalWrite(MOTOR_PIN, HIGH);
}

// Non-blocking: a delay() here would stall the BLE stack for the whole buzz.
void updateBuzz(unsigned long now) {
  if (buzzUntilMs != 0 && now >= buzzUntilMs) {
    digitalWrite(MOTOR_PIN, LOW);
    buzzUntilMs = 0;
  }
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
  startBuzz(now, (unsigned long)buzzSeconds * 1000UL);
}

// ---------------------------------------------------------------- BLE

class ServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer *s, NimBLEConnInfo &info) override {
    Serial.print("Website connected (");
    Serial.print(info.getAddress().toString().c_str());
    Serial.println(") — waiting for it to subscribe.");
  }

  void onDisconnect(NimBLEServer *s, NimBLEConnInfo &info, int reason) override {
    Serial.print("Website disconnected (reason ");
    Serial.print(reason);
    Serial.println(") — advertising again.");
    subscriberCount = 0;
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
        startBuzz(millis(), 300);
        break;
      case CMD_TEST_BUZZ:
        Serial.println("Test buzz.");
        startBuzz(millis(), 400);
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
  // No subscriber means nothing is listening; notifying anyway just burns
  // radio time. This counter comes from onSubscribe, not from the connection
  // bookkeeping that was unreliable on the bundled stack.
  if (subscriberCount == 0) return;

  int16_t p = (int16_t)roundf(pitch * 100.0f);
  int16_t r = (int16_t)roundf(roll * 100.0f);
  int battery = batteryPercent();

  uint8_t packet[8];
  packet[0] = p & 0xFF;
  packet[1] = (p >> 8) & 0xFF;
  packet[2] = r & 0xFF;
  packet[3] = (r >> 8) & 0xFF;
  // The site treats anything outside 0...100 as "no battery reading".
  packet[4] = (battery < 0) ? 0xFF : (uint8_t)battery;
  packet[5] = (millis() < buzzUntilMs) ? 0x01 : 0x00;
  packet[6] = sequence & 0xFF;
  packet[7] = (sequence >> 8) & 0xFF;
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

  Wire.begin(SDA_PIN, SCL_PIN);
  pinMode(MOTOR_PIN, OUTPUT);
  digitalWrite(MOTOR_PIN, LOW);

  imuPresent = (imu.begin() == 0);
  Serial.println();
  Serial.println(imuPresent
      ? "LSM6DS3 ready: streaming real tilt."
      : "LSM6DS3 not found on SDA 6 / SCL 7 — streaming a demo sweep instead.");

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
