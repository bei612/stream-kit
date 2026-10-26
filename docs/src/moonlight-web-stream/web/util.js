"use strict";
exports.__esModule = true;
exports.numToHex = exports.download = exports.globalObject = void 0;
function globalObject() {
    if (typeof self !== 'undefined') {
        return self;
    }
    if (typeof window !== 'undefined') {
        return window;
    }
    return globalThis;
}
exports.globalObject = globalObject;
function download(data, filename, mime) {
    if (mime === void 0) { mime = "application/octet-stream"; }
    var blob = data instanceof Blob ? data : new Blob([data], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}
exports.download = download;
function numToHex(n) {
    var hex = n.toString(16);
    return hex.length === 1 ? "0" + hex : hex;
}
exports.numToHex = numToHex;
