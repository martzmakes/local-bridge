// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "LocalBridge",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "LocalBridgeCore", targets: ["LocalBridgeCore"]),
        .executable(name: "LocalBridge", targets: ["LocalBridge"]),
    ],
    targets: [
        .target(name: "LocalBridgeCore"),
        .executableTarget(name: "LocalBridge", dependencies: ["LocalBridgeCore"]),
        .testTarget(name: "LocalBridgeCoreTests", dependencies: ["LocalBridgeCore"]),
    ]
)
