"use strict";
exports.__esModule = true;
exports.removeContextMenu = exports.setContextMenu = void 0;
var error_js_1 = require("./error.js");
var list_js_1 = require("./list.js");
document.addEventListener("click", function () { return removeContextMenu(); });
var contextMenuElement = document.getElementById("context-menu");
var contextMenuList = new list_js_1.ListComponent([], {
    listClasses: ["context-menu-list"]
});
function setContextMenu(event, init) {
    var _a;
    event.preventDefault();
    event.stopPropagation();
    if (contextMenuElement == null) {
        (0, error_js_1.showErrorPopup)("cannot find the context menu element");
        return;
    }
    contextMenuElement.style.setProperty("left", "".concat(event.clientX, "px"));
    contextMenuElement.style.setProperty("top", "".concat(event.clientY, "px"));
    contextMenuList.clear();
    for (var _i = 0, _b = (_a = init === null || init === void 0 ? void 0 : init.elements) !== null && _a !== void 0 ? _a : []; _i < _b.length; _i++) {
        var element = _b[_i];
        contextMenuList.append(new ContextMenuElementComponent(element));
    }
    contextMenuList.mount(contextMenuElement);
    contextMenuElement.classList.remove("context-menu-disabled");
}
exports.setContextMenu = setContextMenu;
function removeContextMenu() {
    if (contextMenuElement == null) {
        (0, error_js_1.showErrorPopup)("cannot find the context menu element");
        return;
    }
    contextMenuElement.classList.add("context-menu-disabled");
}
exports.removeContextMenu = removeContextMenu;
var ContextMenuElementComponent = /** @class */ (function () {
    function ContextMenuElementComponent(element) {
        var _a;
        this.nameElement = document.createElement("p");
        this.nameElement.innerText = element.name;
        this.nameElement.classList.add("context-menu-element");
        this.nameElement.addEventListener("click", function (event) {
            element.callback(event);
        });
        // Also register right click for certain devices which make left click hard: https://github.com/MrCreativ3001/moonlight-web-stream/issues/55
        this.nameElement.addEventListener("contextmenu", function (event) {
            event.preventDefault();
            removeContextMenu();
            element.callback(event);
        }, { passive: false });
        if (element.classes) {
            (_a = this.nameElement.classList).add.apply(_a, element.classes);
        }
    }
    ContextMenuElementComponent.prototype.mount = function (parent) {
        parent.appendChild(this.nameElement);
    };
    ContextMenuElementComponent.prototype.unmount = function (parent) {
        parent.removeChild(this.nameElement);
    };
    return ContextMenuElementComponent;
}());
