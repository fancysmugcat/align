import SwiftUI

@main
struct ALIGNApp: App {
    @StateObject private var device = DeviceManager()
    @StateObject private var posture = PostureStore()
    @StateObject private var settings = SettingsStore()

    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(device)
                .environmentObject(posture)
                .environmentObject(settings)
                .onAppear { wireUp() }
                .onChange(of: scenePhase) { phase in
                    if phase != .active { posture.save() }
                }
        }
    }

    /// Connects the three stores together: readings flow device -> posture store,
    /// and buzz-setting changes flow settings -> device.
    private func wireUp() {
        let device = self.device
        let posture = self.posture
        let settings = self.settings

        device.onReading = { [weak posture] reading in
            posture?.ingest(reading)
        }
        device.onConnect = { [weak device, weak settings] in
            guard let device, let settings else { return }
            device.sendBuzzSetting(settings.buzzInterval)
        }
        settings.onBuzzChange = { [weak device] interval in
            device?.sendBuzzSetting(interval)
        }
        device.start()
    }
}
