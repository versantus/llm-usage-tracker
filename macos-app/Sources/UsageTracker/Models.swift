import Foundation

// JSON shapes returned by the server API. Keys are snake_case on the wire;
// we decode with `.convertFromSnakeCase` so `energy_wh` -> `energyWh` etc.

struct Totals: Decodable {
    var sessions: Int = 0
    var users: Int = 0
    var tokens: Double = 0
    var energyWh: Double = 0
    var co2Grams: Double = 0
}

struct UserRow: Decodable, Identifiable {
    var userId: String
    var name: String
    var email: String
    var sessions: Int
    var tokens: Double
    var energyWh: Double
    var co2Grams: Double

    var id: String { userId }
}

struct ProviderRow: Decodable, Identifiable {
    var provider: String
    var sessions: Int
    var tokens: Double
    var co2Grams: Double

    var id: String { provider }
}

struct Summary: Decodable {
    var totals: Totals
    var byUser: [UserRow]
    var byProvider: [ProviderRow]
}

struct ModelRow: Decodable, Identifiable {
    var model: String
    var sessions: Int
    var tokens: Double
    var energyWh: Double
    var co2Grams: Double
    var carbonApprox: Int

    var id: String { model }
    var isApprox: Bool { carbonApprox != 0 }
}

struct OverTimeRow: Decodable {
    var day: String
    var user: String
    var tokens: Double
    var co2Grams: Double
}

// --- per-user drill-down (/api/by-user/:id) ---

struct AppDeviceRow: Decodable, Identifiable {
    var surface: String
    var deviceName: String
    var sessions: Int
    var tokens: Double
    var energyWh: Double
    var co2Grams: Double

    var id: String { "\(surface)|\(deviceName)" }
    /// "codex-cli · macOS" (device omitted when blank)
    var label: String { deviceName.isEmpty ? surface : "\(surface) · \(deviceName)" }
}

struct SessionRow: Decodable, Identifiable {
    var sessionId: String
    var provider: String
    var surface: String
    var deviceName: String
    var primaryModel: String
    var cwd: String
    var totalTokens: Double
    var energyWh: Double
    var co2Grams: Double
    var startedAt: String
    var updatedAt: String

    var id: String { sessionId }
}

struct UserIdentity: Decodable {
    var userId: String
    var name: String
    var email: String
    var firstSeen: String?
    var lastSeen: String?
}

struct UserOverTimeRow: Decodable, Identifiable {
    var day: String
    var tokens: Double
    var co2Grams: Double
    var energyWh: Double

    var id: String { day }
}

struct UserDetail: Decodable {
    var user: UserIdentity?
    var models: [ModelRow]
    var appDevice: [AppDeviceRow]
    var overTime: [UserOverTimeRow]
    var sessions: [SessionRow]
}

/// Decoder configured for the server's snake_case payloads.
func makeDecoder() -> JSONDecoder {
    let d = JSONDecoder()
    d.keyDecodingStrategy = .convertFromSnakeCase
    return d
}
