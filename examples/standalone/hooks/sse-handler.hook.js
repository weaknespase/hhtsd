/*
    Example hook: Server-Sent-Events support
*/

var incrementalId = 0x1000;
var eventListeners = Object.create(null);
var visitors = 0;

//Reset visitors count each hour
setInterval(function resetVisitors() {
    visitors = 0;
}, 3600000);

function sendEvent(event, data) {
    if (typeof data == "object") {
        data = JSON.stringify(data);
    }
    if (data) {
        for (var i in eventListeners) {
            eventListeners[i].write("event:" + event + "\n");
            eventListeners[i].write("data:" + data + "\n\n");
        }
    } else {
        for (var i in eventListeners) {
            eventListeners[i].write("event:" + event + "\ndata:\n\n");
        }
    }
}

function sendEventSingle(target, event, data) {
    if (typeof data == "object") {
        data = JSON.stringify(data);
    }
    if (data) {
        target.write("event:" + event + "\ndata:" + data + "\n\n");
    } else {
        target.write("event:" + event + "\ndata:\n\n");
    }
}

module.exports["hS_foo.bar$events"] = function(target, params, headers, data) {
    return {
        manual: "xSubscribeForEvents"
    };
}

module.exports.hS_xSubscribeForEvents = function(request, response) {
    response.writeHead(200, {
        "Content-Type": "text/event-stream"
    });
    response.on("error", function(err) {
        delete eventListeners[this.metaId];
    });
    response.on("end", function() {
        delete eventListeners[this.metaId];
    });
    response.metaId = (incrementalId++).toString(16);
    eventListeners[response.metaId] = response;
    sendEventSingle(response, "hello");
}

/*
    This is an example of event that originates outside of server.
    As server can be part of a larger program, it can use hooks library to define its own events.
    Note category usage to avoid unintended namespace collision between http and external hooks.
*/
module.exports.hEX_externalEvent = function() {
    sendEvent("event", "someone wanted an event");
}

/*
    You can do pretty much almost everything with hooks, even if it is not exactly content-related.
    Here an example of visitor counting with notification and content injection.
*/
module.exports["hS_foo.bar$index.html"] = function(target, params, headers, data) {
    sendEvent("new-visit", ++visitors);
    if (this._lastResult && this._lastResult.status == 200 && typeof this._lastResult.data == "string") {
        this._lastResult.data = this._lastResult.data.replace("$visitors_count$", visitors);
    }
    return this._lastResult;
}
module.exports["hS_foo.bar$index.html"].priority = 3;