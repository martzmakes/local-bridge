import SwiftUI

extension View {
    /// Section footers read as a quiet paragraph under the group: footnote size, secondary
    /// colour (or the given one, for an error), leading-aligned, full width.
    func formFooter(_ color: Color? = nil) -> some View {
        self
            .font(.footnote)
            .foregroundStyle(color.map(AnyShapeStyle.init) ?? AnyShapeStyle(.secondary))
            .multilineTextAlignment(.leading)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}
