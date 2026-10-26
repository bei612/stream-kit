"use strict";
// See https://github.com/MrCreativ3001/libopus-js
var __extends = (this && this.__extends) || (function () {
    var extendStatics = function (d, b) {
        extendStatics = Object.setPrototypeOf ||
            ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
            function (d, b) { for (var p in b) if (Object.prototype.hasOwnProperty.call(b, p)) d[p] = b[p]; };
        return extendStatics(d, b);
    };
    return function (d, b) {
        if (typeof b !== "function" && b !== null)
            throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
exports.__esModule = true;
exports.OpusMultistreamDecoder = exports.OpusError = exports.OPUS_ALLOC_FAIL = exports.OPUS_INVALID_STATE = exports.OPUS_UNIMPLEMENTED = exports.OPUS_INVALID_PACKET = exports.OPUS_INTERNAL_ERROR = exports.OPUS_BUFFER_TOO_SMALL = exports.OPUS_BAD_ARG = exports.OPUS_OK = void 0;
exports.OPUS_OK = 0;
exports.OPUS_BAD_ARG = -1;
exports.OPUS_BUFFER_TOO_SMALL = -2;
exports.OPUS_INTERNAL_ERROR = -3;
exports.OPUS_INVALID_PACKET = -4;
exports.OPUS_UNIMPLEMENTED = -5;
exports.OPUS_INVALID_STATE = -6;
exports.OPUS_ALLOC_FAIL = -7;
var OpusError = /** @class */ (function (_super) {
    __extends(OpusError, _super);
    function OpusError(errorCode) {
        var _this = _super.call(this, OpusError.getMessageFromCode(errorCode)) || this;
        _this.name = "OpusError";
        _this.errorCode = errorCode;
        return _this;
    }
    OpusError.getMessageFromCode = function (errorCode) {
        switch (errorCode) {
            case exports.OPUS_OK:
                return "Ok";
            case exports.OPUS_BAD_ARG:
                return "Bad Argument";
            case exports.OPUS_BUFFER_TOO_SMALL:
                return "Buffer Too Small";
            case exports.OPUS_INTERNAL_ERROR:
                return "Internal Error";
            case exports.OPUS_INVALID_PACKET:
                return "Invalid Packet";
            case exports.OPUS_UNIMPLEMENTED:
                return "Unimplemented Feature";
            case exports.OPUS_INVALID_STATE:
                return "Invalid State";
            case exports.OPUS_ALLOC_FAIL:
                return "Memory Allocation Failed";
            default:
                return "Unknown Opus error code: ".concat(errorCode);
        }
    };
    return OpusError;
}(Error));
exports.OpusError = OpusError;
// https://www.opus-codec.org/docs/opus_api-1.1.2/group__opus__multistream.html
var OpusMultistreamDecoder = /** @class */ (function () {
    function OpusMultistreamDecoder(module, sampleRate, channels, streams, coupled_channels, mappings) {
        this.ptr = 0;
        this.channels = 0;
        if (mappings.length < channels) {
            throw new OpusError(exports.OPUS_BAD_ARG);
        }
        this.module = module;
        this.channels = channels;
        var stackTop = module.stackSave();
        var mappingPtr = module.stackAlloc(mappings.length);
        for (var index = 0; index < channels; index++) {
            var mapping = mappings[index];
            if (mapping < 0 || mapping > 255) {
                throw new OpusError(exports.OPUS_BAD_ARG);
            }
            module.HEAPU8[mappingPtr + index] = mapping;
        }
        var errorPtr = module.stackAlloc(4);
        this.ptr = module._opus_multistream_decoder_create(sampleRate, channels, coupled_channels, streams, mappingPtr, errorPtr);
        module.stackRestore(stackTop);
        var error = this.module.getValue(errorPtr, "i32");
        if (error != exports.OPUS_OK) {
            throw new OpusError(error);
        }
        this.inputBuffer = new Buffer(this.module);
        this.outputBuffer = new Buffer(this.module);
    }
    OpusMultistreamDecoder.prototype.checkPtr = function () {
        if (this.ptr == 0) {
            throw new OpusError(exports.OPUS_INVALID_STATE);
        }
    };
    /**
     * Decode a multistream Opus packet with floating point output.
     * @param input Input payload. Use a NULL pointer to indicate packet loss.
     * @param output Output signal, with interleaved samples. This must contain room for frame_size*channels samples.
     * @param frameSize The number of samples per channel of available space in pcm. If this is less than the maximum packet duration (120 ms 5760 for 48kHz), this function will not be capable of decoding some packets. In the case of PLC (data==NULL) or FEC (decode_fec=1), then frame_size needs to be exactly the duration of audio that is missing, otherwise the decoder will not be in the optimal state to decode the next incoming packet. For the PLC and FEC cases, frame_size must be a multiple of 2.5 ms.
     * @param decodeFec Request that any in-band forward error correction data be decoded. If no such data is available, the frame is decoded as if it were lost.
     * @returns Number of samples decoded
     */
    OpusMultistreamDecoder.prototype.decodeFloat = function (input, output, frameSize, decodeFec) {
        var _a;
        var outputSize = this.channels * frameSize * 4;
        // 4 bytes per float
        if (output.byteLength < outputSize) {
            throw new OpusError(exports.OPUS_BUFFER_TOO_SMALL);
        }
        this.checkPtr();
        if (input) {
            this.inputBuffer.ensureSize(input.byteLength);
            this.inputBuffer.writeBuffer(new Uint8Array(input));
        }
        this.outputBuffer.ensureSize(outputSize);
        var result = this.module._opus_multistream_decode_float(this.ptr, this.inputBuffer.getPtr(), (_a = input === null || input === void 0 ? void 0 : input.byteLength) !== null && _a !== void 0 ? _a : 0, this.outputBuffer.getPtr(), frameSize, decodeFec ? 1 : 0);
        if (result < 0) {
            throw new OpusError(result);
        }
        var outputBuffer = this.outputBuffer.asBufferF32(0, this.channels * frameSize);
        output.set(outputBuffer);
        return result;
    };
    OpusMultistreamDecoder.prototype.destroy = function () {
        this.checkPtr();
        this.inputBuffer.free();
        this.outputBuffer.free();
        this.module._opus_multistream_decoder_destroy(this.ptr);
        this.ptr = 0;
    };
    return OpusMultistreamDecoder;
}());
exports.OpusMultistreamDecoder = OpusMultistreamDecoder;
var Buffer = /** @class */ (function () {
    function Buffer(module, byteSize) {
        this.length = 0;
        this.ptr = 0;
        this.module = module;
        this.ensureSize(byteSize !== null && byteSize !== void 0 ? byteSize : 0);
    }
    Buffer.prototype.ensureSize = function (length) {
        if (length == 0) {
            return;
        }
        if (!this.ptr) {
            this.ptr = this.module._malloc(length);
            this.length = length;
        }
        else if (this.length < length) {
            this.free();
            this.ptr = this.module._malloc(length);
            this.length = length;
        }
    };
    Buffer.prototype.free = function () {
        if (this.ptr) {
            this.module._free(this.ptr);
            this.ptr = 0;
            this.length = 0;
        }
    };
    Buffer.prototype.writeBuffer = function (input) {
        if (input.byteLength == 0) {
            return;
        }
        this.checkPtr();
        if (this.length < input.byteLength) {
            throw "BufferOutOfBounds";
        }
        this.module.writeArrayToMemory(input, this.ptr);
    };
    Buffer.prototype.asBufferF32 = function (offsetF32, lengthF32) {
        if (lengthF32 <= 0) {
            return new Float32Array([]);
        }
        this.checkPtr();
        if ((offsetF32 + lengthF32) * 4 < this.length || offsetF32 < 0 || lengthF32 < 0) {
            throw "BufferOutOfBounds";
        }
        var buffer = new Float32Array(this.module.HEAPF32.buffer, this.ptr + (offsetF32 * 4), lengthF32);
        return buffer;
    };
    Buffer.prototype.checkPtr = function () {
        if (!this.ptr) {
            throw "NullPointer";
        }
    };
    Buffer.prototype.getPtr = function () {
        return this.ptr;
    };
    Buffer.prototype.getLength = function () {
        return this.length;
    };
    return Buffer;
}());
