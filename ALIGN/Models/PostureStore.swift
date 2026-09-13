import Foundation
import Combine

/// Owns calibration, the rolling sample history, and every derived statistic the
/// home screen shows (current angle, streak, progress chart, lean bias).
final class PostureStore: ObservableObject {

    // MARK: Tuning

    /// How often a reading is committed to history. Live UI still updates at the
    /// device's full rate; this only limits what we persist.
    static let sampleInterval: TimeInterval = 10
    /// A day counts toward the streak once the device has been worn this long.
    static let minimumWearMinutes: Double = 10
    /// History older than this is pruned on load.
    static let retentionDays: Int = 60

    // MARK: Published state

    /// Latest reading, updated live from the device.
    @Published private(set) var current: PostureSample?
    /// Persisted history, oldest first.
    @Published private(set) var samples: [PostureSample] = []
    /// Upright reference captured during calibration.
    @Published private(set) var calibration: Calibration?

    var isCalibrated: Bool { calibration != nil }

    /// Angle to display on the gauge. Zero until the first reading arrives.
    var currentAngle: Double { current?.angle ?? 0 }
    var currentZone: PostureZone { PostureZone(angle: currentAngle) }

    // MARK: Calibration

    struct Calibration: Codable, Equatable {
        var pitch: Double
        var roll: Double
        var date: Date
    }

    // MARK: Private

    private var lastCommitted: Date = .distantPast
    private var unsavedCount = 0
    private let calibrationKey = "align.calibration"

    private var historyURL: URL {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return docs.appendingPathComponent("align-history.json")
    }

    private var calendar: Calendar {
        var cal = Calendar.current
        cal.firstWeekday = 2 // Monday, matching the streak row in the design
        return cal
    }

    init() {
        loadCalibration()
        loadHistory()
    }

    // MARK: - Ingest

    /// Feeds a raw device reading through calibration and into history.
    func ingest(_ reading: DeviceReading) {
        guard let cal = calibration else { return }

        let pitchDelta = reading.pitch - cal.pitch
        let rollDelta = reading.roll - cal.roll
        // Total tilt away from upright, combining slouch (pitch) and lean (roll).
        let angle = (pitchDelta * pitchDelta + rollDelta * rollDelta).squareRoot()

        let sample = PostureSample(date: reading.timestamp, angle: angle, roll: rollDelta)
        current = sample

        if reading.timestamp.timeIntervalSince(lastCommitted) >= Self.sampleInterval {
            lastCommitted = reading.timestamp
            samples.append(sample)
            unsavedCount += 1
            if unsavedCount >= 30 { save() }
        }
    }

    /// Captures the user's upright posture as the baseline for every future reading.
    func calibrate(with reading: DeviceReading) {
        let cal = Calibration(pitch: reading.pitch, roll: reading.roll, date: Date())
        calibration = cal
        current = PostureSample(date: Date(), angle: 0, roll: 0)
        if let data = try? JSONEncoder().encode(cal) {
            UserDefaults.standard.set(data, forKey: calibrationKey)
        }
    }

    func clearCalibration() {
        calibration = nil
        current = nil
        UserDefaults.standard.removeObject(forKey: calibrationKey)
    }

    // MARK: - Derived: daily summaries

    /// One entry per day for the last `days` days, oldest first. Days with no
    /// data are included with zero samples so the chart keeps a real time axis.
    func dailySummaries(days: Int) -> [DaySummary] {
        let today = calendar.startOfDay(for: Date())
        guard let start = calendar.date(byAdding: .day, value: -(days - 1), to: today) else { return [] }

        var buckets: [Date: (sum: Double, count: Int)] = [:]
        for sample in samples where sample.date >= start {
            let day = calendar.startOfDay(for: sample.date)
            var bucket = buckets[day] ?? (0, 0)
            bucket.sum += sample.angle
            bucket.count += 1
            buckets[day] = bucket
        }

        return (0..<days).compactMap { offset in
            guard let day = calendar.date(byAdding: .day, value: offset, to: start) else { return nil }
            let bucket = buckets[day] ?? (0, 0)
            let average = bucket.count > 0 ? bucket.sum / Double(bucket.count) : 0
            let minutes = Double(bucket.count) * Self.sampleInterval / 60
            return DaySummary(day: day, averageAngle: average, sampleCount: bucket.count, wornMinutes: minutes)
        }
    }

    func summaries(for range: HistoryRange) -> [DaySummary] {
        dailySummaries(days: range.days)
    }

    /// Average deviation across the range, ignoring days with no wear.
    func averageAngle(for range: HistoryRange) -> Double? {
        let worn = summaries(for: range).filter(\.hasData)
        guard !worn.isEmpty else { return nil }
        return worn.map(\.averageAngle).reduce(0, +) / Double(worn.count)
    }

    /// Share of samples in the range that were good posture, 0...1.
    func goodShare(for range: HistoryRange) -> Double? {
        let cutoff = calendar.date(byAdding: .day, value: -range.days, to: Date()) ?? Date()
        let window = samples.filter { $0.date >= cutoff }
        guard !window.isEmpty else { return nil }
        return Double(window.filter { $0.zone.isGood }.count) / Double(window.count)
    }

    // MARK: - Derived: streak

    /// The seven days of the current week (Mon...Sun) with wear flags.
    func currentWeek() -> [DaySummary] {
        let today = calendar.startOfDay(for: Date())
        guard let weekStart = calendar.dateInterval(of: .weekOfYear, for: today)?.start else { return [] }
        let days = calendar.dateComponents([.day], from: weekStart, to: today).day ?? 0
        let all = dailySummaries(days: max(days + 1, 1) + 6)
        return (0..<7).compactMap { offset in
            guard let day = calendar.date(byAdding: .day, value: offset, to: weekStart) else { return nil }
            return all.first { calendar.isDate($0.day, inSameDayAs: day) }
                ?? DaySummary(day: day, averageAngle: 0, sampleCount: 0, wornMinutes: 0)
        }
    }

    /// Consecutive days worn, counting back from today. Today not yet worn does
    /// not break a streak that ran through yesterday.
    var streak: Int {
        let summaries = dailySummaries(days: Self.retentionDays).reversed()
        var count = 0
        var skippedToday = false
        for day in summaries {
            if day.worn {
                count += 1
            } else if !skippedToday && calendar.isDateInToday(day.day) {
                skippedToday = true // grace for the day still in progress
            } else {
                break
            }
        }
        return count
    }

    var longestStreak: Int {
        var best = 0, running = 0
        for day in dailySummaries(days: Self.retentionDays) {
            running = day.worn ? running + 1 : 0
            best = max(best, running)
        }
        return best
    }

    // MARK: - Derived: lean bias

    struct LeanBias {
        var leftShare: Double     // 0...1 of off-center samples
        var rightShare: Double
        var dominant: LeanSide
        var sampleCount: Int

        /// How lopsided the habit is, 0 (even) ... 1 (entirely one side).
        var imbalance: Double { abs(leftShare - rightShare) }
    }

    func leanBias(for range: HistoryRange) -> LeanBias {
        let cutoff = calendar.date(byAdding: .day, value: -range.days, to: Date()) ?? Date()
        let window = samples.filter { $0.date >= cutoff }
        let left = window.filter { $0.lean == .left }.count
        let right = window.filter { $0.lean == .right }.count
        let total = left + right

        guard total > 0 else {
            return LeanBias(leftShare: 0.5, rightShare: 0.5, dominant: .center, sampleCount: 0)
        }
        let leftShare = Double(left) / Double(total)
        let rightShare = 1 - leftShare
        let dominant: LeanSide
        if abs(leftShare - rightShare) < 0.06 {
            dominant = .center
        } else {
            dominant = leftShare > rightShare ? .left : .right
        }
        return LeanBias(leftShare: leftShare, rightShare: rightShare, dominant: dominant, sampleCount: total)
    }

    // MARK: - Persistence

    func save() {
        unsavedCount = 0
        let snapshot = samples
        let url = historyURL
        DispatchQueue.global(qos: .utility).async {
            guard let data = try? JSONEncoder().encode(snapshot) else { return }
            try? data.write(to: url, options: .atomic)
        }
    }

    private func loadCalibration() {
        guard let data = UserDefaults.standard.data(forKey: calibrationKey),
              let cal = try? JSONDecoder().decode(Calibration.self, from: data) else { return }
        calibration = cal
    }

    private func loadHistory() {
        guard let data = try? Data(contentsOf: historyURL),
              let stored = try? JSONDecoder().decode([PostureSample].self, from: data) else { return }
        let cutoff = calendar.date(byAdding: .day, value: -Self.retentionDays, to: Date()) ?? .distantPast
        samples = stored.filter { $0.date >= cutoff }.sorted { $0.date < $1.date }
    }

    /// Wipes history and calibration. Used by Settings.
    func resetAll() {
        samples = []
        current = nil
        clearCalibration()
        try? FileManager.default.removeItem(at: historyURL)
    }

    // MARK: - Demo data

    /// Fills the history with plausible data so the charts can be reviewed
    /// without a device. Only reachable from Settings.
    func loadSampleData() {
        var generated: [PostureSample] = []
        let today = calendar.startOfDay(for: Date())

        for dayOffset in stride(from: 34, through: 0, by: -1) {
            guard let day = calendar.date(byAdding: .day, value: -dayOffset, to: today) else { continue }
            // A couple of skipped days so the streak logic is visible.
            if dayOffset == 12 || dayOffset == 19 { continue }

            let drift = Double((dayOffset % 7)) * 1.4
            let base = 9 + drift + sin(Double(dayOffset) / 3) * 4
            let sideBias: Double = dayOffset % 5 == 0 ? -1 : 1

            for minute in stride(from: 0, to: 8 * 60, by: 2) {
                guard let stamp = calendar.date(byAdding: .minute, value: 9 * 60 + minute, to: day) else { continue }
                if stamp > Date() { continue }
                let wobble = sin(Double(minute) / 17) * 6 + cos(Double(minute) / 5) * 3
                let angle = max(0.5, base + wobble)
                let roll = sideBias * (abs(wobble) * 0.6 + 2)
                generated.append(PostureSample(date: stamp, angle: angle, roll: roll))
            }
        }

        samples = generated.sorted { $0.date < $1.date }
        if calibration == nil {
            calibration = Calibration(pitch: 0, roll: 0, date: today)
        }
        current = samples.last
        save()
    }
}
