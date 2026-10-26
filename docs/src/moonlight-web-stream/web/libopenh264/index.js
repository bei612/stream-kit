"use strict";
// See https://github.com/MrCreativ3001/openh264-js
exports.__esModule = true;
exports.copyIntoYuv = exports.yuvBufferSize = exports.OpenH264Decoder = void 0;
var PTR_SIZE = 4;
var OpenH264Decoder = /** @class */ (function () {
    function OpenH264Decoder(module, options) {
        this.pDecoder = 0;
        this.module = module;
        this.options = options;
        var stack = this.module.stackSave();
        var ppDecoder = this.module.stackAlloc(PTR_SIZE);
        var error = this.module._openh264_decoder_create(ppDecoder);
        if (error != 0) {
            this.module.stackRestore(stack);
            throw "Failed to initialize OpenH264 decoder!";
        }
        this.pDecoder = this.module.getValue(ppDecoder, "*");
        this.module.stackRestore(stack);
    }
    OpenH264Decoder.prototype.decode = function (frame) {
        this.checkPtr();
        var stack = this.module.stackSave();
        // TODO: optimize this, no reallocations?
        var frameBuffer = this.module._malloc(frame.byteLength);
        this.module.writeArrayToMemory(frame, frameBuffer);
        var pOutput = this.module.stackAlloc(PTR_SIZE * 3);
        var pWidth = this.module.stackAlloc(4);
        var pHeight = this.module.stackAlloc(4);
        var pStride = this.module.stackAlloc(8);
        var pFrameReady = this.module.stackAlloc(4);
        var error = this.module._openh264_decoder_decode(this.pDecoder, frameBuffer, frame.byteLength, pOutput, pWidth, pHeight, pStride, pFrameReady);
        this.module._free(frameBuffer);
        if (error != 0) {
            this.module.stackRestore(stack);
            throw "Failed to decode frame ".concat(error);
        }
        var frameReady = this.module.getValue(pFrameReady, "i32");
        var width = this.module.getValue(pWidth, "i32");
        var height = this.module.getValue(pHeight, "i32");
        var stride1 = this.module.getValue(pStride, "i32");
        var stride2 = this.module.getValue(pStride + 4, "i32");
        var pY = this.module.getValue(pOutput + PTR_SIZE * 0, "*");
        var pU = this.module.getValue(pOutput + PTR_SIZE * 1, "*");
        var pV = this.module.getValue(pOutput + PTR_SIZE * 2, "*");
        if (frameReady && pY != 0 && pU != 0 && pV != 0) {
            // https://github.com/cisco/openh264/issues/2379
            var y = this.module.HEAPU8.subarray(pY, pY + (height * stride1));
            var u = this.module.HEAPU8.subarray(pU, pU + (height / 2) * stride2);
            var v = this.module.HEAPU8.subarray(pV, pV + (height / 2) * stride2);
            this.options.onFrame([y, u, v], [stride1, stride2], width, height);
        }
        this.module.stackRestore(stack);
    };
    OpenH264Decoder.prototype.checkPtr = function () {
        if (!this.pDecoder) {
            throw "Decoder was already destroyed!";
        }
    };
    OpenH264Decoder.prototype.destroy = function () {
        this.checkPtr();
        this.module._openh264_decoder_destroy(this.pDecoder);
        this.pDecoder = 0;
    };
    return OpenH264Decoder;
}());
exports.OpenH264Decoder = OpenH264Decoder;
function yuvBufferSize(width, height) {
    var ySize = width * height;
    var uvWidth = width >> 1;
    var uvHeight = height >> 1;
    var uvSize = uvWidth * uvHeight;
    return ySize + uvSize * 2;
}
exports.yuvBufferSize = yuvBufferSize;
function copyIntoYuv(buffers, stride, width, height, outBuffer) {
    var yPlane = buffers[0], uPlane = buffers[1], vPlane = buffers[2];
    var yStride = stride[0], uvStride = stride[1];
    var ySize = width * height;
    var uvWidth = width >> 1;
    var uvHeight = height >> 1;
    var uvSize = uvWidth * uvHeight;
    var bufferSize = ySize + uvSize * 2;
    if (outBuffer.length < bufferSize) {
        throw "Yuv output buffer too small!";
    }
    var offset = 0;
    // Copy Y plane
    for (var y = 0; y < height; y++) {
        var srcStart = y * yStride;
        var srcEnd = srcStart + width;
        outBuffer.set(yPlane.subarray(srcStart, srcEnd), offset);
        offset += width;
    }
    // Copy U plane
    for (var y = 0; y < uvHeight; y++) {
        var srcStart = y * uvStride;
        var srcEnd = srcStart + uvWidth;
        outBuffer.set(uPlane.subarray(srcStart, srcEnd), offset);
        offset += uvWidth;
    }
    // Copy V plane
    for (var y = 0; y < uvHeight; y++) {
        var srcStart = y * uvStride;
        var srcEnd = srcStart + uvWidth;
        outBuffer.set(vPlane.subarray(srcStart, srcEnd), offset);
        offset += uvWidth;
    }
    return outBuffer;
}
exports.copyIntoYuv = copyIntoYuv;
