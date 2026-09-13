import SwiftUI

/// Posture history over 1 week / 2 weeks / 1 month.
struct ProgressCard: View {
    @EnvironmentObject private var posture: PostureStore
    @Binding var range: HistoryRange

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text("Progress")
                    .font(.alignTitle(17))
                    .foregroundColor(Theme.green)
                Spacer()
            }

            Menu {
                ForEach(HistoryRange.allCases) { option in
                    Button {
                        range = option
                    } label: {
                        if option == range {
                            Label(option.rawValue, systemImage: "checkmark")
                        } else {
                            Text(option.rawValue)
                        }
                    }
                }
            } label: {
                HStack(spacing: 4) {
                    Text(range.rawValue)
                    Image(systemName: "chevron.down").font(.system(size: 8, weight: .bold))
                }
                .font(.alignCaption(11))
                .foregroundColor(Theme.green.opacity(0.85))
            }
            .padding(.top, -6)

            AngleLineChart(days: posture.summaries(for: range))
                .padding(.top, 6)

            summary
                .padding(.top, 2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 4)
    }

    @ViewBuilder
    private var summary: some View {
        if let average = posture.averageAngle(for: range) {
            let good = posture.goodShare(for: range) ?? 0
            HStack(spacing: 16) {
                stat(value: String(format: "%.0f\u{00B0}", average), label: "avg angle")
                stat(value: "\(Int((good * 100).rounded()))%", label: "good posture")
                stat(value: "\(posture.summaries(for: range).filter(\.worn).count)", label: "days worn")
                Spacer()
            }
        } else {
            Text("No data for this period yet.")
                .font(.alignCaption(11))
                .foregroundColor(Color(hex: 0x8A8A8A))
        }
    }

    private func stat(value: String, label: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(value)
                .font(.alignTitle(15))
                .foregroundColor(Theme.green)
            Text(label)
                .font(.alignCaption(10))
                .foregroundColor(Color(hex: 0x8A8A8A))
        }
    }
}
