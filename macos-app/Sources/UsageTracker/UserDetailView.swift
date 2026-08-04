import SwiftUI
import Charts

/// Drill-down for one user, pushed in-window from the Users table. Mirrors the
/// main dashboard — same cards, equivalents and charts — filtered to the user,
/// plus their app×device split and recent sessions.
struct UserDetailView: View {
    let userId: String
    let name: String

    @EnvironmentObject var store: DataStore
    @EnvironmentObject var settings: AppSettings

    @State private var detail: UserDetail?
    @State private var error: String?
    @State private var loading = true
    @AppStorage("timeChartBy") private var timeBy = "user" // shared with the dashboard toggle

    var body: some View {
        Group {
            // Full-screen spinner only on FIRST load; range changes overlay the
            // small header spinner instead of blanking the previous data.
            if loading, detail == nil {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let error {
                Label(error, systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.orange).padding().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let d = detail {
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        header(d)
                        cards(d)
                        equivalents(d)
                        charts(d)
                        breakdowns(d)
                        appDevice(d)
                        recentSessions(d)
                    }
                    .padding(20)
                }
            }
        }
        .frame(minWidth: 820, minHeight: 560)
        .background(Theme.panelBg)
        .preferredColorScheme(.dark)
        .navigationTitle(name)
        .task(id: settings.rangeDays) { await load() }
    }

    // MARK: header + cards (mirror DashboardView)

    private func header(_ d: UserDetail) -> some View {
        HStack {
            Image(systemName: "person.fill").foregroundStyle(Theme.accent)
            VStack(alignment: .leading, spacing: 2) {
                Text(d.user?.name ?? name).font(.title2).bold()
                if let email = d.user?.email { Text(email).font(.callout).foregroundStyle(Theme.muted) }
            }
            Spacer()
            if loading { ProgressView().controlSize(.small) }
            Text(Fmt.rangeLabel(settings.rangeDays)).font(.caption).foregroundStyle(Theme.muted)
        }
    }

    /// Per-user totals — summed from the app×device rollup (covers every session once).
    private func totals(_ d: UserDetail) -> (sessions: Int, tokens: Double, energy: Double, co2: Double) {
        d.appDevice.reduce((0, 0.0, 0.0, 0.0)) {
            ($0.0 + $1.sessions, $0.1 + $1.tokens, $0.2 + $1.energyWh, $0.3 + $1.co2Grams)
        }
    }

    private func cards(_ d: UserDetail) -> some View {
        let t = totals(d)
        return LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: 4), spacing: 12) {
            card("Total CO₂", Fmt.co2(t.co2), "estimated emissions", Theme.palette[0])
            card("Energy", Fmt.energy(t.energy), "compute energy", Theme.palette[1])
            card("Water", Fmt.water(Fmt.waterLitres(t.energy)), "cooling + generation ~", Theme.palette[2])
            card("Tokens", Fmt.tokens(t.tokens), "\(Fmt.int(Double(t.sessions))) sessions", Theme.palette[3])
        }
    }

    private func card(_ label: String, _ value: String, _ sub: String, _ color: Color) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label.uppercased()).font(.caption2).foregroundStyle(Theme.muted)
            Text(value).font(.system(.title2, design: .rounded)).bold().foregroundStyle(color)
                .lineLimit(1).minimumScaleFactor(0.5)
            Text(sub).font(.caption2).foregroundStyle(Theme.muted).lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Theme.cardBg, in: RoundedRectangle(cornerRadius: 10))
    }

    @ViewBuilder private func equivalents(_ d: UserDetail) -> some View {
        let t = totals(d)
        if t.co2 > 0 || t.energy > 0 {
            (Text("Roughly equivalent to  ").foregroundStyle(Theme.muted)
             + Text("🚗 \(Fmt.num(Fmt.milesDriven(co2Grams: t.co2))) miles  ·  ")
             + Text("📱 \(Fmt.num(Fmt.phoneCharges(energyWh: t.energy))) phone charges  ·  ")
             + Text("🫖 \(Fmt.num(Fmt.cupsOfTea(energyWh: t.energy))) cups of tea  ·  ")
             + Text("💧 \(Fmt.num(Fmt.waterBottles(energyWh: t.energy))) bottles of water"))
                .font(.callout)
        }
    }

    // MARK: charts (mirror DashboardView, filtered to this user)

    private func charts(_ d: UserDetail) -> some View {
        HStack(alignment: .top, spacing: 16) {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text("Over time").font(.headline)
                    Spacer()
                    Picker("", selection: $timeBy) {
                        Text("total").tag("user")
                        Text("by work type").tag("category")
                    }
                    .pickerStyle(.segmented).fixedSize()
                }
                if timeBy == "category" {
                    CategoryTimelineChart(points: d.categoriesOverTime ?? [])
                } else {
                    MetricTimelineChart(points: d.overTime)
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, minHeight: 260, alignment: .topLeading)
            .background(Theme.cardBg, in: RoundedRectangle(cornerRadius: 10))

            panel("Tokens by model") { ModelBarChart(models: d.models) }
        }
    }

    private func breakdowns(_ d: UserDetail) -> some View {
        HStack(alignment: .top, spacing: 16) {
            panel("Model favourites (by tokens)") { ModelPieChart(models: d.models) }
            panel("Work types") { CategoryBarChart(categories: d.categories ?? []) }
        }
    }

    // MARK: user-specific sections

    private func appDevice(_ d: UserDetail) -> some View {
        panel("By app & device") {
            if d.appDevice.isEmpty {
                empty
            } else {
                ForEach(d.appDevice) { row in
                    statRow(row.label, sessions: row.sessions, tokens: row.tokens, co2: row.co2Grams)
                }
            }
        }
    }

    private func recentSessions(_ d: UserDetail) -> some View {
        panel("Recent sessions") {
            if d.sessions.isEmpty {
                empty
            } else {
                ForEach(d.sessions.prefix(25)) { s in sessionRow(s) }
            }
        }
    }

    private func panel<C: View>(_ title: String, @ViewBuilder _ body: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.headline)
            body()
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .background(Theme.cardBg, in: RoundedRectangle(cornerRadius: 10))
    }

    private func statRow(_ label: String, sessions: Int, tokens: Double, co2: Double) -> some View {
        HStack {
            Text(label).lineLimit(1)
            Spacer()
            Text("\(sessions) sess").foregroundStyle(Theme.muted).monospacedDigit().frame(width: 80, alignment: .trailing)
            Text(Fmt.tokens(tokens)).monospacedDigit().frame(width: 80, alignment: .trailing)
            Text(Fmt.co2(co2)).foregroundStyle(Theme.accent).monospacedDigit().frame(width: 90, alignment: .trailing)
        }
        .font(.callout)
    }

    private func sessionRow(_ s: SessionRow) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 1) {
                Text("\(s.surface) · \(Fmt.shortModel(s.primaryModel))").lineLimit(1)
                Text(shortDate(s.startedAt) + (s.cwd.isEmpty ? "" : " · " + (s.cwd as NSString).lastPathComponent))
                    .font(.caption2).foregroundStyle(Theme.muted).lineLimit(1)
            }
            if let cat = s.category, cat != "unknown" {
                Text(cat)
                    .font(.caption2)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(Theme.categoryColor(cat).opacity(0.18), in: Capsule())
                    .foregroundStyle(Theme.categoryColor(cat))
            }
            Spacer()
            Text(Fmt.tokens(s.totalTokens)).monospacedDigit().frame(width: 80, alignment: .trailing)
            Text(Fmt.co2(s.co2Grams)).foregroundStyle(Theme.accent).monospacedDigit().frame(width: 90, alignment: .trailing)
        }
        .font(.callout)
    }

    private var empty: some View {
        Text("No data in this range").font(.callout).foregroundStyle(Theme.muted)
    }

    private func shortDate(_ iso: String) -> String {
        // 2026-06-17T09:00:00Z -> 2026-06-17 09:00
        guard iso.count >= 16 else { return iso }
        return String(iso.prefix(10)) + " " + iso[iso.index(iso.startIndex, offsetBy: 11)..<iso.index(iso.startIndex, offsetBy: 16)]
    }

    private func load() async {
        loading = true
        error = nil
        switch await store.userDetail(userId) {
        case .success(let d): detail = d
        case .failure(let e): error = e.message
        }
        loading = false
    }
}
