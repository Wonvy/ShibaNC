import QuickLookThumbnailing
import CoreGraphics
import Foundation

/// macOS Finder QuickLook Thumbnail Extension (`QLThumbnailProvider`)
/// Links against `libshibanc_ffi.a` (`cargo build --release -p shibanc-ffi`)
final class ThumbnailProvider: QLThumbnailProvider {
    override func provideThumbnail(
        for request: QLFileThumbnailRequest,
        _ handler: @escaping (QLThumbnailReply?, Error?) -> Void
    ) {
        let maxDim = UInt32(max(request.maximumSize.width, request.maximumSize.height) * request.scale)
        let filePath = request.fileURL.path

        var rawBuf = ShibaRgbaBuffer(data: nil, len: 0, width: 0, height: 0)
        let ok = filePath.withCString { cPath in
            shibanc_render_file_thumbnail(cPath, maxDim, &rawBuf)
        }

        guard ok, let basePtr = rawBuf.data, rawBuf.len > 0 else {
            handler(nil, CocoaError(.fileReadCorruptFile))
            return
        }

        let width = Int(rawBuf.width)
        let height = Int(rawBuf.height)
        let byteLen = Int(rawBuf.len)
        let cfData = CFDataCreate(nil, basePtr, byteLen)
        shibanc_free_rgba_buffer(rawBuf)

        guard let data = cfData,
              let provider = CGDataProvider(data: data),
              let cgImage = CGImage(
                  width: width,
                  height: height,
                  bitsPerComponent: 8,
                  bitsPerPixel: 32,
                  bytesPerRow: width * 4,
                  space: CGColorSpaceCreateDeviceRGB(),
                  bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.last.rawValue),
                  provider: provider,
                  decode: nil,
                  shouldInterpolate: true,
                  intent: .defaultIntent
              )
        else {
            handler(nil, CocoaError(.coderInvalidValue))
            return
        }

        let contextSize = CGSize(
            width: CGFloat(width) / request.scale,
            height: CGFloat(height) / request.scale
        )
        let reply = QLThumbnailReply(contextSize: contextSize) { ctx -> Bool in
            ctx.draw(cgImage, in: CGRect(origin: .zero, size: contextSize))
            return true
        }
        handler(reply, nil)
    }
}
