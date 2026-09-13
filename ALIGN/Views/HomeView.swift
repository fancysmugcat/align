import SwiftUI

struct HomeView: View {
    @EnvironmentObject private var posture: PostureStore
    @EnvironmentObject private var device: DeviceManager

    @Binding var showCalibration: Bool
    @State private var range: HistoryRange = .week

    var body: some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: 14) {
                if !posture.isCalibrated {
                    CalibrationBanner { showCalibration = true }
                } else if !device.state.isUsable {
                    ConnectionBanner(state: device.state) { device.reconnect() }
                }

                StreakCard()
                CurrentAngleCard()
                ProgressCard(range: $range)
                LeanCard(range: range)
            }
            .padding(.horizontal, Theme.gutter)
            .padding(.top, 4)
            .padding(.bottom, 28)
        }
    }
}

/// Shown until the user has recorded an upright baseline.
struct CalibrationBanner: View {
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: "figure.stand")
                    .font(.system(size: 20, weight: .semibold))
                VStack(alignment: .leading, spacing: 2) {
                    Text("Calibrate ALIGN")
                        .font(.alignTitle(15))
                    Text("Sit upright once so we know your baseline.")
                        .font(.alignCaption(11))
                        .opacity(0.85)
                }
                Spacer()
                Image(systemName: "chevron.right").font(.system(size: 13, weight: .bold))
            }
            .foregroundColor(.white)
            .padding(16)
            .background(
                RoundedRectangle(cornerRadius: Theme.corner, style: .continuous)
                    .fill(Theme.green)
            )
        }
        .buttonStyle(.plain)
    }
}

/// Shown when the device isn't currently sending readings.
struct ConnectionBanner: View {
    var state: DeviceManager.ConnectionState
    var retry: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "antenna.radiowaves.left.and.right.slash")
                .font(.system(size: 15, weight: .semibold))
            Text(state.label)
                .font(.alignBody(13))
            Spacer()
            Button("Retry", action: retry)
                .font(.alignBody(13))
        }
        .foregroundColor(Theme.green)
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(
            RoundedRectangle(cornerRadius: Theme.corner, style: .continuous)
                .fill(Theme.greenPale.opacity(0.6))
        )
    }
}
