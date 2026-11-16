// Draws Resources/AppIcon.icns: a rounded tile, blue to indigo, with a white arch bridge.
// Run from macapp/: swift scripts/make-icon.swift
import AppKit

let iconset = URL(fileURLWithPath: "build/AppIcon.iconset")
try? FileManager.default.removeItem(at: iconset)
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)

/// Everything is laid out on a 1024 grid and scaled.
func render(_ pixels: Int) -> Data {
    let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4,
        hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    let context = NSGraphicsContext(bitmapImageRep: rep)!
    NSGraphicsContext.current = context
    context.cgContext.scaleBy(x: CGFloat(pixels) / 1024, y: CGFloat(pixels) / 1024)

    // The tile, with the soft shadow Mac icons sit on.
    let tileRect = NSRect(x: 100, y: 100, width: 824, height: 824)
    let tile = NSBezierPath(roundedRect: tileRect, xRadius: 186, yRadius: 186)
    NSGraphicsContext.saveGraphicsState()
    let shadow = NSShadow()
    shadow.shadowColor = NSColor.black.withAlphaComponent(0.28)
    shadow.shadowBlurRadius = 24
    shadow.shadowOffset = NSSize(width: 0, height: -12)
    shadow.set()
    NSColor(calibratedRed: 0.22, green: 0.36, blue: 0.86, alpha: 1).setFill()
    tile.fill()
    NSGraphicsContext.restoreGraphicsState()

    NSGradient(colors: [
        NSColor(calibratedRed: 0.29, green: 0.60, blue: 0.98, alpha: 1),
        NSColor(calibratedRed: 0.24, green: 0.42, blue: 0.92, alpha: 1),
        NSColor(calibratedRed: 0.27, green: 0.27, blue: 0.78, alpha: 1),
    ], atLocations: [0, 0.5, 1], colorSpace: .deviceRGB)!.draw(in: tile, angle: -90)

    // A quiet highlight along the top edge.
    NSGraphicsContext.saveGraphicsState()
    tile.addClip()
    let rim = NSBezierPath(roundedRect: tileRect.insetBy(dx: 3, dy: 3), xRadius: 183, yRadius: 183)
    rim.lineWidth = 6
    NSBezierPath(rect: NSRect(x: 0, y: 760, width: 1024, height: 264)).addClip()
    NSColor.white.withAlphaComponent(0.28).setStroke()
    rim.stroke()
    NSGraphicsContext.restoreGraphicsState()

    // The bridge: a deck, one low arch under it, and a pier at each end.
    NSGraphicsContext.saveGraphicsState()
    let glyphShadow = NSShadow()
    glyphShadow.shadowColor = NSColor(calibratedRed: 0.08, green: 0.10, blue: 0.40, alpha: 0.30)
    glyphShadow.shadowBlurRadius = 14
    glyphShadow.shadowOffset = NSSize(width: 0, height: -6)
    glyphShadow.set()
    // One layer, so the strokes cast a single shadow instead of shading each other.
    context.cgContext.beginTransparencyLayer(auxiliaryInfo: nil)
    NSColor.white.setStroke()
    let weight: CGFloat = 44
    let deckY: CGFloat = 572
    let springY: CGFloat = 444
    let bridge = NSBezierPath()
    bridge.lineWidth = weight
    bridge.lineCapStyle = .round
    bridge.lineJoinStyle = .round
    // Deck.
    bridge.move(to: NSPoint(x: 226, y: deckY))
    bridge.line(to: NSPoint(x: 798, y: deckY))
    // The arch, rising from the piers to meet the deck at mid-span.
    bridge.move(to: NSPoint(x: 304, y: springY))
    bridge.curve(to: NSPoint(x: 720, y: springY),
                 controlPoint1: NSPoint(x: 372, y: deckY + 8), controlPoint2: NSPoint(x: 652, y: deckY + 8))
    // Two short piers under the ends of the arch.
    for x in [CGFloat(304), 720] {
        bridge.move(to: NSPoint(x: x, y: springY))
        bridge.line(to: NSPoint(x: x, y: 384))
    }
    bridge.stroke()
    context.cgContext.endTransparencyLayer()
    NSGraphicsContext.restoreGraphicsState()

    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

for (name, pixels) in [
    ("icon_16x16", 16), ("icon_16x16@2x", 32), ("icon_32x32", 32), ("icon_32x32@2x", 64),
    ("icon_128x128", 128), ("icon_128x128@2x", 256), ("icon_256x256", 256), ("icon_256x256@2x", 512),
    ("icon_512x512", 512), ("icon_512x512@2x", 1024),
] {
    try render(pixels).write(to: iconset.appendingPathComponent("\(name).png"))
}
let tool = Process()
tool.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
tool.arguments = ["-c", "icns", iconset.path, "-o", "Resources/AppIcon.icns"]
try tool.run()
tool.waitUntilExit()
exit(tool.terminationStatus)
