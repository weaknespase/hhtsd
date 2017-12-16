# lib-hook-async
<div style="position:relative;top:-1.5em;left:1em">A universal hook library for in-app integration, for nodejs</div>

This library provides easy to use extensible endpoints (hooks) for integration in the application. Each endpoint ultimately contains a list of functions and can be called for result or used as event listener target.

## Basic features
* Automatic hook reloading without application restart
* Three call styles — synchronous, asynchronous and event-listener
* Hook functions chain with priority-based sorting

## Usage example

example.hook.js
```JavaScript
module.exports.hS_callMeForResult = function(){
    return "I'm a synchronous hook function.";
}

module.exports.hA_callMeForResult = function(){
    setTimeout(
        () => {
            this.callback("I'm an asynchronous hook function.");
        },
        100
    );
}

module.exports.hE_onSomethingHappens = function(eventDescription){
    //Event-listener style functions don't return value.
    console.log(eventDescription + " happened.");
}
```

main.js
```JavaScript
var hooks = require("lib-hook-async").create("./hooks", function(err){
    if (err){
        console.log("Hooks initialization error.");
        console.log(err);
    } else {
        //Only synchronous and event-listener style functions will be run
        console.log(hooks.callHookSync("callMeForResult"));
        //All function types will be run and result of last hook returned
        hooks.callHook("callMeForResult", function(result){
            console.log(result);
        });
        hooks.runHook("onSomethingHappens", "End of program");

        setTimeout(function(){
            exit(0)
        }, 1000);
    }
});
```

# Reference

## Hook functions definition file
Any valid CommonJS module named `*.hook.js`. Invalid modules will be rejected at loading stage (for example, if it contains syntax error).

## Hook function
Any exported function named to the following scheme:
```BNF
<hook_function_name> ::= <signature> <function_type> <category_mask> <separator> <hook_name>

<function_type> ::= <synchronous_type> | <asynchronous_type> | <event_type>
<category_mask> ::= {<category_def>}
<synchronous_type> ::= "S"|"s"
<asynchronous_type> ::= "A"|"a"
<event_type> ::= "E"|"e"
<signature> ::= "h"
<separator> ::= "_"
<category_def> ::= "A"|"B"|"C"|"D"|"E"|"F"|"G"|"H"|"I"|"J"|"K"|"L"|"M"|"N"|"O"|"P"|"Q"|"R"|"S"|"T"|"U"|"V"|"W"|"X"|"Y"|"Z"|"a"|"b"|"c"|"d"|"e"|"f"|"g"|"h"|"i"|"j"|"k"|"l"|"m"|"n"|"o"|"p"|"q"|"r"|"s"|"t"|"u"|"v"|"w"|"x"|"y"|"z"
```
All hook functions have access to Context object, which can be accessed using `this` keyword. Context object can be extended by caller to provide additional environment to hooks.

### Synchronous type
This type should be used whenever function itself is synchronous - i.e. not doing any I/O or other asynchronous process, as they are fastest. It should use `return` statement to return any value, if there are any interest in it.

### Asynchronous type
This type reserved for functions that return value asynchronously. A call to `this.callback()` required in order to successfully continue execution and return result to caller.

### Event type
Special type reserved for functions that doesn't return any value. They behave as synchronous functions, but any return value ignored.

### Priority
Each function can have an additional numeric field `priority` that determines its execution order in the chain. Functions with **lower** priority will be executed before.

If function doesn't have this field, or it is set to non-numeric value, it assigned module-wide priority, which specified using `module.exports.priority` property with 0 begin default value. Execution order of functions that have same priority undefined.

### Category
Each function also have a category mask. If no categories specified in the function name, it is assumed to be part of default category (included in all categories), otherwise it takes part in specified categories only.

Default category is special - `callHook` with any category set but default includes all functions within default category, while `callHookStrict` will exclude them all. 

`callHook` with default category set will include all functions in chain, and `callHookStrict` will include only functions from default category.

## Class Options
* `watch` &lt;boolean&gt; — reload all related hooks when hook definition files change, default true
* `recursive` &lt;boolean&gt; — watch for hook file changes in subfolders also, default false

## Class Context
Accessible using `this` from inside and hook function.
* `_lastResult` &lt;any&gt; — return value of previous hook function, `undefined` by default
* `callback` &lt;function(returnValue)&gt; — callback function that must be called from asynchronous hook to call next function in chain

## Class HookLoader

### CATEGORY_A &lt;integer&gt; 
Used as flag in `catMask` bitfield to include or exclude hook functions using categories. There are 26 categories, from A to Z.

### context &lt;Object&gt;
Hook environment accessible using `this` keyword inside of any hook function can be extended by using this property. This object will become a prototype of hook function context of next calls.

Reserved property names that have special meaning and won't be accessible: `callback`, `_lastResult`, `_nextHook`, `_compareFunc`.

### callHook([catMask,] hookName, callback, ...hookArgs)
Asynchronously calls a hook for result.
* `catMask` &lt;integer&gt; — category mask to include hook functions. If function have at least one category from bitmask set, it would be called. Optional
* `hookName` &lt;string&gt; — hook name to call
* `callback` &lt;function(result)&gt; — callback function that will be called with result as first parameter
* `...hookArg` &lt;any&gt; — additional arguments passed to hook functions
If there were no functions to call for target hook, callback invoked with `undefined` value passed as argument.

### callHookSync([catMask,] hookName, ...hookArgs)
Synchronously calls a hook for result, skipping over asynchronous functions.

### callHookStrict([catMask,] hookName, ...hookArgs)
Asynchronously calls a hook for result, using strict category matching. Only functions that have category mask exact same as one passed as `catMask` will be included in chain.

### runHook([catMask,] hookName, ...hookArgs)
Calls hook in event-listener mode. Calling convention will be optimized to return as fast as possible, still respecting calling convention of synchronous hooks.

### runHookStrict([catMask,] hookName, ...hookArgs)
Calls hook in event-listener mode using strict category matching.

### checkTarget([catMask,] hookName[, strict])
Constructs hook chain using provided arguments and returns true if there are at least one function in it.
* `catMask` &lt;integer&gt; — category mask to include hook functions. If function have at least one category from bitmask set, it would be called. Optional
* `hookName` &lt;string&gt; — hook name to check
* `strict` &lt;boolean&gt; — whether to compare category mask using strict mode, false by default

## libHookAsync.create(path, options)
Creates new hook loader instance using specific base directory.
* `path` &lt;string&gt; - path to the base directory where files with hook functions stored.
* `option` &lt;Options&gt; — specific options for modifying hook loader 
behaviour

Returns `HookLoader` class instance that could be used to call hooks.

## Built-in hooks

### onHookModuleChanged(path)
Built-in hook, run in event-listener mode whenever a file with hooks was loaded or reloaded due to change.
* `path` &lt;string&gt; — path to the file that was loaded

# Planned features
* Context switch support between calls.