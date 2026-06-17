// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "UsageTracker",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "UsageTracker",
            path: "Sources/UsageTracker"
        )
    ]
)
