import SwiftUI

struct RootView: View {
    @EnvironmentObject private var posture: PostureStore
    @EnvironmentObject private var device: DeviceManager

    @State private var showSettings = false
    @State private var showCalibration = false

    var body: some View {
        NavigationView {
            ZStack {
                Theme.background.ignoresSafeArea()
                HomeView(showCalibration: $showCalibration)
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Text("ALIGN")
                        .font(.system(size: 22, weight: .heavy, design: .rounded))
                        .kerning(1.5)
                        .foregroundColor(Theme.green)
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button {
                        showSettings = true
                    } label: {
                        Image(systemName: "gearshape.fill")
                            .font(.system(size: 19, weight: .semibold))
                            .foregroundColor(.black)
                    }
                    .accessibilityLabel("Settings")
                }
            }
            .sheet(isPresented: $showSettings) {
                SettingsView(showCalibration: $showCalibration)
            }
            .sheet(isPresented: $showCalibration) {
                CalibrationView()
            }
        }
        .navigationViewStyle(.stack)
        .accentColor(Theme.green)
        .onAppear {
            // First launch with a device attached: go straight to calibration.
            if !posture.isCalibrated && device.state.isUsable {
                showCalibration = true
            }
        }
    }
}

struct RootView_Previews: PreviewProvider {
    static var previews: some View {
        let posture = PostureStore()
        posture.loadSampleData()
        let device = DeviceManager()
        device.startDemo()
        return RootView()
            .environmentObject(posture)
            .environmentObject(device)
            .environmentObject(SettingsStore())
    }
}
