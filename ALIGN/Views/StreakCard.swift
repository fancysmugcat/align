import SwiftUI

/// Mon...Sun wear circles plus the running streak count.
struct StreakCard: View {
    @EnvironmentObject private var posture: PostureStore

    private let labels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

    var body: some View {
        Card(title: "Streak") {
            HStack(spacing: 0) {
                ForEach(Array(week.enumerated()), id: \.offset) { index, day in
                    VStack(spacing: 6) {
                        Text(labels[index])
                            .font(.alignCaption(11))
                            .foregroundColor(Theme.green)
                        ZStack {
                            Circle()
                                .strokeBorder(Theme.green, lineWidth: 1.6)
                                .background(Circle().fill(day.worn ? Theme.greenSoft : Color.clear))
                                .frame(width: 24, height: 24)
                            if day.worn {
                                Image(systemName: "checkmark")
                                    .font(.system(size: 11, weight: .bold))
                                    .foregroundColor(Theme.green)
                            }
                        }
                        .opacity(isFuture(day) ? 0.35 : 1)
                    }
                    .frame(maxWidth: .infinity)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("\(labels[index]): \(day.worn ? "worn" : "not worn")")
                }
            }

            if posture.streak > 0 {
                Text("\(posture.streak) day\(posture.streak == 1 ? "" : "s") in a row \u{00B7} best \(posture.longestStreak)")
                    .font(.alignCaption(11))
                    .foregroundColor(Theme.green.opacity(0.8))
                    .padding(.top, 2)
            } else {
                Text("Wear ALIGN for \(Int(PostureStore.minimumWearMinutes)) minutes to start a streak.")
                    .font(.alignCaption(11))
                    .foregroundColor(Theme.green.opacity(0.7))
                    .padding(.top, 2)
            }
        }
    }

    private var week: [DaySummary] {
        let days = posture.currentWeek()
        guard days.count == 7 else {
            return (0..<7).map { _ in DaySummary(day: Date(), averageAngle: 0, sampleCount: 0, wornMinutes: 0) }
        }
        return days
    }

    private func isFuture(_ day: DaySummary) -> Bool {
        day.day > Calendar.current.startOfDay(for: Date())
    }
}
