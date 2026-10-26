"use strict";
exports.__esModule = true;
exports.ListComponent = void 0;
var ListComponent = /** @class */ (function () {
    function ListComponent(list, init) {
        var _a;
        var _b, _c;
        this.mounted = 0;
        this.listElement = document.createElement("ul");
        this.liElements = [];
        this.currentFilter = function () { return true; };
        this.unfilteredList = list !== null && list !== void 0 ? list : [];
        this.list = [];
        this.listElement.classList.add("list-like");
        if (init === null || init === void 0 ? void 0 : init.listClasses) {
            (_a = this.listElement.classList).add.apply(_a, init === null || init === void 0 ? void 0 : init.listClasses);
        }
        this.liClasses = (_b = init === null || init === void 0 ? void 0 : init.elementLiClasses) !== null && _b !== void 0 ? _b : [];
        this.remountIsInsertTransition = (_c = init === null || init === void 0 ? void 0 : init.remountIsInsert) !== null && _c !== void 0 ? _c : true;
        this.syncLists();
    }
    ListComponent.prototype.elementAt = function (index) {
        var _a;
        var li = this.liElements[index];
        if (!li) {
            li = document.createElement("li");
            (_a = li.classList).add.apply(_a, this.liClasses);
            this.liElements[index] = li;
        }
        return li;
    };
    ListComponent.prototype.onAnimElementInserted = function (index) {
        var element = this.liElements[index];
        // let the element render and then add "list-show" for transitions :)
        setTimeout(function () {
            element.classList.add("list-show");
        }, 0);
    };
    ListComponent.prototype.onAnimElementRemoved = function (index) {
        var element;
        while ((element = this.liElements[index]).classList.contains("list-show")) {
            element.classList.remove("list-show");
        }
    };
    ListComponent.prototype.setFilter = function (filter) {
        if (!filter) {
            filter = function () { return true; };
        }
        this.currentFilter = filter;
        this.syncLists();
    };
    ListComponent.prototype.syncLists = function () {
        var newList = this.unfilteredList.filter(this.currentFilter);
        // Unmount all old components
        for (var index = 0; index < this.list.length; index++) {
            var oldComponent = this.list[index];
            var element = this.elementAt(index);
            oldComponent.unmount(element);
            if (index >= newList.length) {
                this.listElement.removeChild(element);
            }
        }
        // Mount all new components and unmount old
        for (var index = 0; index < newList.length; index++) {
            var newComponent = newList[index];
            var element = this.elementAt(index);
            if (this.list.length <= index) {
                this.listElement.appendChild(element);
            }
            newComponent.mount(element);
        }
        this.list = newList;
    };
    ListComponent.prototype.insert = function (index, value) {
        if (index == this.unfilteredList.length) {
            this.unfilteredList.push(value);
        }
        else {
            this.unfilteredList.splice(index, 0, value);
        }
        this.syncLists();
        this.onAnimElementInserted(index);
    };
    ListComponent.prototype.remove = function (index) {
        if (index >= this.unfilteredList.length) {
            this.onAnimElementRemoved(index);
        }
        var value = this.unfilteredList.splice(index, 1);
        this.syncLists();
        return value[0];
    };
    ListComponent.prototype.append = function (value) {
        this.insert(this.get().length, value);
    };
    ListComponent.prototype.removeValue = function (value) {
        var index = this.get().indexOf(value);
        if (index != -1) {
            this.remove(index);
        }
    };
    ListComponent.prototype.clear = function () {
        this.unfilteredList.splice(0, this.unfilteredList.length);
        this.syncLists();
    };
    ListComponent.prototype.get = function () {
        return this.unfilteredList;
    };
    ListComponent.prototype.mount = function (parent) {
        this.mounted++;
        parent.appendChild(this.listElement);
        // Mount all elements
        if (this.mounted == 1) {
            this.syncLists();
            if (this.remountIsInsertTransition) {
                for (var i = 0; i < this.list.length; i++) {
                    this.onAnimElementInserted(i);
                }
            }
        }
    };
    ListComponent.prototype.unmount = function (parent) {
        this.mounted--;
        parent.removeChild(this.listElement);
        // Unmount all elements
        if (this.mounted == 0) {
            if (this.remountIsInsertTransition) {
                for (var i = 0; i < this.list.length; i++) {
                    this.onAnimElementRemoved(i);
                }
            }
            for (var index = this.list.length - 1; index >= 0; index--) {
                var element = this.elementAt(index);
                this.listElement.removeChild(element);
            }
            this.list = [];
        }
    };
    return ListComponent;
}());
exports.ListComponent = ListComponent;
