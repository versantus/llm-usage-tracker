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

/// Decoder configured for the server's snake_case payloads.
func makeDecoder() -> JSONDecoder {
    let d = JSONDecoder()
    d.keyDecodingStrategy = .convertFromSnakeCase
    return d
}
