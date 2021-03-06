/*
 * Copyright (c) 2017, weaknespase
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
 * Hook-based HTTP Server Daemon.
 * Provides simple fastCGI server infrastructure with built-in caching.
 */

var https = require("https");
var http = require("http");
var url = require("url");
var stream = require("stream");
var libhook = require("./lib-hook-async");
var errors = require("./http-errors");
var collections = require("./collections");
var ResponsePrototype = require("./response-proto").ResponsePrototype;
var Socket = require("net").Socket;
var TLSSocket = require("tls").TLSSocket;

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

class ServerSecureOpts {
    /**
     * Creates new configuration for secure server.
     * @param {string} key private key used for TLS connections (PEM format)
     * @param {string} cert certificate used for TLS connections (PEM format)
     * @param {stirng} [ca] optional certificate authorities
     * @param {string} [passphrase] optional passphrase to decrypt certificates and keys in PEM format
     */
    constructor(key, cert, ca, passphrase) {
        /** @type {string} */
        this.key = key;
        /** @type {string} */
        this.cert = cert;
        this.ca = ca;
        /** @type {string} */
        this.passphrase = passphrase;
    }
}

class ServerConfig {
    constructor() {
        /** @type {string[]} */
        this.addrs = [];
        /** @type {number[]} */
        this.ports = [80];
        /** @type {number[]} */
        this.securePorts = [443];
        /** @type {Map<string, HostedSiteConfig>} */
        this.sites = {};

        /** @type {ServerSecureOpts} */
        this.secure = null;
        /** 
         * Describes policy used for plaintext (HTTP) connections. Ignored if HTTPS can't be used.
         * "none" - do nothing
         * "upgrade" - send Upgrade header but allow plaintext connections (Upgrade-Insecure-Requests method)
         * "reject" - send Upgrade header and reject plaintext connections (Upgrade-Insecure-Requests method)
         * @type {"none"|"reject"|"upgrade"}
         */
        this.plaintextPolicy = "none";

        /** Enable error handling for hook functions. Disabling it may be faster but code will require extensive testing. */
        this.safeHooks = true;

        /** Cache size limit for requests caching. */
        this.cacheSize = 4 * MiB;
        /** Maximum amount of data allowed to automatically processed withing POST requests. */
        this.uploadMaxUnitSize = 1 * MiB;
        /** Maximum amount of data allowed to be in-flight for automatic upload processing. */
        this.uploadMaxStorage = 16 * MiB;

        this.basedir = "";
    };
    /**
     * @param {HostedSiteConfig|HostedSiteConfig[]} config 
     */
    addSiteConfig(config) {
        if (Array.isArray(config)) {
            for (var i = 0; i < config.length; i++){
                this.addSiteConfig(config[i]);
            }
        } else if (config instanceof HostedSiteConfig) {
            for (var i = 0; i < config.hosts.length; i++){
                this.sites[config.hosts[i]] = config;
            }
        } else
            throw new Error("Passed config isn't valid.");
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
        var self = this;
        this._started = false;
        this._tls = false;
        this._pendingUploads = 0;
        this._cache = new ResponseCache(0);
        if (config instanceof ServerConfig) {
            let err = config.validate();
            if (err) {
                throw err;
            } else {
                this._config = config;
                this._cache.sizeLimit = this._config.cacheSize;
                var opts = {watch: true, recursive: false};
                if (this._config.safeHooks) opts.safe = true;
                this._iface = libhook.create(this._config.basedir, opts, function(err) {
                    if (err) {
                        throw err;
                    }
                    console.log("Initialized new server instance. Configuration:");
                    var sopts = self._config.secure;
                    self._config.secure = "<hidden>";
                    console.log(require("util").inspect(self._config, false, 5));
                    self._config.secure = sopts;
                });
            }
        } else {
            throw new ValidationError("Config must not be null.");
        }
    };
    start() {
        if (this._started)
            throw new Error("Server already started, stop first.");    
        this._plainServer = [];
        this._secureServer = [];
        //Create plain-text server listening endpoints
        for (var i = 0; i < this._config.ports.length; i++){
            let server = http.createServer(this.__requestHandler.bind(this));
            server.listen(this._config.ports[i], this._config.addrs[0]);
            server.on("listening", function(addr, port) {
                console.log("Started listeneing for HTTP connections on " + addr + ":" + port);
            }.bind(null, this._config.addrs[0], this._config.ports[i]));
            this._plainServer.push(server);
        }
        //Create secure server listening endpoints
        var secureOptions = null;
        if (this._config.secure) {
            if (this._config.secure.key && this._config.secure.cert) {
                secureOptions = {
                    key: this._config.secure.key,
                    cert: this._config.secure.cert
                };
                if (this._config.secure.ca) 
                    secureOptions.ca = this._config.secure.ca;
                if (this._config.secure.passphrase) 
                    secureOptions.passphrase = this._config.secure.passphrase;
            } else {
                console.error("Missing key or certificate chain, can't create HTTPS server.");
            }
        } else {
            console.error("No secure options given, can't create HTTPS server.");
        }
        if (secureOptions) {
            for (var i = 0; i < this._config.securePorts.length; i++) {
                let server = https.createServer(secureOptions, this.__requestHandler.bind(this));
                server.listen(this._config.securePorts[i], this._config.addrs[0]);
                server.on("listening", function(addr, port) {
                    console.log("Started listeneing for HTTPS connections on " + addr + ":" + port);
                }.bind(null, this._config.addrs[0], this._config.securePorts[i]));
                this._secureServer.push(server);
            }
            this._tls = true;
        }    
        this._started = true;
    };
    stop() {
        if (this._started) {
            for (var i = 0; i < this._plainServer.length; i++){
                this._plainServer[i].close();
            }
            for (var i = 0; i < this._secureServer.length; i++){
                this._secureServer[i].close();
            }
            this._started = false;
            this._tls = false;
        }
    };
    isRunning() {
        return this._started;
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
        request.__sts = process.hrtime(request.__sts);
        request.__gts = process.hrtime();
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

        var catmask = 1 << (site.category.toUpperCase().charCodeAt(0) - 65);

        //Check cache for cached response object
        var rid = site.hosts[0] + "$" + request.url;
        var rproto = this._cache.retv(rid);
        if (rproto) {
            //Found something ()
            this.__handleHookResponse(request, response, site, site.hosts[0] + "$" + target, null, rproto);
        } else {
            if (target.length > 0 && this._iface.checkTarget(catmask, site.hosts[0] + "$" + target)) {
                //Run uri hook
                //Hook args: params, headers, data (site already here)
                this._iface.callHook(catmask, site.hosts[0] + "$" + target, this.__handleHookResponse.bind(this, request, response, site, site.hosts[0] + "$" + target), params, request.headers, data);
            } else if (this._iface.checkTarget(catmask, site.hosts[0] + "$")) {
                //Run generic hook
                //Hook args: uri, params, header, data
                this._iface.callHook(catmask, site.hosts[0] + "$", this.__handleHookResponse.bind(this, request, response, site, site.hosts[0] + ">" + target), target, params, request.headers, data);
            } else {
                errors.sendSimpleResponse(response, 404);
            }
        }    
    };
    /**
     * @param {*} request 
     * @param {*} response
     * @param {HostedSiteConfig} site
     * @param {string} target target hook name
     * @param {Error} error error occurred while executing hook functions
     * @param {ResponsePrototype} responseProto 
     */
    __handleHookResponse(request, response, site, target, error, responseProto) {
        if (responseProto) {
            if (responseProto.error instanceof Error) {
                console.error(
                    "Error occurred while serving request for " + site.hosts[0] + ":" + request.url + "\n" +
                    "Client: " + JSON.stringify(request.socket.address()) + "\n" +
                    "Cause: " + responseProto.error.__proto__.name + ": " + responseProto.error.message + "\n" + 
                    "ReportedBy: [Hook] " + target
                );
                errors.sendSimpleResponse(response, 500);
            } else if (typeof responseProto.status == "number") {
                if (responseProto.status >= 100 && responseProto.status < 600) {
                    var cacheable = true;
                    response.statusCode = responseProto.status;
                    response.statusMessage = errors.getStatusMessage(responseProto.status);
                    if (responseProto.headers) {
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
                    if (responseProto.data || responseProto.data == null) {
                        if (typeof responseProto.entityTag == "string") {
                            response.setHeader("ETag", responseProto.entityTag);
                            if (typeof responseProto.maxAge == "number") {
                                response.setHeader("Cache-Control", "max-age=" + responseProto.maxAge + ", must-revalidate");
                            }
                        } else cacheable = false;
                        if (typeof responseProto.dataType == "string") {
                            try {
                                response.setHeader("Content-Type", responseProto.dataType);
                            } catch (e) {
                                console.log("Hook " + target + " field 'dataType' contains invalid value.");
                                console.log("\t" + responseProto.dataType);
                                response.setHeader("Content-Type", "application/octet-stream");
                            }
                        } else {
                            response.setHeader("Content-Type", "application/octet-stream");
                        }
                        if (typeof responseProto.data == "string") {
                            //Convert string to Buffer using utf8 encoding
                            responseProto.data = Buffer.from(responseProto.data, "utf8");
                        }
                        request.__gts = process.hrtime(request.__gts);
                        response.setHeader("X-GMetrics", Math.round(request.__sts[0] * 1e9 + request.__sts[1]) / 1000 + "us, " + Math.round(request.__gts[0] * 1e9 + request.__gts[1]) / 1000 + "us");
                        if (responseProto.data instanceof Buffer || responseProto.data instanceof Uint8Array) {
                            response.setHeader("Content-Length", responseProto.data.byteLength);
                            response.end(responseProto.data);
                        } else if (responseProto.data instanceof stream.Readable) {
                            cacheable = false;
                            if (typeof responseProto.dataLength == "number" && responseProto.dataLength > 0)
                                response.setHeader("Content-Length", responseProto.dataLength);    
                            responseProto.data.pipe(response);
                        } else {
                            //Using null is permitted to notify that standard error page is welcome
                            if (responseProto.data != null)
                                console.log("Hook " + target + " field 'data' contains response data in invalid format.");
                            response.removeHeader("Content-Type");
                            response.removeHeader("ETag");
                            response.removeHeader("Cache-Control");
                            cacheable = false;
                            errors.sendSimpleResponse(response, responseProto.status);
                        }

                        if (cacheable) {
                            this._cache.stor(site.hosts[0] + "$" + request.url, responseProto, responseProto.data.length, Date.now() + responseProto.maxAge * 1000);
                        }
                    } else {
                        //Response contains no data
                        request.__gts = process.hrtime(request.__gts);
                        response.setHeader("X-GMetrics", Math.round(request.__sts[0] * 1e9 + request.__sts[1]) / 1000 + "us, " + Math.round(request.__gts[0] * 1e9 + request.__gts[1]) / 1000 + "us");
                        response.end();
                    }
                } else {
                    //Illegal response status code
                    console.error("Hook " + target + " responded with illegal HTTP status code (" + responseProto.status + ")");
                    errors.sendSimpleResponse(response, 500);
                }
            } else if (typeof responseProto.manual == "string") {
                //Manual request processing
                if (responseProto.manual.length > 0 && this._iface.checkTarget(responseProto.manual)) {
                    this._iface.runHook(responseProto.manual, request, response, responseProto);
                } else {
                    console.error("Hook " + target + " requested manual mode, delgating to the non-existing target [" + responseProto.manual + "].");
                    errors.sendSimpleResponse(response, 502);
                }
            }
        } else if (error instanceof Error) {
            console.error("Hook " + target + " encountered an error while running", error);
            errors.sendSimpleResponse(response, 502);
        } else {
            console.error("Hook " + target + " didn't return valid response prototype");
            errors.sendSimpleResponse(response, 500);
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
        var host = request.headers["host"];
        request.__sts = process.hrtime();

        //Error handling of response
        response.on("error", function(err) {
            console.error(
                "Error occurred while serving request for " + host + ":" + request.url + "\n" +
                "Client: " + JSON.stringify(request.socket.address()) + "\n" +
                "Cause: " + err.__proto__.name + ": " + err.message + "\n" + 
                "ReportedBy: [Server]"
            );
        })

        //Upgrade insecure requests (if TLS is available)
        if (this._tls) {
            if (!(request.socket instanceof TLSSocket)) {
                if ((request.headers["upgrade-insecure-requests"] == "1" && this._config.plaintextPolicy == "upgrade") || this._config.plaintextPolicy == "reject") {
                    //Redirect user
                    response.statusCode = (request.method == "GET" || request.method == "HEAD") ? 301 : 308;
                    response.statusMessage = errors.getStatusMessage(response.statusCode);
                    response.setHeader("Location", "https://" + host + request.url);
                    response.setHeader("Vary", "Upgrade-Insecure-Requests");
                    response.setHeader("Content-Type", "text/html");
                    response.end("Click on the following link if your browser doesn't follow it automatically.<br><a href=\"https://" + host + encodeURI(request.url) + "\">https://" + host + request.url.replace(/</g, "&lt;") + "</a>");
                    return;
                }
            }
        }

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
                case "OPTIONS": {
                    //FIXME Use this method to upgrade to TLS connection (old rfc method)
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
            //Site configuration wasn't found, break connection
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

module.exports.Server = ServerInstance;
module.exports.ServerConfig = ServerConfig;
module.exports.ServerSiteConfig = HostedSiteConfig;
module.exports.ServerSecureOpts = ServerSecureOpts;