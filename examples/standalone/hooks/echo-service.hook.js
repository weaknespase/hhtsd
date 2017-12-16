/*
 * Example hook: Echo
 */

module.exports["hS_foo.bar$"] = function(target, params, headers, data) {
    // Following is hook chaining example - if previous functions haven't found any content to send, we will send a simple echo - repeat resource URI to the user
    if (this._lastResult && this._lastResult.status < 300) {
        return this._lastResult;
    } else {
        var r = {};
        r.status = 200;
        r.dataType = "text/html; charset=utf-8";
        r.data = Buffer.from("<div style='font-family: monospace;width:50%;margin:auto;text-align:center'>There are nothing to look for at <span style='color: blue'>/" + target + "</span> at this moment :(");
        r.entityTag = Math.floor(Math.random() * 1e14) + 1e15;
        r.maxAge = 600;
        return r;
    }    
}

module.exports["hS_foo.bar$"].priority = 5;   //Get this function to execute last (see lib-hook-async docs)