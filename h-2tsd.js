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
var libhook = require("./lib-hook-async");
var url = require("url");

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
        this.sites = new Map();

        /** Cache size limit for requests caching. */
        this.cacheSize = 4 * MiB;
        /** Maximum amount of data allowed to automatically processed withing POST requests. */
        this.uploadMaxUnitSize = 1 * MiB;
        /** Maximum amount of data allowed to be in-flight for automatic upload processing. */
        this.uploadMaxStorage = 16 * MiB;
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
        if (config instanceof ServerConfig) {
            let err = config.validate();
            if (err) {
                throw err;
            } else {
                this._config = config;
                /* TODO Reorganize sites inside configuration for easier access to templates */
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
    __requestHandler(request, response) {
        /*
        Flow:
        1. Parse URI for PATH and QUERY
        2. Grab DOMAIN from host field
        3. Search for registered DOMAIN in the config.sites
            (* matches any unknown domain, ! matches only requests without domains)
        4. Get category association with domain
        5. Fetch POST data for request if any
        6. Parse QUERY into params object
        7. Check hooks for URI
        8. Call hook for URI or generic hook (again if exists)
        9. Grab execution results
        */

        //Including cache subsystem
        //If request came for exact same uri, and is GET/HEAD, we allowed to use cache

        //Parse URI
        var uri = url.parse(request.url, true);
        var target = uri.path.substr(1);
        var params = uri.query;
        var host = request.headers["host"];
        if (!params) params = {};

        //Find site configuration
        var site = this.__matchSiteForHost(host);
        if (site) {
            var bskip = false;
            switch (request.method) {
                case "HEAD": {
                    bskip = true;
                }
                case "GET": {
                    //We got everything already
                    request.resume();
    
                    break;
                }
                case "POST": {
    
                    break;
                }
            }
        } else {
            //Site configuration isn't found
        }


        
        
        var uri = url.parse(request.url, true);
        var hookTarget = uri.pathname.substr(1);
        var params = uri.query;
        if (!params) params = {};
        var buffer = null;
        if (request.method == "POST") {
            //Read request body
            if (request.headers["content-type"] == "application/x-www-form-urlencoded") {
                request.setEncoding("utf8");
                buffer = "";
                request.on("data", function(chunk) {
                    buffer += chunk;
                });
                request.on("end", function() {
                    var params2 = url.parse("?" + buffer);
                    for (var i in params2.query) {
                        if (Object.hasOwnProperty.call(params2.query, i)) {
                            params[i] = decodeURIComponent(params2.query[i]);
                        }
                    }
                    delegateTo(hookTarget, params, { method: "POST" }, response);
                });
                request.on("aborted", function() {
                    response.end();
                });
            } else {
                request.on("data", function(chunk) {
                    if (!buffer) {
                        buffer = chunk;
                    } else {
                        buffer = Buffer.concat([buffer, chunk]);
                    }
                    if (buffer.length > MAX_POSTDATA_LENGTH) {
                        request.destroy();
                    }
                });
                request.on("end", function() {
                    delegateTo(hookTarget, params, { method: "POST", postData: buffer }, response);
                });
                request.on("aborted", function(err) {
                    //Drop connections
                    response.end();
                });
            }
        } else if (request.method == "GET") {
            request.resume();
            delegateTo(hookTarget, params, { method: "GET" }, response);
        } else if (request.method == "HEAD") {
            request.resume();
            delegateTo(hookTarget, params, { method: "HEAD" }, response);
        } else if (request.method == "BREW" || request.method == "PROPFIND" || request.method == "WHEN") {
            request.resume();
            writeErrorResponse(418, response);
        } else {
            request.resume();
            writeErrorResponse(501, response);
        }
    };
}

class ResponseCache {
    constructor() {
        
    };
    fetch(id) {
        
    };
}

function hAW_$something() {
    
}

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