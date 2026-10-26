"use strict";
exports.__esModule = true;
exports.buildUrl = void 0;
var config_js_1 = require("./config.js");
function buildUrl(path) {
    var _a;
    return "".concat(window.location.origin).concat((_a = config_js_1["default"] === null || config_js_1["default"] === void 0 ? void 0 : config_js_1["default"].path_prefix) !== null && _a !== void 0 ? _a : "").concat(path);
}
exports.buildUrl = buildUrl;
