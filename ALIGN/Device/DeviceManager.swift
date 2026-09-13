import CoreBluetooth
import Combine
import Foundation

/// Talks to the ALIGN ESP32 over BLE.
///
/// Runs in one of two modes:
/// * **live** — CoreBluetooth scan/connect/notify against `ALIGNProtocol`.
/// * **demo** — a timer generating plausible readings, so the whole app works
///   in the iOS Simulator (which has no Bluetooth) or without hardware nearby.
final class DeviceManager: NSObject, ObservableObject {

    enum ConnectionState: Equatable {
        case idle
        case bluetoothOff
        case unauthorized
        case scanning
        case connecting
        case connected
        case demo

        var isUsable: Bool { self == .connected || self == .demo }

        var label: String {
            switch self {
            case .idle:         return "Not connected"
            case .bluetoothOff: return "Bluetooth is off"
            case .unauthorized: return "Bluetooth permission needed"
            case .scanning:     return "Looking for ALIGN\u{2026}"
            case .connecting:   return "Connecting\u{2026}"
            case .connected:    return "Connected"
            case .demo:         return "Demo mode"
            }
        }
    }

    // MARK: Published

    @Published private(set) var state: ConnectionState = .idle
    /// Battery percentage reported by the device, 0...100.
    @Published private(set) var battery: Int?
    @Published private(set) var latest: DeviceReading?

    // MARK: Callbacks

    var onReading: ((DeviceReading) -> Void)?
    var onConnect: (() -> Void)?

    // MARK: Private

    private var central: CBCentralManager?
    private var peripheral: CBPeripheral?
    private var postureChar: CBCharacteristic?
    private var buzzChar: CBCharacteristic?
    private var commandChar: CBCharacteristic?

    private var demoTimer: Timer?
    private var demoTick: Double = 0
    private var pendingBuzz: BuzzInterval?

    /// True when no real device is driving the app.
    var isDemo: Bool { state == .demo }

    // MARK: - Lifecycle

    func start() {
        #if targetEnvironment(simulator)
        startDemo()
        #else
        guard central == nil else { return }
        central = CBCentralManager(delegate: self, queue: .main)
        #endif
    }

    func stop() {
        stopDemo()
        if let peripheral { central?.cancelPeripheralConnection(peripheral) }
        central?.stopScan()
        state = .idle
    }

    /// Manual retry from the Settings screen.
    func reconnect() {
        if isDemo { stopDemo() }
        peripheral = nil
        postureChar = nil
        buzzChar = nil
        commandChar = nil
        if central == nil {
            start()
        } else {
            beginScan()
        }
    }

    // MARK: - Commands

    func sendBuzzSetting(_ interval: BuzzInterval) {
        guard let peripheral, let buzzChar else {
            pendingBuzz = interval
            return
        }
        peripheral.writeValue(Data([interval.deviceValue]), for: buzzChar, type: .withResponse)
    }

    func send(_ command: ALIGNProtocol.Command) {
        guard let peripheral, let commandChar else { return }
        peripheral.writeValue(Data([command.rawValue]), for: commandChar, type: .withResponse)
    }

    // MARK: - Demo mode

    /// Generates readings that drift in and out of good posture.
    func startDemo() {
        guard demoTimer == nil else { return }
        state = .demo
        battery = 78
        demoTick = 0

        let timer = Timer(timeInterval: 0.5, repeats: true) { [weak self] _ in
            guard let self else { return }
            self.demoTick += 0.5
            let t = self.demoTick
            // Slow drift plus a faster wobble, so the gauge moves believably.
            let pitch = 12 + sin(t / 14) * 13 + sin(t / 2.3) * 2.5
            let roll = sin(t / 21) * 9 + cos(t / 3.1) * 1.5
            let reading = DeviceReading(pitch: pitch, roll: roll, battery: self.battery)
            self.latest = reading
            self.onReading?(reading)
        }
        RunLoop.main.add(timer, forMode: .common)
        demoTimer = timer
        onConnect?()
    }

    func stopDemo() {
        demoTimer?.invalidate()
        demoTimer = nil
        if state == .demo { state = .idle }
    }

    // MARK: - Helpers

    private func beginScan() {
        guard let central, central.state == .poweredOn else { return }
        state = .scanning
        central.scanForPeripherals(withServices: [ALIGNProtocol.service], options: nil)
    }

    private func handle(_ reading: DeviceReading) {
        latest = reading
        if let level = reading.battery { battery = level }
        onReading?(reading)
    }
}

// MARK: - CBCentralManagerDelegate

extension DeviceManager: CBCentralManagerDelegate {

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        switch central.state {
        case .poweredOn:
            beginScan()
        case .poweredOff:
            state = .bluetoothOff
        case .unauthorized:
            state = .unauthorized
        default:
            state = .idle
        }
    }

    func centralManager(_ central: CBCentralManager,
                        didDiscover peripheral: CBPeripheral,
                        advertisementData: [String: Any],
                        rssi RSSI: NSNumber) {
        central.stopScan()
        self.peripheral = peripheral
        peripheral.delegate = self
        state = .connecting
        central.connect(peripheral, options: nil)
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        state = .connected
        peripheral.discoverServices([ALIGNProtocol.service, ALIGNProtocol.batteryService])
    }

    func centralManager(_ central: CBCentralManager,
                        didFailToConnect peripheral: CBPeripheral,
                        error: Error?) {
        beginScan()
    }

    func centralManager(_ central: CBCentralManager,
                        didDisconnectPeripheral peripheral: CBPeripheral,
                        error: Error?) {
        postureChar = nil
        buzzChar = nil
        commandChar = nil
        beginScan()
    }
}

// MARK: - CBPeripheralDelegate

extension DeviceManager: CBPeripheralDelegate {

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        for service in peripheral.services ?? [] {
            if service.uuid == ALIGNProtocol.service {
                peripheral.discoverCharacteristics(
                    [ALIGNProtocol.postureCharacteristic,
                     ALIGNProtocol.buzzCharacteristic,
                     ALIGNProtocol.commandCharacteristic],
                    for: service
                )
            } else if service.uuid == ALIGNProtocol.batteryService {
                peripheral.discoverCharacteristics([ALIGNProtocol.batteryLevelCharacteristic], for: service)
            }
        }
    }

    func peripheral(_ peripheral: CBPeripheral,
                    didDiscoverCharacteristicsFor service: CBService,
                    error: Error?) {
        for characteristic in service.characteristics ?? [] {
            switch characteristic.uuid {
            case ALIGNProtocol.postureCharacteristic:
                postureChar = characteristic
                peripheral.setNotifyValue(true, for: characteristic)
            case ALIGNProtocol.batteryLevelCharacteristic:
                peripheral.setNotifyValue(true, for: characteristic)
                peripheral.readValue(for: characteristic)
            case ALIGNProtocol.buzzCharacteristic:
                buzzChar = characteristic
                if let pending = pendingBuzz {
                    pendingBuzz = nil
                    sendBuzzSetting(pending)
                }
            case ALIGNProtocol.commandCharacteristic:
                commandChar = characteristic
            default:
                break
            }
        }
        if postureChar != nil { onConnect?() }
    }

    func peripheral(_ peripheral: CBPeripheral,
                    didUpdateValueFor characteristic: CBCharacteristic,
                    error: Error?) {
        guard let data = characteristic.value else { return }

        switch characteristic.uuid {
        case ALIGNProtocol.postureCharacteristic:
            guard let reading = DeviceReading(packet: data) else { return }
            handle(reading)
        case ALIGNProtocol.batteryLevelCharacteristic:
            guard let first = data.first else { return }
            battery = Int(first)
        default:
            break
        }
    }
}
