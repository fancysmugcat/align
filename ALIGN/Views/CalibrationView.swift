import SwiftUI

/// Records the user's upright posture, which every later reading is measured against.
struct CalibrationView: View {
    @EnvironmentObject private var device: DeviceManager
    @EnvironmentObject private var posture: PostureStore
    @Environment(\.presentationMode) private var presentationMode

    private enum Phase: Equatable {
        case intro
        case counting(Int)
        case measuring
        case done
    }

    /// Seconds of readings averaged into the baseline.
    private static let measureSeconds = 3.0

    @State private var phase: Phase = .intro
    @State private var samples: [DeviceReading] = []
    @State private var timer: Timer?

    var body: some View {
        NavigationView {
            ZStack {
                Theme.background.ignoresSafeArea()

                VStack(spacing: 22) {
                    Spacer(minLength: 8)

                    ZStack {
                        Circle()
                            .fill(Theme.greenPale.opacity(0.55))
                            .frame(width: 190, height: 190)
                        VStack(spacing: 4) {
                            PostureArc(angle: 0, zone: .good, lineWidth: 14, showKnob: false)
                                .frame(width: 130, height: 62)
                            SilhouetteView()
                                .frame(width: 60, height: 60)
                        }
                        .offset(y: 10)

                        if case .counting(let value) = phase {
                            Text("\(value)")
                                .font(.system(size: 68, weight: .heavy, design: .rounded))
                                .foregroundColor(Theme.green)
                        }
                        if phase == .done {
                            Image(systemName: "checkmark.circle.fill")
                                .font(.system(size: 62, weight: .bold))
                                .foregroundColor(Theme.green)
                        }
                    }

                    VStack(spacing: 8) {
                        Text(title)
                            .font(.alignTitle(21))
                            .foregroundColor(Theme.green)
                        Text(detail)
                            .font(.alignBody(14))
                            .foregroundColor(Color(hex: 0x5E5E5E))
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 32)
                    }

                    Spacer()

                    Button(action: primaryAction) {
                        Text(buttonTitle)
                            .font(.alignTitle(16))
                            .foregroundColor(.white)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 15)
                            .background(
                                Capsule().fill(canStart ? Theme.green : Theme.track)
                            )
                    }
                    .disabled(!canStart)
                    .padding(.horizontal, 28)

                    if !device.state.isUsable {
                        Text(device.state.label)
                            .font(.alignCaption(11))
                            .foregroundColor(Theme.zoneBad)
                    }

                    Spacer(minLength: 12)
                }
            }
            .navigationTitle("Calibration")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Close") { dismiss() }
                        .foregroundColor(Theme.green)
                }
            }
        }
        .navigationViewStyle(.stack)
        .onDisappear { timer?.invalidate() }
    }

    // MARK: Copy

    private var title: String {
        switch phase {
        case .intro:    return "Sit up straight"
        case .counting: return "Hold still"
        case .measuring: return "Measuring\u{2026}"
        case .done:     return "You're calibrated"
        }
    }

    private var detail: String {
        switch phase {
        case .intro:
            return "Wear ALIGN, sit or stand in your best upright posture, then start. This becomes the baseline for your back."
        case .counting:
            return "Keep your back in its upright position."
        case .measuring:
            return "Averaging your upright angle."
        case .done:
            return "Every angle from now on is measured against this posture. Recalibrate any time from Settings."
        }
    }

    private var buttonTitle: String {
        switch phase {
        case .intro:    return "Start Calibration"
        case .counting, .measuring: return "Measuring\u{2026}"
        case .done:     return "Done"
        }
    }

    private var canStart: Bool {
        switch phase {
        case .intro: return device.state.isUsable
        case .done:  return true
        default:     return false
        }
    }

    // MARK: Actions

    private func primaryAction() {
        switch phase {
        case .intro: beginCountdown()
        case .done:  dismiss()
        default:     break
        }
    }

    private func beginCountdown() {
        samples = []
        phase = .counting(3)
        var remaining = 3
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { t in
            remaining -= 1
            if remaining > 0 {
                phase = .counting(remaining)
            } else {
                t.invalidate()
                measure()
            }
        }
    }

    private func measure() {
        phase = .measuring
        samples = []
        var elapsed = 0.0
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { t in
            elapsed += 0.2
            if let reading = device.latest { samples.append(reading) }
            guard elapsed >= Self.measureSeconds else { return }
            t.invalidate()
            finish()
        }
    }

    private func finish() {
        guard !samples.isEmpty else {
            phase = .intro
            return
        }
        let pitch = samples.map(\.pitch).reduce(0, +) / Double(samples.count)
        let roll = samples.map(\.roll).reduce(0, +) / Double(samples.count)
        posture.calibrate(with: DeviceReading(pitch: pitch, roll: roll, battery: device.battery))
        device.send(.calibrate)
        device.send(.testBuzz)
        phase = .done
    }

    private func dismiss() {
        timer?.invalidate()
        presentationMode.wrappedValue.dismiss()
    }
}
