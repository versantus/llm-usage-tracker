import Foundation
import Security

/// Connection settings: server URL + dashboard Basic-Auth credentials.
/// URL and username live in UserDefaults; the password lives in the Keychain.
@MainActor
final class AppSettings: ObservableObject {
    @Published var serverURL: String {
        didSet { defaults.set(serverURL, forKey: Keys.serverURL) }
    }
    @Published var dashUser: String {
        didSet { defaults.set(dashUser, forKey: Keys.dashUser) }
    }
    /// Persisted to the Keychain on change.
    @Published var dashPass: String {
        didSet { Keychain.set(dashPass, account: Keys.dashPass) }
    }
    /// Selected range in days; 0 = all time. Mirrors the web dashboard options.
    @Published var rangeDays: Double {
        didSet { defaults.set(rangeDays, forKey: Keys.rangeDays) }
    }

    // --- Identity for the Claude Code reporting hook (written to config.json) ---
    @Published var userName: String {
        didSet { defaults.set(userName, forKey: Keys.userName) }
    }
    @Published var userEmail: String {
        didSet { defaults.set(userEmail, forKey: Keys.userEmail) }
    }
    /// Shared ingest token (x-ingest-token). Kept in the Keychain.
    @Published var ingestToken: String {
        didSet { Keychain.set(ingestToken, account: Keys.ingestToken) }
    }

    private let defaults = UserDefaults.standard

    private enum Keys {
        static let serverURL = "serverURL"
        static let dashUser = "dashUser"
        static let dashPass = "dashPass"
        static let rangeDays = "rangeDays"
        static let userName = "userName"
        static let userEmail = "userEmail"
        static let ingestToken = "ingestToken"
    }

    init() {
        serverURL = defaults.string(forKey: Keys.serverURL) ?? "http://localhost:4317"
        dashUser = defaults.string(forKey: Keys.dashUser) ?? ""
        dashPass = Keychain.get(account: Keys.dashPass) ?? ""
        // default range: last 7 days
        rangeDays = defaults.object(forKey: Keys.rangeDays) != nil
            ? defaults.double(forKey: Keys.rangeDays) : 7
        userName = defaults.string(forKey: Keys.userName) ?? NSFullUserName()
        userEmail = defaults.string(forKey: Keys.userEmail) ?? ""
        ingestToken = Keychain.get(account: Keys.ingestToken) ?? ""
    }

    /// Normalised base URL (no trailing slash).
    var baseURL: String {
        var s = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        while s.hasSuffix("/") { s.removeLast() }
        return s
    }

    var isConfigured: Bool { !baseURL.isEmpty }

    /// Basic-Auth header value, or nil when no password is set.
    var authHeader: String? {
        guard !dashPass.isEmpty else { return nil }
        let creds = "\(dashUser):\(dashPass)"
        guard let data = creds.data(using: .utf8) else { return nil }
        return "Basic " + data.base64EncodedString()
    }
}

/// Minimal generic-password Keychain wrapper.
enum Keychain {
    private static let service = "uk.co.versantus.usage-tracker"

    static func set(_ value: String, account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        SecItemDelete(query as CFDictionary)
        guard !value.isEmpty, let data = value.data(using: .utf8) else { return }
        var add = query
        add[kSecValueData as String] = data
        SecItemAdd(add as CFDictionary, nil)
    }

    static func get(account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let str = String(data: data, encoding: .utf8) else { return nil }
        return str
    }
}
