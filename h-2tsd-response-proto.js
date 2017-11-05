/**
 * This module defines easy to use constructor for ResponsePrototype, used by hook functions to create
 * automatically handled responses.
 */

class ResponsePrototype {
    constructor() {
        /** Response HTTP status code */
        this.status = 0;

        /**
         * Response data. Can be string, Buffer, Uint8Array or any implementation of ReadableStream.
         * Note that response can't be cached automatically if ReadableStream is used.
         * @type {Buffer|Uint8Array|String}
         */
        this.data = null;

        /**
         * Response mime type, ignored if response contains no data to send.
         * @type {string}
         */
        this.dataType = undefined;

        /**
         * Additional headers to set with response. Can be used, for example, to set cookies.
         * @type {Map<string, string>}
         */
        this.headers = {};
        
        /**
         * Unique entity tag, used in conjunction with cache system. Required in order to response be cacheable.
         * @type {string}
         */
        this.entityTag = undefined;

        /**
         * Maximum age of resource before expiring. Counted from point of generations, meaningless if entityTag is undefined.
         * @type {number}
         */
        this.maxAge = 300;

        /**
         * Instructs server to delegate processing of request to specific implementation of response handler.
         * After that it's hook responsibility to correctly form and send HTTP response to the client. Can be used, for example,
         * to setup connection for Server Sent Event or other non-standard communication protocol losely based on HTTP.
         * @type {string}
         */
        this.manual = undefined;
    }
}

module.exports.ResponsePrototype = ResponsePrototype;