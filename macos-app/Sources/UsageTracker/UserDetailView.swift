import SwiftUI

/// Drill-down for one user: their usage split by app/device and by model, plus
/// recent sessions. Opened from the Users table on the dashboard.
struct UserDetailView: View {
    let userId: String
    let name: String

    @EnvironmentObject var store: DataStore
    @EnvironmentObject var settings: AppSettings
    @Environment(\.dismiss) private var dismiss

    @State private var detail: UserDetail?
    @State private var error: String?
    @State private var loading = true

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            content
        }
        .frame(width: 640, height: 560)
        .background(Theme.panelBg)
        .preferredColorScheme(.dark)
        .task(id: settings.rangeDays) { await load() }
    }

    private var header: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(detail?.user?.name ?? name).font(.title2).bold()
                if let email = detail?.user?.email { Text(email).font(.callout).foregroundStyle(Theme.muted) }
            }
            Spacer()
            Text(Fmt.rangeLabel(settings.rangeDays)).font(.caption).foregroundStyle(Theme.muted)
            Button("Done") { dismiss() }
        }
        .padding(16)
    }

    @ViewBuilder private var content: some View {
        if loading {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let error {
            Label(error, systemImage: "exclamationmark.triangle")
                .foregroundStyle(.orange).padding().frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let d = detail {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    panel { MetricTimelineChart(points: d.overTime) }

                    HStack(alignment: .top, spacing: 16) {
                        section("By app & device") {
                            if d.appDevice.isEmpty { empty } else {
                                ForEach(d.appDevice) { row in
                                    statRow(row.label, sessions: row.sessions, tokens: row.tokens, co2: row.co2Grams)
                                }
                            }
                        }
                        section("Model favourites") {
                            ModelPieChart(models: d.models)
                        }
                    }

                    section("By model") {
                        if d.models.isEmpty { empty } else {
                            ForEach(d.models) { m in
                                statRow(Fmt.shortModel(m.model) + (m.isApprox ? " ~" : ""),
                                        sessions: m.sessions, tokens: m.tokens, co2: m.co2Grams)
                            }
                        }
                    }
                    section("Recent sessions") {
                        if d.sessions.isEmpty { empty } else {
                            ForEach(d.sessions.prefix(25)) { s in sessionRow(s) }
                        }
                    }
                }
                .padding(16)
            }
        }
    }

    private func panel<C: View>(@ViewBuilder _ body: () -> C) -> some View {
        body()
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .background(Theme.cardBg, in: RoundedRectangle(cornerRadius: 10))
    }

    private func section<C: View>(_ title: String, @ViewBuilder _ body: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.headline)
            body()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
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
