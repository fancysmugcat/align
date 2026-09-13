import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var settings: SettingsStore
    @EnvironmentObject private var device: DeviceManager
    @EnvironmentObject private var posture: PostureStore
    @Environment(\.presentationMode) private var presentationMode

    @Binding var showCalibration: Bool
    @State private var confirmReset = false

    /// The five battery marks shown in the design.
    private let batterySteps = [0, 25, 50, 75, 100]

    var body: some View {
        NavigationView {
            ZStack {
                Theme.background.ignoresSafeArea()

                ScrollView(showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 14) {
                        Text("Settings")
                            .font(.alignTitle(19))
                            .foregroundColor(Theme.green)
                            .padding(.leading, 4)

                        batteryCard
                        buzzCard
                        deviceCard
                        issuesSection
                        dataSection
                    }
                    .padding(.horizontal, Theme.gutter)
                    .padding(.bottom, 32)
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Text("ALIGN")
                        .font(.system(size: 20, weight: .heavy, design: .rounded))
                        .kerning(1.5)
                        .foregroundColor(Theme.green)
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Done") { presentationMode.wrappedValue.dismiss() }
                        .foregroundColor(Theme.green)
                }
            }
        }
        .navigationViewStyle(.stack)
    }

    // MARK: Battery

    private var batteryCard: some View {
        Card(title: "Battery") {
            SegmentedPill(
                options: batterySteps,
                label: { "\($0)%" },
                selection: nearestBatteryStep,
                onSelect: nil,
                trackColor: .white,
                knobColor: batteryColor
            )
            .padding(.top, 2)

            HStack(spacing: 6) {
                Image(systemName: batteryIcon)
                    .font(.system(size: 12, weight: .semibold))
                Text(batteryDetail)
                    .font(.alignCaption(11))
            }
            .foregroundColor(Color(hex: 0x6E6E6E))
        }
    }

    /// Nil until the device reports a level, so nothing is highlighted.
    private var nearestBatteryStep: Int? {
        guard let level = device.battery else { return nil }
        return batterySteps.min(by: { abs($0 - level) < abs($1 - level) })
    }

    private var batteryColor: Color {
        guard let level = device.battery else { return Theme.track }
        return level <= 20 ? Theme.zoneBad : Theme.greenSoft
    }

    private var batteryIcon: String {
        guard let level = device.battery else { return "battery.0" }
        switch level {
        case ..<15:  return "battery.0"
        case ..<40:  return "battery.25"
        case ..<70:  return "battery.50"
        case ..<90:  return "battery.75"
        default:     return "battery.100"
        }
    }

    private var batteryDetail: String {
        guard let level = device.battery else { return "Connect ALIGN to read its battery." }
        return "ALIGN is at \(level)%."
    }

    // MARK: Buzz

    private var buzzCard: some View {
        Card(title: "Buzz Adjustment") {
            SegmentedPill(
                options: BuzzInterval.allCases,
                label: { $0.label },
                selection: settings.buzzInterval,
                onSelect: { settings.buzzInterval = $0 },
                trackColor: Theme.track,
                knobColor: .white,
                selectedTextColor: Color(hex: 0x4A4A4A),
                textColor: Color(hex: 0xF2F2F2)
            )
            .padding(.top, 2)

            Text(buzzDetail)
                .font(.alignCaption(11))
                .foregroundColor(Color(hex: 0x6E6E6E))
        }
    }

    private var buzzDetail: String {
        switch settings.buzzInterval {
        case .off:
            return "ALIGN will not buzz when your posture slips."
        default:
            return "ALIGN buzzes for \(settings.buzzInterval.rawValue) second\(settings.buzzInterval.rawValue == 1 ? "" : "s") when you slouch past your upright angle."
        }
    }

    // MARK: Device

    private var deviceCard: some View {
        Card(title: "Device") {
            row(label: "Status", value: device.state.label, valueColor: device.state.isUsable ? Theme.green : Theme.zoneBad)
            Divider().background(Theme.hairline)
            row(label: "Calibration", value: calibrationDetail, valueColor: posture.isCalibrated ? Theme.green : Theme.zoneBad)

            HStack(spacing: 10) {
                Button {
                    presentationMode.wrappedValue.dismiss()
                    // Let the sheet finish dismissing before presenting the next one.
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                        showCalibration = true
                    }
                } label: {
                    Text("Recalibrate")
                        .font(.alignBody(13))
                        .foregroundColor(.white)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .background(Capsule().fill(Theme.green))
                }

                Button {
                    device.reconnect()
                } label: {
                    Text("Reconnect")
                        .font(.alignBody(13))
                        .foregroundColor(Theme.green)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .background(Capsule().stroke(Theme.green, lineWidth: 1.4))
                }
            }
            .buttonStyle(.plain)
            .padding(.top, 4)
        }
    }

    private var calibrationDetail: String {
        guard let cal = posture.calibration else { return "Not calibrated" }
        let formatter = DateFormatter()
        formatter.dateFormat = "MMM d, h:mm a"
        return formatter.string(from: cal.date)
    }

    private func row(label: String, value: String, valueColor: Color) -> some View {
        HStack {
            Text(label)
                .font(.alignBody(13))
                .foregroundColor(Color(hex: 0x5E5E5E))
            Spacer()
            Text(value)
                .font(.alignBody(13))
                .foregroundColor(valueColor)
        }
    }

    // MARK: Issues

    private var issuesSection: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text("Any Issues?")
                .font(.alignTitle(17))
                .foregroundColor(Theme.green)
            Text("Feel free to send the team any comments!")
                .font(.alignBody(13))
                .foregroundColor(Theme.green.opacity(0.85))
            Link("Google form link", destination: settings.feedbackURL)
                .font(.alignBody(13))
                .foregroundColor(Theme.green)
                .underline()
        }
        .padding(.horizontal, 4)
        .padding(.top, 6)
    }

    // MARK: Data

    private var dataSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Data")
                .font(.alignTitle(17))
                .foregroundColor(Theme.green)

            Button("Load demo data") { posture.loadSampleData() }
                .font(.alignBody(13))
                .foregroundColor(Theme.green)

            Button("Erase history and calibration") { confirmReset = true }
                .font(.alignBody(13))
                .foregroundColor(Theme.zoneBad)
                .alert(isPresented: $confirmReset) {
                    Alert(
                        title: Text("Erase all ALIGN data?"),
                        message: Text("This deletes your posture history and your upright baseline."),
                        primaryButton: .destructive(Text("Erase")) { posture.resetAll() },
                        secondaryButton: .cancel()
                    )
                }
        }
        .padding(.horizontal, 4)
        .padding(.top, 6)
    }
}
