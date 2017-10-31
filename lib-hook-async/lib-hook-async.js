/*
 * Copyright (c) 2017, nekavally
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
 * REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
 * AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
 * INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
 * LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE
 * OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
 * PERFORMANCE OF THIS SOFTWARE.
 */

/*
    Basic extensible enpoints with hot code reloading support.

    Bases on concept of hooks - small functions implementing application logic, invoked at
    specific events in application lifetime.
    
    (Re)Loading performed automatically from *.hook.js files placed in 'hooks' subdirectory.
    Every file must be a valid Node.JS module, which exports zero or more functions with
    specific decorations in name.

Defining hooks in files

    Export named function, with name following specific scheme:
        h<Type>[<Category>]_<hook_name>

    where 'Type' is one of 'A', 'S' or 'E', determining hook calling convention as synchronous,
    asynchronous and event listener accordingly, and 'Category' is an optional group of letters
    from A to Z assigning categories to function. Hook name could be anything allowed in ECMA262.

    Each module also has exported constant named 'priority' which determines order of execution
    of hook functions. Explicit definition is not mandatory, if this constant is not defined, it
    has value 0. Hook functions defined in module with *smaller* priority number will be executed
    first, order of execution of functions defined in modules with same priority isn't defined.
    
Hooks calling convention

    All exported functions, following naming scheme above, are considered to be part of single hook.
    There is no restriction on how hook function should be called - functions with different calling
    conventions can be safely mixed within single hook.

    There are 3 function calling conventions:
    (S) Synchronous - result must not be modified after function exit;
    (A) Asynchronous - provided callback must be invoked after result computation is done;
    (E) Event listener - result must not be modified at all, no callback to invoke is provided.

    Hooks designed to be called for result or just run to do something in response to some event.
    When hook runs, all hook functions executed without chaining, results returned by functions ignored.
    Hook can be called synchronously (callHookSync) or asynchronously, but asynchronous method recommended,
    because callHookSync doesn't invoke functions designated as asynchronous. E functions will be invoked
    regardless of hook calling method.

Using categories

    Any hook function can have category(ies) specified to dynamically exclude some functions from executing in
    different situations, for example, functions used only in the course of development, or functions active
    only for specific time of day, or selected context.

    All hook calling and running methods accept category mask of which categories to include when executing
    hook. Note that mask is inclusive - function has to be in at least one category in order to be includes,
    "Categoryless" functions assumed to be included in all categories, and they will be included anyways unless
    0 is specified as category mask, which prevents all functions to execute.

    There is a posibility to call and run hooks using strict category matching, see `callHookStrict` and
    `runHookStrict` exports.

Built-in hooks

    There is currently only one built-in hook: 'onHookModuleChanged' - which will be run every time module with
    hook functions loaded or reloaded due to changes, single argument it have always set to path to the changed
    module file.

Hooks interface

    Upon executing hook function, it will be bound to context object:
    
        {
            lastResult: any
            callback: function(result:any)
        }

    Field 'lastResult' always contains execution result of previous hook function, and 'callback'
    points to function which must be called at some point with argument set to execution result, if function
    designed to return result asynchronously.

    Using context object to pass this information removes necessity of framework-defined arguments, making
    declarations for hook functions more straightforward and clean.
*/

const HOOK_FILE_NAME_REGEX = /.+?\.hook\.js/;
const HOOK_FUNC_REGEX_V2 = /h([ASEase])([A-Za-z]+)?_(.*)/;

const fs = require("fs");
const path = require("path");
const process = require("process");

function dummy() { }
function inclusiveMatchFunc(cat, catMask) {
    return cat & catMask;
}
function strictMatchFunc(cat, catMask) {
    return (cat ^ catMask) == 0;
}

//TODO Rewrite using ES2015 classes - tsserver has less issues with them and code a bit cleaner.

var ContextSymbol = new Symbol("Context");

/** @returns {{_compareFunc: (category: number, mask: number) => boolean, _nextHook: number, _lastResult: any, callback: (result: any)=>void}} */
function createContext(initialValue, environment) {
    var c = Object.create(environment);
    Object.defineProperty(c, "_lastResult", { value: initialValue, configurable: false, writable: true, enumerable: false });
    Object.defineProperty(c, "callback", { value: dummy, configurable: false, writable: true, enumerable: false });
    Object.defineProperty(c, "_nextHook", { value: 0, configurable: false, enumerable: false, writable: true })
    Object.defineProperty(c, "_compareFunc", { value: inclusiveMatchFunc, enumerable: false, configurable: false, writable: true });
    Object.defineProperty(c, ContextSymbol, { value: true, enumerable: false, configurable: false, writable: false });
    return c;
}

/** @param {string} letter */
function decodeCategory(letter) {
    if (typeof letter === "string") {
        letter = letter.toUpperCase();
        var A = "AZ".charCodeAt(0), Z = "AZ".charCodeAt(1);
        var cat = 0;
        for (var i = 0, c = letter.charCodeAt(i); i < letter.length; i++ , c = letter.charCodeAt(i)){
            if (A <= c && c <= Z)
                cat |= 1 << c - A;
        }
        return cat;
    }
    return -1 | 0;
}

class HookExecutor {
    constructor() {
        this.hooks = [];
    };
    setHook(hookfunc) {
        var index = this.hooks.findIndex(function(hook) {
            return hook.src == hookfunc.src && hook.type == hook.type;
        });
        if (index > -1) {
            this.hooks[index] = hookfunc;
        } else {
            this.hooks.push(hookfunc);
        }
        this.hooks.sort(function(a, b) {
            return a.priority - b.priority;
        });
    };
    delHooks(signature) {
        for (var i = 0; i < this.hooks.length; i++) {
            if (this.hooks.src == signature) {
                this.hooks.splice(i, 1);
                i--;
            }
        }
    };
    check(catMask) {
        return this.hooks.findIndex(function(hook) {
            return (catMask & hook.cat) != 0;
        }) > -1;
    };
    checkStrict(catMask) {
        return this.hooks.findIndex(function(hook) {
            return (catMask ^ hook.cat) == 0;
        }) > -1;
    };
    /**
     * Calls hooks using default execution mode.
     * @param {number} catMask categories mask
     * @param {function(any)} cb callback
     * @param {Context} context execution context from previous asynchronous call
     * @param {?[]} args
     */
    call(catMask, cb, context, args) {
        for (var i = context._nextHook; i < this.hooks.length; i++){
            let hook = this.hooks[i];
            let lr = context._lastResult;
            if (context._compareFunc(hook.cat, catMask)) {
                switch (hook.execPolicy) {
                    case 0:  //Sync
                        context._lastResult = hook.apply(context, args);
                        break;
                    case 1:  //Event
                        lr = context._lastResult;
                        hook.apply(context, args);
                        context._lastResult = lr;
                        break;
                    case 2:  //Async
                        context._nextHook = i + 1;    
                        context.callback = (value) => {
                            context._lastResult = value;
                            this.call(catMask, cb, context, ...args);
                        }
                        hook.apply(context, args);
                        return;
                }
            }
        }
        process.nextTick(function() {
            cb(context._lastResult);
        });
    };
    /**
     * Calls hooks using legacy synchronous mode.
     * @param {number} catMask categories mask
     * @param {?[]} args
     */
    callSync(catMask, context, args) {
        for (var i = context._nextHook; i < this.hooks.length; i++){
            let hook = this.hooks[i];
            let lr = context._lastResult;
            if (context._compareFunc(hook.cat, catMask)) {
                switch (hook.execPolicy) {
                    case 0:
                        context._lastResult = hook.apply(context, args);    
                        break;
                    case 1:
                        lr = context._lastResult;
                        hook.apply(context, args);
                        context._lastResult = lr;
                        break;
                }
            }
        }
        return context._lastResult;
    }
    /**
     * Calls hooks without waiting for result.
     * @param {number} catMask categories mask
     * @param {Context} context execution context
     * @param {?[]} args
     */
    dispatch(catMask, context, args) {
        if (!context[ContextSymbol]) context = createContext(undefined, context);
        for (var i = context._nextHook; i < this.hooks.length; i++){
            let hook = this.hooks[i];
            if (context._compareFunc(hook.cat, catMask)) {
                switch (hook.execPolicy) {
                    case 0:
                        context._lastResult = undefined;    
                        context._lastResult = hook.apply(context, args);
                        break;
                    case 1:
                        context._lastResult = undefined;    
                        hook.apply(context, args);
                        break;
                    case 2:
                        context._lastResult = undefined;
                        context.callback = dummy;
                        context._nextHook = i + 1;
                        hook.apply(context, args);
                        break;
                }
            }
        }
    }
}

class HookLoader {
    /**
     * Creates new hook loader using specific directory to search for hook files.
     * @param {string} baseDir base path to search for hook files
     * @param {*} [options]
     * @param {function(Error)} readyCallback
     */
    constructor(baseDir, options, readyCallback) {
        Object.defineProperty(this, "_hooksTable", { value: new Map(), enumerable: false, writable: false, configurable: false });
        Object.defineProperty(this, "libraryPath", { value: baseDir, configurable: false, writable: false, enumerable: true });

        this.context = null;

        if (typeof options == "function") {
            readyCallback = options;
            options = null;
        }
    
        if (!options) {
            options = {
                watch: true,
                recursive: false
            };
        }
    
        var self = this;
        fs.readdir(baseDir, function(err, list) {
            if (err) {
                if (typeof readyCallback == "function")
                    readyCallback(err);    
            } else {
                self.__mergeHooksIntoTable(this._hooksTable, list.filter(function(item) {
                    return HOOK_FILE_NAME_REGEX.test(item);
                }).map(function(item) {
                    return path.join(baseDir, item);
                    }), false);
                if (options.watch) {
                    self.__runHookWatcher(options.recursive);
                }
                readyCallback(null);
            }
        });
    
    };

    __mergeHooksIntoTable(modules, callhooks) {
        var table = this._hooks;
        var self = this;
        modules.forEach(function(mod) {
            var sign = path.basename(mod);
            var hooks = self.__getHooksFromModule(mod);
            for (var i in table) {
                if (typeof table[i].delHooks === "function") {
                    table[i].delHooks(sign);
                    for (var k = 0; k < hooks.length; k++) {
                        if (hooks[k].type == i) {
                            table[i].setHook(hooks[k]);
                            hooks.splice(k, 1);
                            k--;
                        }
                    }
                }
            }
            //If some hooks left, then it means their types aren't registered yet
            let hook;
            while (hook = hooks.pop()){
                table[hook.type] = new HookExecutor();
                table[hook.type].setHook(hook);
            }
            //Fire infrastructure hooks (only one at the moment)
            if (callhooks) {
                process.nextTick(function() {
                    self.runHook("onHookModuleChanged", path.resolve(self.libraryPath, mod));
                });
            }
        });
    };

    __getHooksFromModule(filepath) {
        var abs = path.resolve(this._baseDir, filepath);
        delete require.cache[abs];
        try {
            var mod = require(abs);
            var sign = path.basename(filepath);
            var hooks = [];
            var prio = typeof mod.priority === "number" ? mod.priority : 0;
            for (var i in mod) {
                let m = HOOK_FUNC_REGEX_V2.exec(i);
                if (m && typeof mod[i] === "function") {
                    if (typeof mod[i] != "number")
                        mod[i].priority = prio;
                    mod[i].src = sign;
                    mod[i].type = m[3];
                    mod[i].cat = decodeCategory(m[2]);
                    m[1] = m[1].toUpperCase();
                    mod[i].execPolicy = m[1] == "S" ? 0 : (m[1] == "E" ? 1 : 2);
                    hooks.push(mod[i]);
                }
            }
            return hooks;
        } catch (e) {
            if (e.code !== "ENOENT") {
                console.log(e);
            }
            return [];
        }
    };

    /**
     * Starts filesystem watcher for hooks.
     * @param {function(string[])} callback
     */
    __runHookWatcher(recursive) {
        const DELAY = 200;
        //var firstChange = 0;
        var changes = [];
        var timeout;
        var self = this;
        this._watcher = fs.watch(this.libraryPath, {
            recursive: recursive,
            encoding: "utf8"
        }, function(event, filename) {
            changes.push(path.resolve(self.libraryPath, filename));
            clearTimeout(timeout);
            timeout = setTimeout(function() {
                self.__hookWatcherCallback(changes.splice(0, changes.length));
                changes = [];
            }, DELAY);
        });
    };

    __hookWatcherCallback(modules) {
        this.__mergeHooksIntoTable(this._hooksTable, modules.filter(function(mod) {
            return HOOK_FILE_NAME_REGEX.test(mod);
        }), true);
    };

    /**
     * Calls named hook asynchronously. Throws if hook is not found.
     * @param {number} [catMask] categories filter
     * @param {string} name name of hook to call
     * @param {function(any)} callback callback function, which will be called with hook result
     * @param {?[]} ...args parameters to pass to hook functions
     */
    callHook(catMask, name, callback, ...args) {
        if (typeof catMask !== "number") {
            if (callback !== undefined)
                args.unshift(callback);
            callback = name
            name = catMask;
            catMask = -1;
        }
        this._hooksTable[name].call(catMask, callback, createContext(undefined, this.context), args);
    };

    /**
     * Calls named hook asynchronously, ensuring strict category matching -
     * only hook functions with exact categories set will be executed.
     * @param {number} [catMask] categories filter
     * @param {string} name name of hook to call
     * @param {function(any)} callback callback function, which will be called with hook results
     * @param {?[]} ...args parameters to pass to hook functions
     */
    callHookStrict(catMask, name, callback, ...args) {
        if (typeof catMask !== "number") {
            if (callback !== undefined)
                args.unshift(callback);
            callback = name
            name = catMask;
            catMask = -1;
        }
        var context = createContext(undefined, this.context);
        context._compareFunc = strictMatchFunc;
        this._hooksTable[name].call(catMask, callback, context, args);
    };

    /**
     * Calls named hook synchronously. Not recommended - skips asynchronous hook functons -, consider using asynchronous version.
     * @param {number} [catMask] categories filter
     * @param {string} name name of hook to call
     * @param {?[]} ...args parameters to pass to hook
     */
    callHookSync(catMask, name, ...args) {
        if (typeof catMask !== "number") {
            if (name !== undefined)
                args.unshift(name);
            name = catMask;
            catMask = -1 | 0;
        }
        this._hooksTable[name].callSync(catMask, createContext(undefined, this.context), args);
    };

    /**
     * Calls named hook without returning value.
     * @param {number} [catMask] categories filter
     * @param {string} name name of hook to call
     * @param {?[]} ...args parameters to pass to hook
     */
    runHook(catMask, name, ...args) {
        if (typeof catMask !== "number") {
            if (name !== undefined)
                args.unshift(name);
            name = catMask;
            catMask = -1 | 0;
        }
        if (this._hooksTable[name] instanceof HookExecutor)
            this._hooksTable[name].dispatch(catMask, createContext(undefined, this.context), args);
    };

    /**
     * Calls named hook without returning value, ensuring strict category matching -
     * only hook functions with exact categories set will be executed.
     * @param {number} [catMask] categories filter
     * @param {string} name name of hook to call
     * @param {?[]} ...args parameters to pass to hook functions
     */
    runHookStrict(catMask, name, ...args) {
        if (typeof catMask !== "number") {
            if (name !== undefined)
                args.unshift(name);
            name = catMask;
            catMask = -1;
        }
        if (this._hooksTable[name] instanceof HookExecutor) {
            var context = createContext(undefined, this.context);
            context._compareFunc = strictMatchFunc;
            this._hooksTable[name].dispatch(catMask, context, args);
        }
    };

    /**
     * Checks if hook of specific name contains executable functions.
     * @param {number} [catMask] optional category mask to check for hook functions
     * @param {string} name hook name
     * @param {boolean} [strict] use strict category matching
     * @returns {boolean}
     */
    checkTarget(catMask, name, strict) {
        if (typeof catMask !== "number") {
            strict = name;
            name = catMask;
            catMask = -1 | 0;
        }
        if (this._hooksTable[name] instanceof HookExecutor) {
            if (strict) {
                return this._hooksTable[name].checkStrict(catMask);
            } else {
                if (catMask == -1 | 0) return true;
                return this._hooksTable[name].check(catMask);
            }    
        }
    };

    /**
     * Destroys this instance of hook manager.
     * TODO Finish cleanup procedure.
     */
    dispose() {
        if (this._watcher) {
            this._watcher.close();
            this._watcher = null;
        }
    }
}

HookLoader.prototype.CATEGORY_A = 0x1;
HookLoader.prototype.CATEGORY_B = 0x2;
HookLoader.prototype.CATEGORY_C = 0x4;
HookLoader.prototype.CATEGORY_D = 0x8;
HookLoader.prototype.CATEGORY_E = 0x10;
HookLoader.prototype.CATEGORY_F = 0x20;
HookLoader.prototype.CATEGORY_G = 0x40;
HookLoader.prototype.CATEGORY_H = 0x80;
HookLoader.prototype.CATEGORY_I = 0x100;
HookLoader.prototype.CATEGORY_J = 0x200;
HookLoader.prototype.CATEGORY_K = 0x400;
HookLoader.prototype.CATEGORY_L = 0x800;
HookLoader.prototype.CATEGORY_M = 0x1000;
HookLoader.prototype.CATEGORY_N = 0x2000;
HookLoader.prototype.CATEGORY_O = 0x4000;
HookLoader.prototype.CATEGORY_P = 0x8000;
HookLoader.prototype.CATEGORY_Q = 0x10000;
HookLoader.prototype.CATEGORY_R = 0x20000;
HookLoader.prototype.CATEGORY_S = 0x40000;
HookLoader.prototype.CATEGORY_T = 0x80000;
HookLoader.prototype.CATEGORY_U = 0x100000;
HookLoader.prototype.CATEGORY_V = 0x200000;
HookLoader.prototype.CATEGORY_W = 0x400000;
HookLoader.prototype.CATEGORY_X = 0x800000;
HookLoader.prototype.CATEGORY_Y = 0x1000000;
HookLoader.prototype.CATEGORY_Z = 0x2000000;

/**
 * Creates new hook loader using specific directory to search for hook files.
 * @param {string} path base path to search for hook files
 * @param {{}} [options] loader options
 * @param {function(Error)} callback callback function, called when hook loader is ready to be used
 * @returns {HookLoader}
 */
module.exports.create = function(baseDir, options, callback) {
    return new HookLoader(baseDir, options, callback);
}

