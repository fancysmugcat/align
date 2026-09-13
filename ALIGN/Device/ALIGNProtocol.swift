import CoreBluetooth
import Foundation

/// BLE contract between this app and the ALIGN ESP32 firmware.
///
/// If your firmware already uses different UUIDs, change them here only —
/// nothing else in the app hard-codes them. The matching Arduino sketch lives
/// in `firmware/align_esp32.ino`.
enum ALIGNProtocol {

    /// Advertised primary service.
    static let service = CBUUID(string: "A11C0001-7E9C-4D2B-9B3A-2F5C9D1E0001")

    /// Notify. 8-byte posture packet, see `DeviceReading.init(packet:)`.
    static let postureCharacteristic = CBUUID(string: "A11C0002-7E9C-4D2B-9B3A-2F5C9D1E0002")

    /// Write. 1 byte: buzz duration in seconds (0 = off, 1, 2, 5).
    static let buzzCharacteristic = CBUUID(string: "A11C0003-7E9C-4D2B-9B3A-2F5C9D1E0003")

    /// Write. 1 byte command, see `Command`.
    static let commandCharacteristic = CBUUID(string: "A11C0004-7E9C-4D2B-9B3A-2F5C9D1E0004")

    /// Standard Battery Service, used as a fallback if the packet omits battery.
    static let batteryService = CBUUID(string: "180F")
    static let batteryLevelCharacteristic = CBUUID(string: "2A19")

    /// Name the ESP32 advertises. Used as a secondary filter.
    static let advertisedName = "ALIGN"

    enum Command: UInt8 {
        /// Tell the device this is upright — it zeroes its own reference too.
        case calibrate = 0x01
        /// One short buzz, used to confirm calibration in the UI.
        case testBuzz  = 0x02
    }
}

/// One decoded reading from the device.
struct DeviceReading: Equatable {
    /// Forward/back tilt in degrees, raw (not calibrated).
    var pitch: Double
    /// Side-to-side tilt in degrees, raw. Negative = left, positive = right.
    var roll: Double
    /// Battery percentage 0...100, or nil if the packet didn't carry one.
    var battery: Int?
    var timestamp: Date = Date()
}

extension DeviceReading {
    /// Decodes the 8-byte little-endian packet the firmware notifies with:
    ///
    ///     [0..1] int16  pitch, degrees x 100
    ///     [2..3] int16  roll,  degrees x 100
    ///     [4]    uint8  battery percent (0...100)
    ///     [5]    uint8  flags (bit 0: device-side buzz active)
    ///     [6..7] uint16 sequence number (unused by the app)
    ///
    /// Also accepts an ASCII fallback of the form `"pitch,roll,battery"` so a
    /// quick `Serial`-style firmware still works.
    init?(packet: Data) {
        if packet.count >= 6 {
            let bytes = [UInt8](packet)
            func int16(_ i: Int) -> Int16 {
                Int16(bitPattern: UInt16(bytes[i]) | (UInt16(bytes[i + 1]) << 8))
            }
            let pitchRaw = int16(0)
            let rollRaw = int16(2)
            let batteryRaw = Int(bytes[4])
            self.init(
                pitch: Double(pitchRaw) / 100,
                roll: Double(rollRaw) / 100,
                battery: (0...100).contains(batteryRaw) ? batteryRaw : nil
            )
            return
        }

        guard let text = String(data: packet, encoding: .utf8) else { return nil }
        let parts = text.split(separator: ",").map { Double($0.trimmingCharacters(in: .whitespaces)) }
        guard parts.count >= 2, let pitch = parts[0], let roll = parts[1] else { return nil }

        var battery: Int?
        if parts.count >= 3, let level = parts[2] { battery = Int(level) }
        self.init(pitch: pitch, roll: roll, battery: battery)
    }
}
