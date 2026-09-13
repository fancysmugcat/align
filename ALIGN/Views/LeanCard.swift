import SwiftUI

/// Which side the user drifts toward most often.
struct LeanCard: View {
    @EnvironmentObject private var posture: PostureStore
    var range: HistoryRange

    private var bias: PostureStore.LeanBias { posture.leanBias(for: range) }

    var body: some View {
        Card(title: "Left or Right?", subtitle: subtitle) {
            LeanArc(bias: bias)
                .frame(height: 74)
                .padding(.top, 6)

            if bias.sampleCount > 0 {
                HStack {
                    Text("Left \(percent(bias.leftShare))")
                    Spacer()
                    Text("Right \(percent(bias.rightShare))")
                }
                .font(.alignCaption(11))
                .foregroundColor(Color(hex: 0x6E6E6E))
                .padding(.top, 2)
            }
        }
    }

    private var subtitle: String {
        guard bias.sampleCount > 0 else {
            return "Not enough data yet."
        }
        switch bias.dominant {
        case .left:   return "You are leaning more towards the left."
        case .right:  return "You are leaning more towards the right."
        case .center: return "You are leaning evenly on both sides."
        }
    }

    private func percent(_ value: Double) -> String {
        "\(Int((value * 100).rounded()))%"
    }
}
