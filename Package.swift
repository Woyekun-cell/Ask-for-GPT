// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "AskGPT",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "AskGPT", targets: ["AskGPT"]),
               .executable(name: "AskGPTTranslate", targets: ["AskGPTTranslate"]),
               .library(name: "AskGPTCore", targets: ["AskGPTCore"])],
    targets: [
        .target(name: "AskGPTCore"),
        .executableTarget(name: "AskGPT", dependencies: ["AskGPTCore"]),
        .executableTarget(name: "AskGPTTranslate", dependencies: ["AskGPTCore"]),
        .testTarget(name: "AskGPTCoreTests", dependencies: ["AskGPTCore"])
    ],
    swiftLanguageModes: [.v5]
)
