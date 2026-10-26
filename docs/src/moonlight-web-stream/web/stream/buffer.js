"use strict";
exports.__esModule = true;
exports.BIG_BUFFER = exports.ByteBuffer = exports.I16_MAX = exports.U16_MAX = exports.U8_MAX = void 0;
exports.U8_MAX = 255;
exports.U16_MAX = 65535;
exports.I16_MAX = 32767;
var ByteBuffer = /** @class */ (function () {
    function ByteBuffer(value, littleEndian) {
        this.position = 0;
        this.limit = 0;
        this.littleEndian = littleEndian !== null && littleEndian !== void 0 ? littleEndian : false;
        if (value instanceof Uint8Array) {
            this.buffer = value;
            this.limit = value.length;
        }
        else {
            this.buffer = new Uint8Array(value !== null && value !== void 0 ? value : 0);
            this.limit = value !== null && value !== void 0 ? value : 0;
        }
    }
    ByteBuffer.prototype.bytesUsed = function (amount, reading) {
        this.position += amount;
        if (reading && this.position > this.limit) {
            throw "failed to read over the limit";
        }
    };
    ByteBuffer.prototype.useDataView = function (length, reading, index) {
        var position = this.position;
        if (index != null) {
            position = index;
        }
        var maxPosition = position + length;
        if (maxPosition > this.buffer.length) {
            throw "failed to write over the capacity";
        }
        if (maxPosition > this.limit) {
            this.limit = maxPosition;
        }
        if (index == null) {
            this.bytesUsed(length, reading);
        }
        return new DataView(this.buffer.buffer, position, length);
    };
    ByteBuffer.prototype.putU8Array = function (data, index) {
        var position = this.position;
        if (index) {
            position = index;
        }
        var maxPosition = position + data.length;
        if (maxPosition > this.buffer.length) {
            throw "failed to write over the capacity";
        }
        if (maxPosition > this.limit) {
            this.limit = maxPosition;
        }
        this.buffer.set(data, position);
        if (index == null) {
            this.bytesUsed(data.length, false);
        }
    };
    ByteBuffer.prototype.putU16Array = function (data, index) {
        var position = index !== null && index !== void 0 ? index : this.position;
        var maxPosition = position + data.length * 2;
        if (maxPosition > this.buffer.length) {
            throw "failed to write over the capacity";
        }
        for (var i = 0; i < data.length; i++) {
            var view = new DataView(this.buffer.buffer, position + i * 2, 2);
            view.setUint16(0, data[i], this.littleEndian);
        }
        if (maxPosition > this.limit) {
            this.limit = maxPosition;
        }
        if (index == null) {
            this.bytesUsed(data.length * 2, false);
        }
    };
    ByteBuffer.prototype.putU32Array = function (data, index) {
        var position = index !== null && index !== void 0 ? index : this.position;
        var maxPosition = position + data.length * 4;
        if (maxPosition > this.buffer.length) {
            throw "failed to write over the capacity";
        }
        for (var i = 0; i < data.length; i++) {
            var view = new DataView(this.buffer.buffer, position + i * 4, 4);
            view.setUint32(0, data[i], this.littleEndian);
        }
        if (maxPosition > this.limit) {
            this.limit = maxPosition;
        }
        if (index == null) {
            this.bytesUsed(data.length * 4, false);
        }
    };
    ByteBuffer.prototype.putU8 = function (data, index) {
        var view = this.useDataView(1, false, index);
        view.setUint8(0, data);
    };
    ByteBuffer.prototype.putBool = function (data) {
        this.putU8(data ? 1 : 0);
    };
    ByteBuffer.prototype.putI8 = function (data, index) {
        var view = this.useDataView(1, false, index);
        view.setInt8(0, data);
    };
    ByteBuffer.prototype.putU16 = function (data, index) {
        var view = this.useDataView(2, false, index);
        view.setUint16(0, data, this.littleEndian);
    };
    ByteBuffer.prototype.putI16 = function (data, index) {
        var view = this.useDataView(2, false, index);
        view.setInt16(0, data, this.littleEndian);
    };
    ByteBuffer.prototype.putU32 = function (data, index) {
        var view = this.useDataView(4, false, index);
        view.setUint32(0, data, this.littleEndian);
    };
    ByteBuffer.prototype.putI32 = function (data, index) {
        var view = this.useDataView(4, false, index);
        view.setInt32(0, data);
    };
    ByteBuffer.prototype.putU64 = function (data, index) {
        var hi = Math.floor(data / 0x100000000); // upper 32 bits
        var lo = data >>> 0; // lower 32 bits
        var view = this.useDataView(8, false, index);
        if (this.littleEndian) {
            view.setUint32(0, lo, true);
            view.setUint32(4, hi, true);
        }
        else {
            view.setUint32(0, hi, false);
            view.setUint32(4, lo, false);
        }
        this.bytesUsed(8, false);
    };
    ByteBuffer.prototype.putUtf8Raw = function (text) {
        var encoder = new TextEncoder();
        var result = encoder.encodeInto(text, this.buffer.subarray(this.position));
        this.bytesUsed(result.written, false);
        if (result.read != text.length) {
            throw "failed to put utf8 text";
        }
    };
    ByteBuffer.prototype.putF32 = function (data) {
        var view = new DataView(this.buffer.buffer);
        view.setFloat32(this.position, data, this.littleEndian);
        this.bytesUsed(4, false);
    };
    ByteBuffer.prototype.get = function (buffer, offset, length) {
        buffer.set(this.buffer.subarray(this.position, this.position + length), offset);
        this.bytesUsed(length, true);
    };
    ByteBuffer.prototype.getU8 = function () {
        var view = new DataView(this.buffer.buffer);
        var byte = view.getUint8(this.position);
        this.bytesUsed(1, true);
        return byte;
    };
    ByteBuffer.prototype.getU16 = function () {
        var view = new DataView(this.buffer.buffer);
        var byte = view.getUint16(this.position);
        this.bytesUsed(2, true);
        return byte;
    };
    ByteBuffer.prototype.getU32 = function () {
        var view = new DataView(this.buffer.buffer);
        var byte = view.getUint32(this.position);
        this.bytesUsed(4, true);
        return byte;
    };
    ByteBuffer.prototype.getBool = function () {
        return this.getU8() != 0;
    };
    ByteBuffer.prototype.getUtf8Raw = function (length) {
        var buffer = new Uint8Array(length);
        this.get(buffer, 0, length);
        var decoder = new TextDecoder();
        return decoder.decode(buffer);
    };
    ByteBuffer.prototype.reset = function () {
        this.position = 0;
        this.limit = 0;
    };
    ByteBuffer.prototype.flip = function () {
        this.limit = this.position;
        this.position = 0;
    };
    ByteBuffer.prototype.isLittleEndian = function () {
        return this.littleEndian;
    };
    ByteBuffer.prototype.getPosition = function () {
        return this.position;
    };
    ByteBuffer.prototype.getRemainingBuffer = function () {
        return this.buffer.slice(this.position, this.limit);
    };
    return ByteBuffer;
}());
exports.ByteBuffer = ByteBuffer;
exports.BIG_BUFFER = new ByteBuffer(1000000);
