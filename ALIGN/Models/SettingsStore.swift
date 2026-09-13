import Foundation

/// User preferences, persisted in UserDefaults.
final class SettingsStore: ObservableObject {

    /// Called whenever the buzz setting changes so it can be pushed to the device.
    var onBuzzChange: ((BuzzInterval) -> Void)?

    @Published var buzzInterval: BuzzInterval {
        didSet {
            guard buzzInterval != oldValue else { return }
            UserDefaults.standard.set(buzzInterval.rawValue, forKey: Keys.buzz)
            onBuzzChange?(buzzInterval)
        }
    }

    /// Where the "Any Issues?" link points.
    @Published var feedbackURL: URL

    private enum Keys {
        static let buzz = "align.buzzInterval"
        static let feedback = "align.feedbackURL"
    }

    static let defaultFeedbackURL = URL(string: "https://forms.gle/")!

    init() {
        let stored = UserDefaults.standard.object(forKey: Keys.buzz) as? Int
        buzzInterval = stored.flatMap(BuzzInterval.init(rawValue:)) ?? .two

        if let raw = UserDefaults.standard.string(forKey: Keys.feedback), let url = URL(string: raw) {
            feedbackURL = url
        } else {
            feedbackURL = Self.defaultFeedbackURL
        }
    }
}
