import SwiftUI

/// Connection settings: server URL + dashboard Basic-Auth credentials, with a
/// "Test connection" button that hits /api/summary.
struct SettingsView: View {
    @EnvironmentObject var settings: AppSettings
    @EnvironmentObject var store: DataStore
    @StateObject private var connector = ClaudeConnector()

    @State private var testing = false
    @State private var testResult: TestResult?

    enum TestResult: Equatable {
        case ok(String), fail(String)
    }

    var body: some View {
        Form {
            Section("Server") {
                TextField("Server URL", text: $settings.serverURL,
                          prompt: Text("https://your-server.example.com"))
                    .textFieldStyle(.roundedBorder)
                Text("The same URL the tracker reports to (or http://localhost:4317 if you run the server locally).")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Section("Dashboard authentication") {
                TextField("Username", text: $settings.dashUser,
                          prompt: Text("(blank if the server has no LUT_DASH_USER)"))
                    .textFieldStyle(.roundedBorder)
                SecureField("Password", text: $settings.dashPass,
                            prompt: Text("LUT_DASH_PASS"))
                    .textFieldStyle(.roundedBorder)
                Text("Stored in your macOS Keychain. Leave blank only if the server runs with LUT_ALLOW_NO_AUTH=1.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Section {
                HStack {
                    Button {
                        Task { await runTest() }
                    } label: {
                        if testing { ProgressView().controlSize(.small) }
                        else { Text("Test connection") }
                    }
                    .disabled(testing || settings.baseURL.isEmpty)

                    Button("Apply & reconnect") {
                        store.reconnect()
                        testResult = nil
                    }

                    Spacer()
                }
                if let r = testResult {
                    switch r {
                    case .ok(let m):
                        Label(m, systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                    case .fail(let m):
                        Label(m, systemImage: "xmark.octagon.fill").foregroundStyle(.red)
                    }
                }
            }

            claudeSection
        }
        .formStyle(.grouped)
        .frame(width: 460)
        .padding()
    }

    /// One-click reporting setup: writes config + wires the Claude Code Stop
    /// hook by installing and running the bundled `lut` binary.
    private var claudeSection: some View {
        Section("Claude Code integration") {
            HStack {
                Image(systemName: connector.connected ? "checkmark.seal.fill" : "seal")
                    .foregroundStyle(connector.connected ? .green : .secondary)
                Text(connector.connected ? "Reporting is connected" : "Not reporting yet")
                    .font(.callout)
                Spacer()
            }

            TextField("Your name", text: $settings.userName)
                .textFieldStyle(.roundedBorder)
            TextField("Your work email", text: $settings.userEmail,
                      prompt: Text("you@example.com"))
                .textFieldStyle(.roundedBorder)
            SecureField("Ingest token", text: $settings.ingestToken,
                        prompt: Text("LUT_INGEST_TOKEN (blank if none)"))
                .textFieldStyle(.roundedBorder)
            Text("Installs a tiny helper to ~/.local/bin/lut and adds a Stop hook to ~/.claude/settings.json. Your email identifies you in reports.")
                .font(.caption).foregroundStyle(.secondary)

            HStack {
                Button {
                    connector.connect(name: settings.userName, email: settings.userEmail,
                                      serverURL: settings.baseURL, ingestToken: settings.ingestToken)
                } label: {
                    if connector.busy { ProgressView().controlSize(.small) }
                    else { Text(connector.connected ? "Reconnect / update" : "Connect Claude Code") }
                }
                .disabled(connector.busy || settings.userEmail.isEmpty || settings.baseURL.isEmpty)

                if connector.connected {
                    Button("Disconnect") { connector.disconnect() }
                        .disabled(connector.busy)
                }
                Spacer()
            }

            let watchers = connector.surfaces.filter(\.available)
            if !watchers.isEmpty {
                Divider()
                Text("These tools have no hook, so a small background watcher reports their sessions.")
                    .font(.caption).foregroundStyle(.secondary)
                ForEach(watchers) { s in
                    Toggle("Also track \(s.label)", isOn: Binding(
                        get: { s.enabled },
                        set: { connector.setWatcher(s.id, $0) }
                    ))
                    .disabled(connector.busy)
                }
            }

            if let m = connector.lastMessage {
                Text(m).font(.caption)
                    .foregroundStyle(m.hasPrefix("Failed") ? .red : .green)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .onAppear { connector.refreshState() }
    }

    private func runTest() async {
        testing = true
        testResult = nil
        store.reconnect() // pick up edited values before testing
        let result = await store.test()
        switch result {
        case .success(let m): testResult = .ok(m)
        case .failure(let e): testResult = .fail(e.message)
        }
        testing = false
    }
}
