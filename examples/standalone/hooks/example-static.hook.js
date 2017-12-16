/*
 * Example hook: Static content
 */

var path = require("path");
var fs = require("fs");
var crypto = require("crypto");
var mime = require("./mime-types");

var USE_DEFAULT_FILE_NAME = true;
var USE_SERVER_CACHE = true;

var READBACK_ENTRY_SIZE = 256 * 1024;
var MAX_SIMULTANEOUS_STREAMS = 5;
var DEFAULT_FILE_NAME = "index.html";
var FILES_ROOT = path.resolve(path.dirname(module.filename), "../static");

var activeStreams = 0;

function hashString(str) {
    var hash = crypto.createHash("sha1");
    hash.update(str);
    return hash.digest().toString("base64");
}

// Asynchronous hook example - reading static content from disk
module.exports["hA_foo.bar$"] = function(target, params, headers, data) {
    var response = {};
    if (target.length == 0 || target[target.length-1] == "/") {
        if (USE_DEFAULT_FILE_NAME) {
            target += DEFAULT_FILE_NAME;
        } else {
            response.status = 404;
            process.nextTick(() => { this.callback(response) });
            return;
        }
    }
    var file = path.resolve(FILES_ROOT, target);
    if (file.indexOf(FILES_ROOT) < 0) {
        //Resolved outside of root
        response.status = 404;
        process.nextTick(() => { this.callback(response) });
        return;
    } else {
        fs.stat(file, (err, stats) => {
            if (err) {
                response.status = 404;
                response.data = null;
            } else {
                if (stats.isDirectory()) {
                    response.status = 204;      //No content response
                    response.data = null;
                } else {
                    if (activeStreams < MAX_SIMULTANEOUS_STREAMS) {
                        response.entityTag = hashString(file + "|" + stats.mtime + "|" + stats.size + "|" + stats.ino);
                        response.maxAge = 6000;
                        response.dataType = mime.get(path.extname(file));
                        response.dataLength = stats.size;
                        activeStreams++;
                        if (USE_SERVER_CACHE && stats.size < READBACK_ENTRY_SIZE) {
                            //Read file and respond with buffer to make use of server cache system
                            fs.readFile(file, (err, data) => {
                                if (err) {
                                    //Propagate error to the server for standard error handling
                                    response.error = err;
                                } else {
                                    response.status = 200;
                                    response.data = data;
                                }
                                activeStreams--;
                                this.callback(response);
                            });
                            return;
                        } else {
                            //Send the stream to the server, streams aren't cacheable
                            let stream = fs.createReadStream(file);
                            stream.on("end", function() {
                                activeStreams--;
                            });
                            response.status = 200;
                        }
                    } else {
                        response.status = 429;
                        response.data = null;
                    }
                }
            }
            this.callback(response);
        });
    }
}