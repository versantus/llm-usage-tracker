import Foundation

// Direct ports of the formatting + equivalence helpers in
// shared/carbon-calculator.ts and server/public/dashboard.js, so the desktop
// app shows identical numbers to the web dashboard.

enum Fmt {
    // Equivalence factors (mirror of the shared calculator).
    static let mpg = 22.4
    static let gallonsPerKgCO2 = 1.0 / 8.887
    static let milesPerKgCO2 = mpg * gallonsPerKgCO2
    static let waterLPerKWh = 1.8 // on-site cooling + off-site generation
    static let phoneChargeWh = 12.0
    static let kettleCupWh = 32.0
    static let waterBottleL = 0.5

    static func waterLitres(_ energyWh: Double) -> Double {
        (energyWh / 1000) * waterLPerKWh
    }

    static func int(_ n: Double) -> String {
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.maximumFractionDigits = 0
        return f.string(from: NSNumber(value: n.rounded())) ?? "0"
    }

    static func tokens(_ n: Double) -> String {
        if n >= 1e9 { return String(format: "%.2fB", n / 1e9) }
        if n >= 1e6 { return String(format: "%.2fM", n / 1e6) }
        if n >= 1e3 { return String(format: "%.1fk", n / 1e3) }
        return String(Int(n.rounded()))
    }

    static func co2(_ g: Double) -> String {
        if g >= 1000 { return String(format: "%.2f kg", g / 1000) }
        return String(format: "%.1f g", g)
    }

    static func energy(_ wh: Double) -> String {
        if wh >= 1000 { return String(format: "%.2f kWh", wh / 1000) }
        return String(format: "%.1f Wh", wh)
    }

    static func water(_ l: Double) -> String {
        let ml = l * 1000
        if ml < 1 { return "< 1 mL" }
        if l < 1 { return "\(Int(ml.rounded())) mL" }
        if l < 1000 { return String(format: "%.2f L", l) }
        return String(format: "%.2f m³", l / 1000)
    }

    /// "Roughly equivalent to" numbers — small values keep a decimal.
    static func num(_ n: Double) -> String {
        if n >= 100 { return int(n) }
        if n >= 10 { return String(format: "%.0f", n) }
        return String(format: "%.1f", n)
    }

    static func milesDriven(co2Grams: Double) -> Double { (co2Grams / 1000) * milesPerKgCO2 }
    static func phoneCharges(energyWh: Double) -> Double { energyWh / phoneChargeWh }
    static func cupsOfTea(energyWh: Double) -> Double { energyWh / kettleCupWh }
    static func waterBottles(energyWh: Double) -> Double { waterLitres(energyWh) / waterBottleL }

    /// Short model label: drop the leading "claude-" and trailing date.
    static func shortModel(_ id: String) -> String {
        var s = id
        if s.hasPrefix("claude-") { s.removeFirst("claude-".count) }
        // strip trailing -YYYYMMDD
        if let r = s.range(of: "-[0-9]{8}$", options: .regularExpression) {
            s.removeSubrange(r)
        }
        return s
    }

    /// Time-series bucket key -> short axis label. Hourly keys carry a 'T'.
    static func bucket(_ key: String) -> String {
        if key.contains("T") {
            // 'YYYY-MM-DDTHH:00' -> 'HH:00'
            return String(key.suffix(5))
        }
        // 'YYYY-MM-DD' -> 'MM-DD'
        return String(key.suffix(5))
    }

    static func rangeLabel(_ d: Double) -> String {
        if d == 0 { return "all time" }
        if d < 1 { return "last \(Int((d * 24).rounded())) hours" }
        if d == 1 { return "last 24 hours" }
        return "last \(Int(d)) days"
    }
}
