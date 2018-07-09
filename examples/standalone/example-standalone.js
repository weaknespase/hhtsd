/*
    This module intended to be used as part of larger application,
    thus it doesn't include standalone runtime by default. Still,
    it's pretty easy to set it up for running and requires only a
    few lines of code.
*/

var fs = require("fs");
var path = require("path");
var hhtsd = require("hhtsd");

var serverConfig = new hhtsd.ServerConfig();

// Listen on all addresses
serverConfig.addrs.push("");

// Add primary site configuration
serverConfig.addSiteConfig(
    new hhtsd.ServerSiteConfig(
        ["foo.bar", "www.foo.bar"],     // Both host names point to the same site, hooks use first one to resolve functions by name.
                                        // There are two special `host names`, "!" (matches empty host) and "*" (matches any host)
                                        // First could be also included if you want to use server ip address as valid hostname for the site,
                                        // later may be used for automatic redirection from invalid hosts.
        
        "Main site",                    //Site description, provided for convenience
        "A"                             //Category is mandatory, but hook functions can be written without it. See lib-hook-async\readme.md, "Category" section for information
    )
);

// Set up directory location to search for content hooks
serverConfig.basedir = path.resolve("./hooks");

// Set up cache size
serverConfig.cacheSize = 1048576;

// Adjust upload limits
serverConfig.uploadMaxStorage = 16 * 1048576;
serverConfig.uploadMaxUnitSize = 1048576;

// Set up TLS options
serverConfig.plaintextPolicy = "upgrade";
serverConfig.secure = new hhtsd.ServerSecureOpts(fs.readFileSync("<serverKey>"), fs.readFileSync("<serverCert>"));

// Create and run server
var server = new hhtsd.Server(serverConfig);
server.start();