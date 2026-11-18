// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "LocalBridge",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "LocalBridgeCore", targets: ["LocalBridgeCore"]),
        .executable(name: "LocalBridge", targets: ["LocalBridge"]),
    ],
    dependencies: [
        .package(url: "https://github.com/sparkle-project/Sparkle.git", exact: "2.10.1"),
    ],
    targets: [
        .target(name: "LocalBridgeCore"),
        .executableTarget(
            name: "LocalBridge",
            dependencies: ["LocalBridgeCore", .product(name: "Sparkle", package: "Sparkle")],
            linkerSettings: [.unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks"])]
        ),
        .testTarget(name: "LocalBridgeCoreTests", dependencies: ["LocalBridgeCore"]),
    ]
)
