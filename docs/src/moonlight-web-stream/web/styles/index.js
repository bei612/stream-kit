"use strict";
var _a;
exports.__esModule = true;
exports.getStyle = exports.setStyle = void 0;
var settings_menu_js_1 = require("../component/settings_menu.js");
var currentStyle = null;
var styleLink = document.getElementById("style");
function toAbsolute(path) {
    return new URL(path, document.baseURI).href;
}
function setStyle(style) {
    if (!currentStyle) {
        document.head.appendChild(styleLink);
    }
    var path = "styles/".concat(style, ".css");
    var absolute = toAbsolute(path);
    if (styleLink.href !== absolute) {
        styleLink.href = absolute;
    }
    currentStyle = style;
}
exports.setStyle = setStyle;
function getStyle() {
    return currentStyle;
}
exports.getStyle = getStyle;
var settings = (0, settings_menu_js_1.getLocalStreamSettings)();
var defaultSettings_ = (0, settings_menu_js_1.defaultSettings)();
setStyle((_a = settings === null || settings === void 0 ? void 0 : settings.pageStyle) !== null && _a !== void 0 ? _a : defaultSettings_.pageStyle);
