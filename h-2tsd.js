/**
 * Hook-based HTTP Server Daemon.
 *
 * Provides simplistic server-side fastCGI infrastructure, extensible using dynamic page generation modules.
 */

 /*
    Arch:

    1. Feture-compatible with previous iteration of the server
    2. HTTP and HTTPS support required
    3. Automatic request handlers:
        1. Content generation
        2. Caching support
        3. HTTP/2 queuing support
    4. Manual request handlers:
        1. Server Sent Events support must be possible
    5. Infrastructure:
        1. Certificate-based auth
        2. Built-in session support
        3. Configurable using external file
 */

var https = require("https");
var http = require("http");
var url = require("url");
var stream = require("stream");
var libhook = require("./lib-hook-async");
var errors = require("./http-errors");
var collections = require("./collections");
var ResponsePrototype = require("./h-2tsd-response-proto").ResponsePrototype;

var KiB = 1024;
var MiB = 1048576;

class ValidationError extends Error{
    constructor(message) {
        super(message);
    }
}

class HostedSiteConfig {
    /**
     * @param {string|string[]} hostname domain names for the site
     * @param {string} description human-friendly site description
     * @param {string} category one-letter category used in hook functions
     * @param {Object} [context] optional object used as context for hook functions, useful for sharing persistent data
     */
    constructor(hostname, description, category) {
        //Hosted sites use different categories to resolve hooks
        if (Array.isArray(hostname))
            this.hosts = hostname;
        else
            this.hosts = [hostname];
        this.description = description;
        this.category = category;
    };
    validate() {
        if (this.hosts.length == 0)
            return new ValidationError("At least one host name must be defined");
        if (typeof this.category != "string" || !(/^A-Z$/.test(this.category)))
            return new ValidationError("Illegal category specified: " + this.category);    
        return null;
    }
}

class ServerConfig {
    constructor() {
        this.addrs = ["0.0.0.0"];
        this.ports = [80];
        this.securePorts = [443];
        /** @type {Map<string, HostedSiteConfig>} */
        this.sites = {};

        /** Cache size limit for requests caching. */
        this.cacheSize = 4 * MiB;
        /** Maximum amount of data allowed to automatically processed withing POST requests. */
        this.uploadMaxUnitSize = 1 * MiB;
        /** Maximum amount of data allowed to be in-flight for automatic upload processing. */
        this.uploadMaxStorage = 16 * MiB;

        this.basedir = "";
    };
    validate() {
        if (this.addrs.length == 0)
            return new ValidationError("At least one address to bind to must be specified");
        return null;
    }
}

class ServerInstance {
    /**
     * Constructs new server instance using specified config.
     * @param {ServerConfig} config 
     */
    constructor(config) {
        this._pendingUploads = 0;
        this._cache = new ResponseCache(0);
        if (config instanceof ServerConfig) {
            let err = config.validate();
            if (err) {
                throw err;
            } else {
                this._config = config;
                this._cache.sizeLimit = this._config.cacheSize;
                this._iface = libhook.create(this._config.basedir, function(err) {
                    if (err) {
                        throw err;
                    }
                    console.log("Initialized new server instance. Configuration:");
                    console.log(require("util").inspect(this._config, false, 5));
                });
            }
        } else {
            throw new ValidationError("Config must not be null.");
        }
    };
    start() {
        this._plainServer = [];
        this._secureServer = [];
        //Create plain-text server listening endpoints
        for (var i = 0; i < this._config.ports.length; i++){
            this._plainServer.push(http.createServer(this.__requestHandler.bind(this)));
        }
        //Create secure server listening endpoints
        for (var i = 0; i < this._config.securePorts.length; i++){
            this._secureServer.push(http.createServer(function(request, response) {
                
            }));
        }
    };
    stop() {
        
    };
    /**
     * Searches for site configuration using host name.
     * @param {string} host
     * @returns {HostedSiteConfig}
     */
    __matchSiteForHost(host) {
        if (typeof host != "string" || host == "") {
            var out = this._config.sites["!"];
            if (out) return out;
            return this._config.sites["*"];
        } else {
            var out = this._config.sites[host];
            if (out) return out;
            return this._config.sites["*"];
        }
    };
    /**
     * Runs hooks for valid requests and finishes request handling.
     * @param {*} request
     * @param {*} response 
     * @param {HostedSiteConfig} site
     * @param {Buffer} data
     * @param {Map<string, string>} params 
     */
    __runExternalRequestHandler(request, response, site, data, params) {
        var uri = url.parse(request.url, true);
        var target = uri.path.substr(1);
        var params2 = uri.query;
        if (params) {
            for (var i in params2)
                if (Object.hasOwnProperty.call(params2, i))
                    params[i] = params2[i];    
        } else {
            params = params2;
            if (!params) params = {};
        }

        var catmask = 2 >> (site.category.toUpperCase().charCodeAt[0] - 65);

        //Check cache for cached response object
        var rid = site.hosts[0] + "$" + request.url;
        var rproto = this._cache.retv(rid);
        if (rproto) {
            //Found something ()
            this.__handleHookResponse(request, response, rid, rproto);
        } else {
            if (this._iface.checkTarget(catmask, site.hosts[0] + "$" + target)) {
                //Run uri hook
                //Hook args: params, headers, data (site already here)
                this._iface.callHook(catmask, site.hosts[0] + "$" + target, this.__handleHookResponse.bind(this, request, response, site.hosts[0] + "$" + target), params, request.headers, data);
            } else if (this._iface.checkTarget(catmask, site.hosts[0] + "$")) {
                //Run generic hook
                //Hook args: uri, params, header, data
                this._iface.callHook(catmask, site.hosts[0] + "$", this.__handleHookResponse.bind(this, request, response, site.hosts[0] + ">" + target), target, params, request.headers, data);
            } else {
                request.end();
                errors.sendSimpleResponse(response, 404);
            }
        }    
    };
    __handleHookResponse(request, response, target, responseProto) {
        if (responseProto) {
            if (typeof responseProto.status == "number") {
                if (responseProto.status >= 100 && responseProto.status < 600) {
                    var cacheable = true;
                    if (responseProto.headers){
                        for (var i in responseProto.headers) {
                            if (Object.hasOwnProperty.call(responseProto.headers, i)) {
                                try {
                                    response.setHeader(i, responseProto.headers[i]);
                                } catch (e) {
                                    console.log("Hook " + target + " header " + i + " contains invalid value.");
                                    console.log("\t" + responseProto.headers[i]);
                                }
                            }
                        }
                    }
                    if (typeof responseProto.dataType == "string") {
                        try {
                            response.setHeader("Content-Type", responseProto.dataType);
                        } catch (e) {
                            console.log("Hook " + target + " field 'dataType' contains invalid value.");
                            console.log("\t" + responseProto.dataType);
                            response.setHeader("Content-Type", "application/octet-stream");
                        }
                    }
                    if (typeof responseProto.cacheTag == "string") {
                        //Resource could be cached
                        response.setHeader("ETag", responseProto.cacheTag);
                    } else cacheable = false;

                    if (typeof responseProto.data == "string") {
                        

                    } else if (responseProto.data instanceof stream.Readable) {
                        cacheable = false;
                        //Streams are dynamic and can't be used in static cache

                        //Chunked encoding
                    } else if (typeof responseProto.data == "object" && responseProto.data.length) {

                    }
                                
                    /*
                    Response is cacheable if:
                    1. ETag'ed
                    2. Don't have data or data is not streamed
                    */

                            //Now including complex logic of handling conditional requests
                    var condition;
                    if (condition = request.headers["if-match"]) {
                        //Send only matching Etag

                    } else if (condition = request.headers["if-none-match"]) {
                        //Send only unmatching Etag

                    } else {
                        //No conditionals, send full response

                    }


                } else {
                    //Illegal response status code
                    console.error("Hook " + target + " responded with illegal HTTP status code (" + responseProto.status + ")");
                }
            } else if (typeof responseProto.manual == "string") {
                //Manual request processing
                console.error("Hook " + target + " requested manual mode, which is not implemented");
                errors.sendSimpleResponse(response, 500);
            }
        } else {
            console.error("Hook " + target + " didn't return valid response prototype");
            errors.sendSimpleResponse(response, 500);
        }

        var example_hook_response = {
            status: 200,
            dataType: "text",
            data: Buffer.alloc(100),
            headers: {
                "Set-Cookie": "lalalal"
            },
        
            cacheTag: "string",
            cacheAge: 1000,
        
            manual: "target_hook"
        }

    };
    /**
     * Handles requests with non-zero request body.
     * @param {*} request
     * @param {*} response
     * @param {HostedSiteConfig} site
     */
    __requestDataHandler(request, response, site) {
        var size = -1;
        var self = this;
        if (request.headers["content-length"])
            size = parseInt(request.headers["content-length"]);
        
        //Check "Content-Length" field for preliminary reject
        if (size > 0 && size > this._config.uploadMaxUnitSize) {
            request.destroy();
            errors.sendSimpleResponse(response, 406);
        } else {
            let dlen = 0;
            if (request.headers["content-type"] == "application/x-www-form-urlencoded") {
                request.setEncoding("utf8");
                let data = "";
                request.on("data", function(chunk) {
                    //Checking for total size limitation
                    if (self._pendingUploads + chunk.length > self._config.uploadMaxStorage) {
                        console.error("Client " + request.socket.remoteAddress + " at " + request.socket.remotePort + " reached maximum request size limit");
                        request.destroy(new Error("Maximum request size limit reached."));
                    } else {
                        data += chunk;
                        self._pendingUploads += chunk.length;
                        dlen += chunk.length;
                    }
                });
                request.on("end", function() {
                    var params = url.parse("?" + data);
                    self._pendingUploads -= dlen;
                    self.__runExternalRequestHandler(request, response, site, null, params);
                });
                request.on("error", function() {
                    errors.sendSimpleResponse(response, 406);
                    self._pendingUploads -= dlen;
                });
                request.on("aborted", function() {
                    errors.sendSimpleResponse(response, 500);
                    self._pendingUploads -= dlen;
                });
            } else {
                let data = [];
                request.on("data", function(chunk) {
                    if (self._pendingUploads + chunk.length > self._config.uploadMaxStorage) {
                        console.error("Client " + request.socket.remoteAddress + " at " + request.socket.remotePort + " reached maximum request size limit");
                        request.destroy(new Error("Maximum request size limit reached."));
                    } else {
                        data.push(chunk);
                        self._pendingUploads += chunk.length;
                        dlen += chunk.length;
                    }
                });
                request.on("end", function() {
                    data = Buffer.concat(data);
                    self._pendingUploads -= dlen;
                    self.__runExternalRequestHandler(request, response, site, data);
                });
                request.on("error", function() {
                    errors.sendSimpleResponse(response, 406);
                    self._pendingUploads -= dlen;
                });
                request.on("aborted", function() {
                    errors.sendSimpleResponse(response, 500);
                    self._pendingUploads -= dlen;
                });
            }
        }
    };
    __requestHandler(request, response) {
        /*
        Flow:
        *1. Parse URI for PATH and QUERY
        *2. Grab DOMAIN from host field
        *3. Search for registered DOMAIN in the config.sites
        4. Get category association with domain
        *5. Fetch POST data for request if any
        *6. Parse QUERY into params object
        7. Check hooks for URI
        8. Call hook for URI or generic hook (again if exists)
        9. Grab execution results
        */

        //Including cache subsystem
        //If request came for exact same uri, and is GET/HEAD, we allowed to use cache
        //On the other hand we're waiting for request to be processed fully, resolved up to the target

        //Parse URI
        var host = request.headers["host"];

        //Find site configuration
        var site = this.__matchSiteForHost(host);
        if (site) {
            switch (request.method) {
                case "HEAD":
                case "GET": {
                    //We got everything already
                    request.resume();
                    this.__runExternalRequestHandler(request, response, site, null);
                    break;
                }
                case "POST": {
                    this.__requestDataHandler(request, response, site);
                    break;
                }
                default: {
                    //Unsupported method
                    request.resume();
                    errors.sendSimpleResponse(response, 405);
                    break;
                }
            }
        } else {
            //Site configuration wasn't found, break the connection
            request.resume();
            response.socket.destroy();
        }
    };
}

class ResponseCacheItem {
    /**
     * @param {ResponsePrototype} data 
     */
    constructor(data) {
        this.data = data;
        this.size = 0;
        this.id = "";
        this.expire = 0;
        this.link = null;
    }
}

class ResponseCache {
    constructor(limit) {
        this.size = 0;
        this.sizeLimit = limit;
        /** @type {Map<string, ResponseCacheItem>} */
        this._map = {};
        this._lru = new collections.LinkedList();
    };
    /**
     * Retrieves cached ResponsePrototype.
     * Automatically invalidates expired entries on access.
     * @param {string} id id of response
     * @returns {ResponsePrototype}
     */
    retv(id) {
        var x = this._map[id];
        if (x instanceof ResponseCacheItem) {
            if (x.expire < Date.now()) {
                //Purge item from cache
                this.size -= x.size;
                delete this._map[id];
                this._lru.remove(x.link);
                return undefined;
            } else {
                this._lru.remove(x.link);
                this._lru.insert(x.link);
                return x.data;
            }    
        }
        return undefined;
    };
    /**
     * Stores (or updates) response in the cache.
     * @param {string} id unique response id
     * @param {ResponsePrototype} data response data
     * @param {number} size size in bytes of response payload
     * @param {number} expires timestamp in the future when response becomes invalid
     */
    stor(id, data, size, expires) {
        var x = this._map[id];
        if (x instanceof ResponseCacheItem) {
            x.data = data;
            this.size += size - x.size;
            x.size = size;
            x.expire = expires;
        } else {
            x = new ResponseCacheItem(data);
            x.size = size;
            x.id = id;
            x.expire = expires;
            this.size += size;
            x.link = this._lru.insert(id);
            this._map[id] = x;
        }
        if (this.sizeLimit > 0) {
            while (this.size > this.sizeLimit) {
                var i = this._lru.tail();
                if (i) {
                    x = this._map[i.value];
                    if (x) {
                        this.size -= x.size;
                        delete this._map[i.value];
                    }
                    this._lru.remove(i);
                } else break;    
            }
        }    
    };
}

function hAW_$something() {
    
}

module.exports.Server = ServerInstance;
module.exports.ServerConfig = ServerConfig;
module.exports.ServerSiteConfig = HostedSiteConfig;

/**
 *
 * Hook interface:
 *  hook functions named using following schema:
 *   h[AS][A-Z]+_$<uri-without-leading-slash>
 *  handlers for uri that contains unicode chars can be specified using bracket notation
 *   module.exports["hS_$some/file/on/server"]
 * There are two hook types for handlers:
 *  Named endpoint hook and default endpoint hook.
 *  Named endpoint hook services all requests that specify matching uri, while default endpoint hook services all requests that doesn't have dedicated handler
 *  Query params (from POST or GET), method name and post data (optional) passed using hook argument (not context)
 *
 *  Hooks can work in 2 modes:
 *   Full-auto and manual
 *  In automatic mode they required to produce a stream with static contents, readable at server side.
 *  In manual mode they will be passes response handle for full response control.
 *  Latter useful for special communication modes, like SSE or websocket (?)
 *  
 */