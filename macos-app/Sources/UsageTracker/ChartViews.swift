import SwiftUI
import Charts

/// A metric the user can switch a chart between.
enum Metric: String, CaseIterable, Identifiable {
    case co2 = "CO₂"
    case tokens = "Tokens"
    case energy = "Energy"
    var id: String { rawValue }
}

/// Donut pie of token share by model (top slices + "other"), with a legend.
struct ModelPieChart: View {
    let models: [ModelRow]

    private struct Slice: Identifiable {
        let id = UUID()
        let name: String
        let tokens: Double
        let colorIndex: Int
    }

    private var slices: [Slice] {
        let sorted = models.sorted { $0.tokens > $1.tokens }
        let top = sorted.prefix(6)
        var out = top.enumerated().map { Slice(name: Fmt.shortModel($0.element.model), tokens: $0.element.tokens, colorIndex: $0.offset) }
        let rest = sorted.dropFirst(6).reduce(0) { $0 + $1.tokens }
        if rest > 0 { out.append(Slice(name: "other", tokens: rest, colorIndex: 6)) }
        return out
    }

    var body: some View {
        let data = slices
        let total = max(1, data.reduce(0) { $0 + $1.tokens })
        if data.isEmpty {
            Text("No data").foregroundStyle(Theme.muted).frame(maxWidth: .infinity, minHeight: 160)
        } else {
            HStack(alignment: .center, spacing: 16) {
                Chart(data) { s in
                    SectorMark(angle: .value("Tokens", s.tokens), innerRadius: .ratio(0.6), angularInset: 1.5)
                        .foregroundStyle(Theme.color(s.colorIndex))
                        .cornerRadius(3)
                }
                .frame(width: 170, height: 170)

                VStack(alignment: .leading, spacing: 5) {
                    ForEach(data) { s in
                        HStack(spacing: 7) {
                            RoundedRectangle(cornerRadius: 2).fill(Theme.color(s.colorIndex)).frame(width: 9, height: 9)
                            Text(s.name).lineLimit(1)
                            Spacer(minLength: 8)
                            Text("\(Int((s.tokens / total * 100).rounded()))%")
                                .foregroundStyle(Theme.muted).monospacedDigit()
                        }
                        .font(.caption)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}

/// Bar chart of one metric over time, with a metric picker.
struct MetricTimelineChart: View {
    let points: [UserOverTimeRow]
    @State private var metric: Metric = .co2

    private func value(_ p: UserOverTimeRow) -> Double {
        switch metric {
        case .co2: return p.co2Grams
        case .tokens: return p.tokens
        case .energy: return p.energyWh
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Over time").font(.headline)
                Spacer()
                Picker("", selection: $metric) {
                    ForEach(Metric.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented).fixedSize()
            }
            if points.isEmpty {
                Text("No data in this range").font(.callout).foregroundStyle(Theme.muted)
                    .frame(maxWidth: .infinity, minHeight: 140)
            } else {
                Chart(points) { p in
                    BarMark(
                        x: .value("Day", Fmt.bucket(p.day)),
                        y: .value(metric.rawValue, value(p))
                    )
                    .foregroundStyle(Theme.accent.gradient)
                }
                .frame(height: 180)
            }
        }
    }
}
