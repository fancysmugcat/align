import SwiftUI

// MARK: - Posture zone

/// How far the user has deviated from their calibrated upright angle.
enum PostureZone: String, Codable, CaseIterable {
    case good   // 0 - 10 degrees
    case fair   // 11 - 20
    case poor   // 21 - 30
    case bad    // 30+

    init(angle: Double) {
        switch angle {
        case ..<10.5:  self = .good
        case ..<20.5:  self = .fair
        case ..<30.5:  self = .poor
        default:       self = .bad
        }
    }

    var color: Color {
        switch self {
        case .good: return Theme.zoneGood
        case .fair: return Theme.zoneFair
        case .poor: return Theme.zonePoor
        case .bad:  return Theme.zoneBad
        }
    }

    /// Headline verdict shown under the gauge.
    var verdict: String {
        switch self {
        case .good: return "Good posture"
        case .fair: return "Slightly off"
        case .poor: return "Bad posture"
        case .bad:  return "Bad posture"
        }
    }

    var advice: String {
        switch self {
        case .good: return "You're aligned — keep it up."
        case .fair: return "You're drifting a little. Ease back upright."
        case .poor: return "You're slouching. Straighten your back."
        case .bad:  return "Sit up — you're well past your upright angle."
        }
    }

    var isGood: Bool { self == .good }

    /// Band label used on the progress chart's right-hand axis.
    var bandLabel: String {
        switch self {
        case .good: return "0 - 10\u{00B0}"
        case .fair: return "11 - 20\u{00B0}"
        case .poor: return "21 - 30\u{00B0}"
        case .bad:  return "30\u{00B0} Above"
        }
    }
}

// MARK: - Lean

enum LeanSide: String, Codable {
    case left, right, center

    var label: String {
        switch self {
        case .left:   return "Left"
        case .right:  return "Right"
        case .center: return "Centered"
        }
    }
}

// MARK: - Samples

/// One recorded posture reading. Stored roughly every 10 seconds while worn.
struct PostureSample: Codable, Identifiable, Equatable {
    var id: UUID = UUID()
    var date: Date
    /// Total tilt away from the calibrated upright angle, in degrees.
    var angle: Double
    /// Signed side-to-side tilt. Negative = left, positive = right.
    var roll: Double

    var zone: PostureZone { PostureZone(angle: angle) }

    var lean: LeanSide {
        if roll <= -PostureSample.leanThreshold { return .left }
        if roll >= PostureSample.leanThreshold { return .right }
        return .center
    }

    /// Below this many degrees of roll we consider the user centered.
    static let leanThreshold: Double = 4
}

/// One day's worth of samples, rolled up for the progress chart and streak row.
struct DaySummary: Identifiable, Equatable {
    var id: Date { day }
    let day: Date
    let averageAngle: Double
    let sampleCount: Int
    /// Minutes of wear, approximated from the sample cadence.
    let wornMinutes: Double

    var worn: Bool { wornMinutes >= PostureStore.minimumWearMinutes }
    var hasData: Bool { sampleCount > 0 }
}

// MARK: - Ranges

enum HistoryRange: String, CaseIterable, Identifiable {
    case week = "Past 1 Week"
    case twoWeeks = "Past 2 Weeks"
    case month = "Past 1 Month"

    var id: String { rawValue }

    var days: Int {
        switch self {
        case .week:     return 7
        case .twoWeeks: return 14
        case .month:    return 30
        }
    }

    var shortLabel: String {
        switch self {
        case .week:     return "1W"
        case .twoWeeks: return "2W"
        case .month:    return "1M"
        }
    }
}

// MARK: - Buzz

/// Haptic feedback the ALIGN device gives when posture goes bad.
enum BuzzInterval: Int, CaseIterable, Identifiable, Codable {
    case off = 0
    case one = 1
    case two = 2
    case five = 5

    var id: Int { rawValue }

    var label: String { self == .off ? "OFF" : "\(rawValue)s" }

    /// Byte written to the device's buzz characteristic.
    var deviceValue: UInt8 { UInt8(rawValue) }
}
