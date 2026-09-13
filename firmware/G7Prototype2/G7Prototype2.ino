/*
 * G7 Prototype 2 — ALIGN posture sensor
 *
 * HOW THE LINK WORKS
 * ------------------
 * There is deliberately no code here that "connects to the website", because a
 * BLE peripheral cannot do that. This board *advertises* — it announces itself
 * as "ALIGN" carrying service A11C0001 — and the browser is the side that
 * reaches out and connects. So the sketch's whole job is:
 *
 *   1. advertise, forever, whether or not anyone is listening
 *   2. hold a characteristic the browser can subscribe to (A11C0002)
 *   3. push pitch and roll into it ten times a second
 *   4. accept the two settings the site writes back (buzz duration, calibrate)
 *
 * Flash this, then press Connect on the website. Nothing else is needed.
 *
 * Board:   ESP32-C3 (SDA 6 / SCL 7, as on a XIAO ESP32-C3)
 * Sensor:  LSM6DS3 at 0x6B — SparkFun LSM6DS3 library
 * Motor:   GPIO 4
 *
 * The UUIDs must match web/js/protocol.js.
 */

#include <Wire.h>
#include <SparkFunLSM6DS3.h>
#include <math.h>

#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>

// Bluedroid cores need this descriptor before a client can subscribe; NimBLE
// cores add it themselves and don't ship the header.
#if __has_include(<BLE2902.h>)
  #include <BLE2902.h>
  #define ALIGN_HAS_BLE2902 1
#endif

// ---------------------------------------------------------------- pins

const int MOTOR_PIN = 4;
const int SDA_PIN   = 6;
const int SCL_PIN   = 7;

// An ADC pin on a battery divider, or -1 to report "unknown" to the site.
const int BATTERY_PIN = -1;

// ---------------------------------------------------------------- settings

const float TILT_THRESHOLD = 15.0;          // degrees off upright = bad posture
const unsigned long NOTIFY_INTERVAL = 100;  // ms between readings (10 Hz)

// Buzz once posture has been bad this long, then hold off this long.
const unsigned long BAD_POSTURE_GRACE_MS = 3000;
const unsigned long BUZZ_COOLDOWN_MS     = 10000;
// Hard ceiling on a single buzz, whatever the website asks for.
const unsigned long MAX_BUZZ_MS          = 5000;

// 0 = raw readings, 0.9 = heavily smoothed.
const float SMOOTHING = 0.75;

// ---------------------------------------------------------------- BLE contract

#define SERVICE_UUID   "A11C0001-7E9C-4D2B-9B3A-2F5C9D1E0001"
#define POSTURE_UUID   "A11C0002-7E9C-4D2B-9B3A-2F5C9D1E0002"
#define BUZZ_UUID      "A11C0003-7E9C-4D2B-9B3A-2F5C9D1E0003"
#define COMMAND_UUID   "A11C0004-7E9C-4D2B-9B3A-2F5C9D1E0004"

static const char *DEVICE_NAME = "ALIGN";

// ---------------------------------------------------------------- state

LSM6DS3 imu(I2C_MODE, 0x6B);
bool imuPresent = false;

BLEServer *bleServer = nullptr;
BLECharacteristic *postureChar = nullptr;
bool sawClientWrite = false;

float pitch = 0, roll = 0;              // degrees, smoothed
float basePitch = 0, baseRoll = 0;      // upright reference from calibration
// Nothing buzzes until the website has told us what upright means. Without
// this, a board lying on a desk reads ~100 degrees "off upright" against a
// baseline of zero and vibrates forever.
bool calibrated = false;
uint8_t buzzSeconds = 5;                // the site overrides this on connect
uint16_t sequence = 0;

unsigned long previousMillis = 0;
unsigned long lastPrintMs = 0;
unsigned long badSinceMs = 0;
unsigned long lastBuzzMs = 0;
unsigned long buzzUntilMs = 0;

// ---------------------------------------------------------------- sensor

// Pitch and roll in degrees, from the accelerometer alone.
//
// The original prototype reduced tilt to one number — atan2(sqrt(ax²+ay²), az)
// — which says how far off vertical you are but not which way. The site needs
// both: pitch drives the gauge, and the sign of roll is what the
// "Left or Right?" card reads.
//
// If left and right come out swapped, negate rollDeg. If leaning forward reads
// as leaning back, negate pitchDeg.
void readTilt() {
  if (!imuPresent) {
    // No sensor answering — sweep in and out of bad posture so the link can
    // still be tested end to end.
    static float t = 0;
    t += NOTIFY_INTERVAL / 1000.0;
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

uint8_t batteryPercent() {
  if (BATTERY_PIN < 0) return 255;      // 255 = unknown; the site hides it

  int raw = analogRead(BATTERY_PIN);
  float volts = (raw / 4095.0) * 3.3 * 2.0;
  float pct = (volts - 3.0) / (4.2 - 3.0) * 100.0;
  if (pct < 0) pct = 0;
  if (pct > 100) pct = 100;
  return (uint8_t)pct;
}

// ---------------------------------------------------------------- BLE

class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *server) override {
    Serial.println("Website connected.");
  }
  void onDisconnect(BLEServer *server) override {
    Serial.println("Website disconnected — advertising again.");
    server->startAdvertising();
  }
};

// `auto` keeps this compiling on cores that return std::string and on those
// that return Arduino String.
class BuzzCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *characteristic) override {
    auto value = characteristic->getValue();
    if (value.length() == 0) return;
    sawClientWrite = true;

    if (value.length() == 1 && (uint8_t)value[0] <= 60) {
      buzzSeconds = (uint8_t)value[0];        // raw byte from the website
    } else {
      for (size_t i = 0; i < value.length(); i++) {   // or text: "buzz:2"
        if (value[i] >= '0' && value[i] <= '9') {
          buzzSeconds = (uint8_t)(value[i] - '0');
          break;
        }
      }
    }
    Serial.print("Buzz set to ");
    Serial.print(buzzSeconds);
    Serial.println("s");
  }
};

class CommandCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *characteristic) override {
    auto value = characteristic->getValue();
    if (value.length() == 0) return;
    sawClientWrite = true;

    uint8_t code = (uint8_t)value[0];
    if (code == 'c' || code == 'C') code = 0x01;   // "calibrate"
    if (code == 'b' || code == 'B') code = 0x02;   // "buzz-test"

    switch (code) {
      case 0x01:
        basePitch = pitch;
        baseRoll = roll;
        calibrated = true;
        Serial.println("Calibrated: this is upright.");
        break;
      case 0x02:
        buzzUntilMs = millis() + 400;
        digitalWrite(MOTOR_PIN, HIGH);
        break;
    }
  }
};

void startBLE() {
  BLEDevice::init(DEVICE_NAME);
  bleServer = BLEDevice::createServer();
  bleServer->setCallbacks(new ServerCallbacks());

  BLEService *service = bleServer->createService(SERVICE_UUID);

  postureChar = service->createCharacteristic(
      POSTURE_UUID, BLECharacteristic::PROPERTY_NOTIFY | BLECharacteristic::PROPERTY_READ);
#ifdef ALIGN_HAS_BLE2902
  postureChar->addDescriptor(new BLE2902());
#endif

  BLECharacteristic *buzz = service->createCharacteristic(
      BUZZ_UUID, BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_READ);
  buzz->setCallbacks(new BuzzCallbacks());

  BLECharacteristic *command = service->createCharacteristic(
      COMMAND_UUID, BLECharacteristic::PROPERTY_WRITE);
  command->setCallbacks(new CommandCallbacks());

  service->start();

  BLEAdvertising *advertising = BLEDevice::getAdvertising();
  // The site filters the chooser on this UUID, so it must be in the
  // advertisement itself, not only in the GATT table.
  advertising->addServiceUUID(SERVICE_UUID);
  advertising->setScanResponse(true);
  advertising->setMinPreferred(0x06);
  advertising->setMinPreferred(0x12);
  BLEDevice::startAdvertising();
}

// The 8-byte packet web/js/protocol.js decodes:
//   [0..1] int16 pitch x100   [2..3] int16 roll x100
//   [4] uint8 battery %       [5] uint8 flags
//   [6..7] uint16 sequence
void notifyPosture() {
  if (postureChar == nullptr) return;

  int16_t p = (int16_t)round(pitch * 100.0);
  int16_t r = (int16_t)round(roll * 100.0);

  uint8_t packet[8];
  packet[0] = p & 0xFF;
  packet[1] = (p >> 8) & 0xFF;
  packet[2] = r & 0xFF;
  packet[3] = (r >> 8) & 0xFF;
  packet[4] = batteryPercent();
  packet[5] = (millis() < buzzUntilMs) ? 0x01 : 0x00;
  packet[6] = sequence & 0xFF;
  packet[7] = (sequence >> 8) & 0xFF;
  sequence++;

  postureChar->setValue(packet, sizeof(packet));
  // Unconditional on purpose: notify() is a no-op with no subscriber, and any
  // "are we connected?" flag of our own can disagree with the BLE stack.
  postureChar->notify();
}

// ---------------------------------------------------------------- buzzing

// Non-blocking. The prototype's delay(5000) would freeze Bluetooth for the
// whole buzz.
void updateBuzz(unsigned long now) {
  if (buzzUntilMs != 0 && now >= buzzUntilMs) {
    digitalWrite(MOTOR_PIN, LOW);
    buzzUntilMs = 0;
  }
  if (buzzSeconds == 0) return;
  if (!calibrated) return;        // no baseline yet — nothing to compare against

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

// ---------------------------------------------------------------- diagnostics

// The BLE library refuses to send a notification while it believes no client is
// connected, so this number is the one that matters: if a browser is attached
// and it still reads 0, the stack itself is dropping the connection event and
// no sketch change can push data out.
void printStatus() {
  Serial.print("pitch ");
  Serial.print(pitch, 1);
  Serial.print("  roll ");
  Serial.print(roll, 1);
  Serial.print("  off upright ");
  Serial.print(deviation(), 1);
  Serial.print("  | BLE clients=");
  Serial.print(bleServer ? bleServer->getConnectedCount() : 0);

  Serial.print(" notifyEnabled=");
#ifdef ALIGN_HAS_BLE2902
  BLE2902 *cccd = (BLE2902 *)postureChar->getDescriptorByUUID((uint16_t)0x2902);
  Serial.print(cccd == nullptr ? "?" : (cccd->getNotifications() ? "yes" : "no"));
#else
  Serial.print("n/a");
#endif

  Serial.print(" writes=");
  Serial.print(sawClientWrite ? "yes" : "no");
  Serial.print(" calibrated=");
  Serial.println(calibrated ? "yes" : "no");
}

// ---------------------------------------------------------------- sketch

void setup() {
  Serial.begin(115200);
  delay(1000);

  Wire.begin(SDA_PIN, SCL_PIN);
  pinMode(MOTOR_PIN, OUTPUT);
  digitalWrite(MOTOR_PIN, LOW);

  imuPresent = (imu.begin() == 0);
  Serial.println(imuPresent
      ? "LSM6DS3 ready: streaming real tilt."
      : "LSM6DS3 not found on SDA 6 / SCL 7 — streaming a demo sweep instead.");

  startBLE();
  Serial.print("Advertising as \"");
  Serial.print(DEVICE_NAME);
  Serial.println("\" — open the ALIGN website and press Connect.");
}

void loop() {
  unsigned long now = millis();
  if (now - previousMillis < NOTIFY_INTERVAL) return;
  previousMillis = now;

  readTilt();
  updateBuzz(now);
  notifyPosture();

  if (now - lastPrintMs >= 1000) {
    lastPrintMs = now;
    printStatus();
  }
}
