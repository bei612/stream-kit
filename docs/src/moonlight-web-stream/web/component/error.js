"use strict";
exports.__esModule = true;
exports.showErrorPopup = void 0;
var api_js_1 = require("../api.js");
var index_js_1 = require("../resources/index.js");
var list_js_1 = require("./list.js");
var ERROR_REMOVAL_TIME_MS = 10000;
var errorListElement = document.getElementById("error-list");
var errorListComponent = new list_js_1.ListComponent([], { listClasses: ["error-list"], elementLiClasses: ["error-element"] });
if (errorListElement) {
    errorListComponent.mount(errorListElement);
}
var alertedErrorListNotFound = false;
function showErrorPopup(message, fatal, errorObject) {
    if (fatal === void 0) { fatal = false; }
    console.error(message, errorObject);
    if (!errorListElement) {
        if (!alertedErrorListNotFound) {
            alert("couldn't find the error element");
            alertedErrorListNotFound = true;
        }
        alert(message);
        return;
    }
    var error;
    if (fatal) {
        error = new ErrorComponent(message, index_js_1.ERROR_IMAGE);
    }
    else {
        error = new ErrorComponent(message, index_js_1.WARN_IMAGE);
    }
    errorListComponent.append(error);
    setTimeout(function () {
        errorListComponent.removeValue(error);
    }, ERROR_REMOVAL_TIME_MS);
}
exports.showErrorPopup = showErrorPopup;
// TODO: wtf am i doing here? why fatal = that?
function handleError(event) {
    var fatal = event instanceof api_js_1.FetchError;
    showErrorPopup("".concat(event.error), fatal, event);
}
function handleRejection(event) {
    var fatal = event instanceof api_js_1.FetchError;
    showErrorPopup("".concat(event.reason), fatal, event);
}
window.addEventListener("error", handleError);
window.addEventListener("unhandledrejection", handleRejection);
var ErrorComponent = /** @class */ (function () {
    function ErrorComponent(message, image) {
        this.messageElement = document.createElement("p");
        this.imageElement = document.createElement("img");
        this.messageElement.innerText = message;
        this.messageElement.classList.add("error-message");
        this.imageElement.src = image;
        this.imageElement.classList.add("error-image");
    }
    ErrorComponent.prototype.mount = function (parent) {
        parent.appendChild(this.imageElement);
        parent.appendChild(this.messageElement);
    };
    ErrorComponent.prototype.unmount = function (parent) {
        parent.removeChild(this.imageElement);
        parent.removeChild(this.messageElement);
    };
    return ErrorComponent;
}());
