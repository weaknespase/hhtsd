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

const types = {
    "html": "text/html",
    "htm": "text/html",
    "png": "image/png",
    "svg": "image/svg+xml",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "gif" : "image/gif",
    "json": "application/json",
    "js": "application/javascrtipt",
    "css": "text/css",
    "xml": "application/xml"
}

module.exports.get = function(extension) {
    if (extension[0] == ".")
        extension = extension.substr(1);
    var mime = types[extension];
    if (!mime)
        return "application/octet-stream";
    return mime;
}