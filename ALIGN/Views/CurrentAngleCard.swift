import SwiftUI

/// Live angle gauge with a good/bad verdict.
struct CurrentAngleCard: View {
    @EnvironmentObject private var posture: PostureStore
    @EnvironmentObject private var device: DeviceManager

    private var angle: Double { posture.currentAngle }
    private var zone: PostureZone { posture.currentZone }
    private var isLive: Bool { posture.isCalibrated && device.state.isUsable && posture.current != nil }

    var body: some View {
        Card(title: "Current Angle") {
            ZStack {
                VStack(spacing: 0) {
                    PostureArc(angle: isLive ? angle : 0,
                               zone: isLive ? zone : .good,
                               showKnob: isLive)
                        .frame(height: 92)
                        .opacity(isLive ? 1 : 0.35)
                    SilhouetteView()
                        .frame(width: 74, height: 74)
                        .offset(y: -6)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.top, 12)

            HStack(spacing: 8) {
                Circle()
                    .fill(isLive ? zone.color : Theme.track)
                    .frame(width: 9, height: 9)
                VStack(alignment: .leading, spacing: 1) {
                    Text(isLive ? zone.verdict : placeholderTitle)
                        .font(.alignTitle(15))
                        .foregroundColor(Theme.green)
                    Text(isLive ? zone.advice : placeholderDetail)
                        .font(.alignCaption(11))
                        .foregroundColor(Color(hex: 0x6E6E6E))
                }
                Spacer()
            }
            .padding(.top, 2)
        }
    }

    private var placeholderTitle: String {
        posture.isCalibrated ? "Waiting for ALIGN" : "Not calibrated"
    }

    private var placeholderDetail: String {
        posture.isCalibrated ? device.state.label : "Calibrate to start tracking your angle."
    }
}
