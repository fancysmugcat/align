/*
 * ALIGN — ESP32 posture sensor firmware
 *
 * Pairs with the ALIGN iOS app. Reads tilt from an MPU-6050, notifies the app
 * ~10x/second, and buzzes a vibration motor when posture slips.
 *
 * Board:  any ESP32 dev board (Arduino core for ESP32 installed, 2.x or 3.x)
 * Wiring: MPU-6050  SDA -> GPIO21, SCL -> GPIO22, VCC -> 3V3, GND -> GND
 *         Vibration motor driver -> GPIO25
 *         Battery divider (2x 100k from VBAT to GND) -> GPIO34
 *
 * None of that wiring is required to get connected. With no MPU-6050 attached
 * the sketch streams a slow sweep instead of real tilt, so a bare dev board
 * still pairs with the website and moves the gauge — flash it, open the site,
 * press Connect.
 *
 * The UUIDs below must match web/js/protocol.js.
 */

#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <Wire.h>
#include <math.h>

// The Bluedroid cores (2.x, 3.x) need a BLE2902 descriptor before a client can
// subscribe. The NimBLE-based cores add it themselves and don't ship the
// header, so only include it when it's there.
#if __has_include(<BLE2902.h>)
  #include <BLE2902.h>
  #define ALIGN_HAS_BLE2902 1
#endif

// ---------------------------------------------------------------- constants

#define SERVICE_UUID   "A11C0001-7E9C-4D2B-9B3A-2F5C9D1E0001"
#define POSTURE_UUID   "A11C0002-7E9C-4D2B-9B3A-2F5C9D1E0002"
#define BUZZ_UUID      "A11C0003-7E9C-4D2B-9B3A-2F5C9D1E0003"
#define COMMAND_UUID   "A11C0004-7E9C-4D2B-9B3A-2F5C9D1E0004"

static const char *DEVICE_NAME = "ALIGN";

static const int PIN_MOTOR   = 25;
static const int PIN_BATTERY = 34;

static const uint8_t MPU_ADDR = 0x68;

// Notify at 10 Hz — matches what the app expects for a smooth gauge.
static const unsigned long SAMPLE_MS = 100;

// Buzz once posture has been bad for this long, then hold off this long.
static const unsigned long BAD_POSTURE_GRACE_MS = 4000;
static const unsigned long BUZZ_COOLDOWN_MS     = 15000;
// Degrees away from the calibrated upright angle that counts as bad posture.
static const float BAD_ANGLE_DEG = 15.0f;

// Complementary-filter weight for the gyro vs the accelerometer.
static const float FILTER_ALPHA = 0.96f;

// ---------------------------------------------------------------- state

BLECharacteristic *postureChar = nullptr;
bool deviceConnected = false;

bool mpuPresent = false;                // false -> stream a demo sweep instead
float pitch = 0, roll = 0;              // degrees, filtered
float basePitch = 0, baseRoll = 0;      // device-side upright reference
uint8_t buzzSeconds = 2;                // 0 = off, else buzz duration
uint16_t sequence = 0;

unsigned long lastSampleMs = 0;
unsigned long badSinceMs = 0;
unsigned long lastBuzzMs = 0;
unsigned long buzzUntilMs = 0;

// ---------------------------------------------------------------- MPU-6050

void mpuWrite(uint8_t reg, uint8_t value) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  Wire.write(value);
  Wire.endTransmission();
}

// True if an MPU-6050 answers on the I2C bus.
bool mpuDetect() {
  Wire.beginTransmission(MPU_ADDR);
  return Wire.endTransmission() == 0;
}

bool mpuBegin() {
  Wire.begin(21, 22);
  if (!mpuDetect()) return false;
  mpuWrite(0x6B, 0x00);  // wake up
  mpuWrite(0x1C, 0x00);  // accel +/- 2g
  mpuWrite(0x1B, 0x00);  // gyro +/- 250 deg/s
  return true;
}

// No sensor wired yet: sweep in and out of "bad posture" so the website has
// something to draw and the BLE link can be checked on its own.
void simulateTilt(float dt) {
  static float t = 0;
  t += dt;
  pitch = 12.0f + sinf(t / 14.0f) * 13.0f + sinf(t / 2.3f) * 2.5f;
  roll = sinf(t / 21.0f) * 9.0f + cosf(t / 3.1f) * 1.5f;
}

// Reads accel + gyro and updates the filtered pitch/roll, in degrees.
void mpuUpdate(float dt) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(0x3B);
  Wire.endTransmission(false);
  Wire.requestFrom((int)MPU_ADDR, 14, true);
  if (Wire.available() < 14) return;

  int16_t ax = Wire.read() << 8 | Wire.read();
  int16_t ay = Wire.read() << 8 | Wire.read();
  int16_t az = Wire.read() << 8 | Wire.read();
  Wire.read(); Wire.read();                       // temperature, unused
  int16_t gx = Wire.read() << 8 | Wire.read();
  int16_t gy = Wire.read() << 8 | Wire.read();
  Wire.read(); Wire.read();                       // gz, unused

  float axg = ax / 16384.0f, ayg = ay / 16384.0f, azg = az / 16384.0f;
  float accPitch = atan2f(-axg, sqrtf(ayg * ayg + azg * azg)) * 180.0f / PI;
  float accRoll  = atan2f(ayg, azg) * 180.0f / PI;

  float gyroPitch = gy / 131.0f;   // deg/s
  float gyroRoll  = gx / 131.0f;

  pitch = FILTER_ALPHA * (pitch + gyroPitch * dt) + (1 - FILTER_ALPHA) * accPitch;
  roll  = FILTER_ALPHA * (roll  + gyroRoll  * dt) + (1 - FILTER_ALPHA) * accRoll;
}

// ---------------------------------------------------------------- battery

// 2:1 divider into a 3.3V ADC, mapped across a 3.0-4.2V LiPo curve.
uint8_t batteryPercent() {
  int raw = analogRead(PIN_BATTERY);
  float volts = (raw / 4095.0f) * 3.3f * 2.0f;
  float pct = (volts - 3.0f) / (4.2f - 3.0f) * 100.0f;
  if (pct < 0) pct = 0;
  if (pct > 100) pct = 100;
  return (uint8_t)pct;
}

// ---------------------------------------------------------------- BLE

class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *server) override {
    deviceConnected = true;
  }
  void onDisconnect(BLEServer *server) override {
    deviceConnected = false;
    server->startAdvertising();   // let the app find us again
  }
};

// `auto` keeps this compiling on both Arduino-ESP32 2.x (std::string) and
// 3.x (Arduino String).
class BuzzCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *characteristic) override {
    auto value = characteristic->getValue();
    if (value.length() == 0) return;

    // One raw byte from the website, or "buzz:2" from a serial-style client.
    if (value.length() == 1 && (uint8_t)value[0] <= 60) {
      buzzSeconds = (uint8_t)value[0];
      return;
    }
    for (size_t i = 0; i < value.length(); i++) {
      if (value[i] >= '0' && value[i] <= '9') {
        buzzSeconds = (uint8_t)(value[i] - '0');
        return;
      }
    }
  }
};

class CommandCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *characteristic) override {
    auto value = characteristic->getValue();
    if (value.length() == 0) return;

    uint8_t code = (uint8_t)value[0];
    if (code == 'c' || code == 'C') code = 0x01;   // "calibrate"
    if (code == 'b' || code == 'B') code = 0x02;   // "buzz-test"

    switch (code) {
      case 0x01:                       // calibrate: this is upright
        basePitch = pitch;
        baseRoll = roll;
        break;
      case 0x02:                       // test buzz
        buzzUntilMs = millis() + 400;
        digitalWrite(PIN_MOTOR, HIGH);
        break;
    }
  }
};

void startBLE() {
  BLEDevice::init(DEVICE_NAME);
  BLEServer *server = BLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());

  BLEService *service = server->createService(SERVICE_UUID);

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
  // The website filters the chooser on this service UUID, so it has to be in
  // the advertisement, not just in the GATT table.
  advertising->addServiceUUID(SERVICE_UUID);
  advertising->setScanResponse(true);
  advertising->setMinPreferred(0x06);   // helps some phones connect reliably
  advertising->setMinPreferred(0x12);
  BLEDevice::startAdvertising();
}

// Packet layout the app decodes in DeviceReading(packet:).
void notifyPosture() {
  if (!deviceConnected || postureChar == nullptr) return;

  int16_t p = (int16_t)roundf(pitch * 100.0f);
  int16_t r = (int16_t)roundf(roll * 100.0f);
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
  postureChar->notify();
}

// ---------------------------------------------------------------- buzz logic

void updateBuzz(unsigned long now) {
  if (buzzUntilMs != 0 && now >= buzzUntilMs) {
    digitalWrite(PIN_MOTOR, LOW);
    buzzUntilMs = 0;
  }
  if (buzzSeconds == 0) return;

  float dp = pitch - basePitch;
  float dr = roll - baseRoll;
  float deviation = sqrtf(dp * dp + dr * dr);

  if (deviation < BAD_ANGLE_DEG) {
    badSinceMs = 0;
    return;
  }
  if (badSinceMs == 0) {
    badSinceMs = now;
    return;
  }
  if (now - badSinceMs < BAD_POSTURE_GRACE_MS) return;
  if (now - lastBuzzMs < BUZZ_COOLDOWN_MS) return;

  lastBuzzMs = now;
  buzzUntilMs = now + (unsigned long)buzzSeconds * 1000UL;
  digitalWrite(PIN_MOTOR, HIGH);
}

// ---------------------------------------------------------------- sketch

void setup() {
  Serial.begin(115200);
  pinMode(PIN_MOTOR, OUTPUT);
  digitalWrite(PIN_MOTOR, LOW);
  analogReadResolution(12);

  mpuPresent = mpuBegin();
  startBLE();

  Serial.println();
  Serial.print("ALIGN advertising as \"");
  Serial.print(DEVICE_NAME);
  Serial.println("\" — open the website and press Connect.");
  Serial.println(mpuPresent
      ? "MPU-6050 found: streaming real tilt."
      : "No MPU-6050 on I2C: streaming a demo sweep so the link can be tested.");
}

void loop() {
  unsigned long now = millis();
  if (now - lastSampleMs < SAMPLE_MS) return;

  float dt = (now - lastSampleMs) / 1000.0f;
  if (dt > 1.0f) dt = SAMPLE_MS / 1000.0f;   // first pass / after a stall
  lastSampleMs = now;

  if (mpuPresent) mpuUpdate(dt);
  else simulateTilt(dt);

  updateBuzz(now);
  notifyPosture();
}
