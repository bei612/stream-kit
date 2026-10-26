"use strict";
exports.__esModule = true;
exports.getSidebarRoot = exports.setSidebar = exports.isSidebarExtended = exports.setSidebarExtended = exports.toggleSidebar = exports.setSidebarStyle = void 0;
var error_js_1 = require("../error.js");
var sidebarExtended = false;
var sidebarRoot = document.getElementById("sidebar-root");
var sidebarParent = document.getElementById("sidebar-parent");
var sidebarButton = document.getElementById("sidebar-button");
sidebarButton === null || sidebarButton === void 0 ? void 0 : sidebarButton.addEventListener("click", toggleSidebar);
var sidebarComponent = null;
function setSidebarStyle(style) {
    var _a;
    // Default values
    var edge = (_a = style.edge) !== null && _a !== void 0 ? _a : "left";
    // Set edge
    sidebarRoot === null || sidebarRoot === void 0 ? void 0 : sidebarRoot.classList.remove("sidebar-edge-left", "sidebar-edge-right", "sidebar-edge-up", "sidebar-edge-down");
    sidebarRoot === null || sidebarRoot === void 0 ? void 0 : sidebarRoot.classList.add("sidebar-edge-".concat(edge));
}
exports.setSidebarStyle = setSidebarStyle;
function toggleSidebar() {
    setSidebarExtended(!isSidebarExtended());
}
exports.toggleSidebar = toggleSidebar;
function setSidebarExtended(extended) {
    if (extended == sidebarExtended) {
        return;
    }
    if (extended) {
        sidebarRoot === null || sidebarRoot === void 0 ? void 0 : sidebarRoot.classList.add("sidebar-show");
    }
    else {
        sidebarRoot === null || sidebarRoot === void 0 ? void 0 : sidebarRoot.classList.remove("sidebar-show");
    }
    sidebarExtended = extended;
}
exports.setSidebarExtended = setSidebarExtended;
function isSidebarExtended() {
    return sidebarExtended;
}
exports.isSidebarExtended = isSidebarExtended;
function setSidebar(sidebar) {
    if (sidebarParent == null || sidebarRoot == null) {
        (0, error_js_1.showErrorPopup)("failed to get sidebar");
        return;
    }
    if (sidebarComponent) {
        // unmount
        sidebarComponent === null || sidebarComponent === void 0 ? void 0 : sidebarComponent.unmount(sidebarParent);
        sidebarComponent = null;
        sidebarRoot.style.visibility = "hidden";
    }
    if (sidebar) {
        // mount
        sidebarComponent = sidebar;
        sidebar === null || sidebar === void 0 ? void 0 : sidebar.mount(sidebarParent);
        sidebarRoot.style.visibility = "visible";
    }
}
exports.setSidebar = setSidebar;
function getSidebarRoot() {
    return sidebarRoot;
}
exports.getSidebarRoot = getSidebarRoot;
// initialize defaults
setSidebarStyle({
    edge: "left"
});
setSidebar(null);
