import SwiftUI

// MARK: - Card

/// The rounded grey panel every section on the home screen sits in.
struct Card<Content: View>: View {
    var title: String?
    var subtitle: String?
    var padded: Bool = true
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let title {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.alignTitle(17))
                        .foregroundColor(Theme.green)
                    if let subtitle {
                        Text(subtitle)
                            .font(.alignCaption(10))
                            .foregroundColor(Theme.green.opacity(0.75))
                    }
                }
            }
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(padded ? Theme.cardPadding : 0)
        .background(
            RoundedRectangle(cornerRadius: Theme.corner, style: .continuous)
                .fill(Theme.card)
        )
    }
}

// MARK: - Segmented pill

/// The capsule selector used for Battery and Buzz Adjustment in Settings.
struct SegmentedPill<Value: Hashable>: View {
    let options: [Value]
    let label: (Value) -> String
    var selection: Value?
    /// Read-only pills (Battery) pass nil so nothing is tappable.
    var onSelect: ((Value) -> Void)?
    var trackColor: Color = Color.white
    var knobColor: Color = Theme.greenSoft
    var selectedTextColor: Color = Theme.green
    var textColor: Color = Color(hex: 0x6E6E6E)

    var body: some View {
        GeometryReader { geo in
            let slot = geo.size.width / CGFloat(max(options.count, 1))
            ZStack(alignment: .leading) {
                Capsule().fill(trackColor)

                if let index = selectedIndex {
                    Capsule()
                        .fill(knobColor)
                        .frame(width: slot)
                        .offset(x: slot * CGFloat(index))
                        .animation(.spring(response: 0.32, dampingFraction: 0.82), value: index)
                }

                HStack(spacing: 0) {
                    ForEach(options, id: \.self) { option in
                        Text(label(option))
                            .font(.alignBody(13))
                            .foregroundColor(option == selection ? selectedTextColor : textColor)
                            .frame(width: slot, height: geo.size.height)
                            .contentShape(Rectangle())
                            .onTapGesture { onSelect?(option) }
                            .accessibilityAddTraits(traits(for: option))
                    }
                }
            }
        }
        .frame(height: 40)
    }

    private var selectedIndex: Int? {
        guard let selection else { return nil }
        return options.firstIndex(of: selection)
    }

    private func traits(for option: Value) -> AccessibilityTraits {
        var traits = AccessibilityTraits()
        if onSelect != nil { traits.formUnion(.isButton) }
        if option == selection { traits.formUnion(.isSelected) }
        return traits
    }
}

// MARK: - Posture arc gauge

/// The inverted-U gauge over the silhouette. `angle` is degrees away from the
/// calibrated upright posture; the knob travels left as it grows.
struct PostureArc: View {
    var angle: Double
    var zone: PostureZone
    /// Degrees at which the knob reaches the end of its travel.
    var maxAngle: Double = 45
    var lineWidth: CGFloat = 18
    var showKnob: Bool = true

    private var progress: Double { min(max(angle / maxAngle, 0), 1) }
    /// Knob position in SwiftUI arc degrees: 270 is straight up, 180 is left.
    private var knobDegrees: Double { 270 - 80 * progress }

    var body: some View {
        GeometryReader { geo in
            let rect = CGRect(origin: .zero, size: geo.size)
            let radius = min(rect.width / 2, rect.height) - lineWidth / 2
            let center = CGPoint(x: rect.midX, y: rect.maxY)

            ZStack {
                // Full track, tinted by the current zone.
                arc(center: center, radius: radius, from: 180, to: 360)
                    .stroke(zone.color.opacity(0.32), style: .init(lineWidth: lineWidth, lineCap: .round))

                // Travelled portion, from the top toward the knob.
                if progress > 0.02 {
                    arc(center: center, radius: radius, from: knobDegrees, to: 270)
                        .stroke(zone.color, style: .init(lineWidth: lineWidth, lineCap: .round))
                }

                if showKnob {
                    let point = pointOn(center: center, radius: radius, degrees: knobDegrees)
                    Circle()
                        .fill(Color.white)
                        .overlay(Circle().stroke(zone.color, lineWidth: 2.5))
                        .frame(width: lineWidth + 12, height: lineWidth + 12)
                        .position(point)

                    Text("\(Int(angle.rounded()))\u{00B0}")
                        .font(.alignBody(13))
                        .foregroundColor(Color(hex: 0x4A4A4A))
                        .position(x: point.x, y: max(point.y - lineWidth - 12, 10))
                }
            }
            .animation(.easeOut(duration: 0.35), value: progress)
        }
    }

    private func arc(center: CGPoint, radius: CGFloat, from: Double, to: Double) -> Path {
        Path { path in
            path.addArc(center: center,
                        radius: radius,
                        startAngle: .degrees(from),
                        endAngle: .degrees(to),
                        clockwise: false)
        }
    }

    private func pointOn(center: CGPoint, radius: CGFloat, degrees: Double) -> CGPoint {
        let radians = degrees * .pi / 180
        return CGPoint(x: center.x + radius * cos(radians),
                       y: center.y + radius * sin(radians))
    }
}

/// The grey seated figure the gauge arcs over.
struct SilhouetteView: View {
    var color: Color = Theme.silhouette

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width
            let headSize = w * 0.42
            VStack(spacing: w * 0.06) {
                Circle()
                    .fill(color)
                    .frame(width: headSize, height: headSize)
                RoundedRectangle(cornerRadius: w * 0.14, style: .continuous)
                    .fill(color)
                    .frame(width: w, height: geo.size.height - headSize - w * 0.06)
            }
            .frame(width: w)
        }
    }
}

// MARK: - Lean arc

/// The wide split arc in the "Left or Right?" card.
struct LeanArc: View {
    var bias: PostureStore.LeanBias

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width
            let h = geo.size.height
            let radius = min(w / 2, h * 1.4)
            let center = CGPoint(x: w / 2, y: -radius + h)
            let lineWidth = h * 0.62

            ZStack {
                half(center: center, radius: radius, from: 180, to: 270)
                    .stroke(color(for: .left), style: .init(lineWidth: lineWidth, lineCap: .butt))
                half(center: center, radius: radius, from: 270, to: 360)
                    .stroke(color(for: .right), style: .init(lineWidth: lineWidth, lineCap: .butt))

                HStack(spacing: 0) {
                    Text("Left")
                        .frame(maxWidth: .infinity)
                        .foregroundColor(textColor(for: .left))
                    Text("Right")
                        .frame(maxWidth: .infinity)
                        .foregroundColor(textColor(for: .right))
                }
                .font(.alignTitle(17))
                .offset(y: h * 0.12)
            }
        }
    }

    private func half(center: CGPoint, radius: CGFloat, from: Double, to: Double) -> Path {
        Path { path in
            path.addArc(center: center,
                        radius: radius,
                        startAngle: .degrees(from),
                        endAngle: .degrees(to),
                        clockwise: false)
        }
    }

    private func color(for side: LeanSide) -> Color {
        guard bias.sampleCount > 0 else { return Theme.track.opacity(0.5) }
        return bias.dominant == side ? Theme.greenSoft : Theme.track.opacity(0.75)
    }

    private func textColor(for side: LeanSide) -> Color {
        guard bias.sampleCount > 0 else { return Color(hex: 0x7A7A7A) }
        return bias.dominant == side ? Theme.green : Color(hex: 0x6E6E6E)
    }
}

// MARK: - Progress line chart

/// Lightweight line chart drawn with `Path`, so the app runs on iOS 15+ and
/// doesn't depend on the Charts framework.
struct AngleLineChart: View {
    var days: [DaySummary]
    /// Top of the y axis, in degrees.
    var maxAngle: Double = 40

    private let bands: [PostureZone] = [.bad, .poor, .fair, .good]
    private let axisWidth: CGFloat = 62

    var body: some View {
        VStack(spacing: 6) {
            HStack(spacing: 8) {
                GeometryReader { geo in
                    ZStack {
                        gridLines(in: geo.size)
                        if points(in: geo.size).count >= 2 {
                            linePath(in: geo.size)
                                .stroke(Theme.green,
                                        style: .init(lineWidth: 2, lineCap: .round, lineJoin: .round))
                        }
                        ForEach(Array(points(in: geo.size).enumerated()), id: \.offset) { _, point in
                            Circle()
                                .fill(Theme.green)
                                .frame(width: 6, height: 6)
                                .position(point)
                        }
                    }
                }
                .frame(height: 96)

                VStack(alignment: .leading, spacing: 0) {
                    ForEach(bands, id: \.self) { band in
                        Text(band.bandLabel)
                            .font(.alignCaption(10))
                            .foregroundColor(Color(hex: 0x6E6E6E))
                            .frame(maxHeight: .infinity, alignment: .center)
                    }
                }
                .frame(width: axisWidth, height: 96, alignment: .leading)
            }

            HStack {
                ForEach(Array(xLabels().enumerated()), id: \.offset) { index, label in
                    Text(label)
                        .font(.alignCaption(10))
                        .foregroundColor(Color(hex: 0x6E6E6E))
                        .frame(maxWidth: .infinity, alignment: index == 0 ? .leading : (index == xLabels().count - 1 ? .trailing : .center))
                }
            }
            .padding(.trailing, axisWidth + 8)
        }
    }

    // MARK: Geometry

    private func points(in size: CGSize) -> [CGPoint] {
        guard days.count > 1 else { return [] }
        let stepX = size.width / CGFloat(days.count - 1)
        return days.enumerated().compactMap { index, day in
            guard day.hasData else { return nil }
            let clamped = min(day.averageAngle, maxAngle)
            let y = size.height - (CGFloat(clamped / maxAngle) * size.height)
            return CGPoint(x: CGFloat(index) * stepX, y: y)
        }
    }

    private func linePath(in size: CGSize) -> Path {
        let pts = points(in: size)
        return Path { path in
            guard let first = pts.first else { return }
            path.move(to: first)
            for point in pts.dropFirst() { path.addLine(to: point) }
        }
    }

    private func gridLines(in size: CGSize) -> some View {
        let rows = bands.count
        return ForEach(0...rows, id: \.self) { index in
            Rectangle()
                .fill(Theme.hairline)
                .frame(height: 1)
                .position(x: size.width / 2,
                          y: size.height * CGFloat(index) / CGFloat(rows))
        }
    }

    private func xLabels() -> [String] {
        guard let first = days.first?.day, let last = days.last?.day else { return [] }
        let formatter = DateFormatter()
        if days.count > 20 {
            formatter.dateFormat = "MMM"
            let names = Set(days.map { formatter.string(from: $0.day).uppercased() })
            if names.count > 1 {
                // Straddles a month boundary — label the months, as in the design.
                var seen: [String] = []
                for day in days {
                    let name = formatter.string(from: day.day).uppercased()
                    if !seen.contains(name) { seen.append(name) }
                }
                return seen
            }
        }
        formatter.dateFormat = days.count <= 7 ? "EEE" : "MMM d"
        let middle = days[days.count / 2].day
        return [formatter.string(from: first), formatter.string(from: middle), formatter.string(from: last)]
    }
}
