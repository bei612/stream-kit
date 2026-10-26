"use strict";
exports.__esModule = true;
exports.addPipePassthrough = void 0;
function addPipePassthrough(pipe, overwrite) {
    var pipeAny = pipe;
    var passthrough = function (name, force) {
        if (name in pipeAny && !force) {
            return;
        }
        pipeAny[name] = function () {
            var base = pipe.getBase();
            if (base) {
                return base[name].apply(base, arguments);
            }
        };
    };
    passthrough("setup", false);
    passthrough("cleanup", false);
    passthrough("pollRequestIdr", false);
    passthrough("getStreamRect", false);
    passthrough("onUserInteraction", false);
    passthrough("mount", false);
    passthrough("unmount", false);
    passthrough("reportStats", false);
    if (overwrite) {
        for (var _i = 0, overwrite_1 = overwrite; _i < overwrite_1.length; _i++) {
            var overwriteFn = overwrite_1[_i];
            passthrough(overwriteFn, true);
        }
    }
}
exports.addPipePassthrough = addPipePassthrough;
