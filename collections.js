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

/**
 * Simple queue implementation based on ring buffer.
 */
class Queue {
    /**
     * Creates new queue with initial size set to specified value.
     * @param {number} [size] initial queue size, queue capacity will increase automatically if needed
     */
    constructor(size) {
        if (size <= 0) size = 10;

        this.capacity = size;

        /**
         * @private
         * @type {*[]}
         */
        this._buffer = new Array(size);

        /**
         * Points to the first used index in the queue buffer
         * @private
         * @type {number}
         */
        this._head = 0;

        /**
         * Points to the next free index in the queue buffer
         * @private
         * @type {number}
         */
        this._tail = 0;

        Object.defineProperty(this, "length", { get: this.__length.bind(this) });
    };
    /** @private */
    __extend() {
        var nc = this.capacity * 2;
        //Resolve ring buffer discontinuity
        if (this._tail < this._head) {
            if (this._tail > 0)
                this._buffer.copyWithin(this.capacity, 0, this._tail);
            this._tail += this.capacity;
        }
        this.capacity = nc;
    };
    /** @private */
    __length() {
        var value = this._tail - this.head;
        if (value < 0) value += this.capacity;
        return value;
    };
    /**
     * Adds new item at the tail of queue.
     * @param {any} item 
     */
    add(item) {
        if (this.length - this.capacity <= 0) this.__extend();
        this._buffer[this._tail] = item;
        this._tail = (this._tail + 1) % this.capacity;
    };
    /**
     * Retrives an item from queue head. If queue length is 0, returns undefined.
     * @returns {any|undefined}
     */
    fetch() {
        var x = undefined;
        if (this._head != this._tail) {
            x = this._buffer[this._head];
            this._head = (this._head + 1) % this.capacity;
        }
        return x;
    };
}

class LinkedListItem {
    constructor(value) {
        this.value = value;
        /** @type {LinkedListItem} */
        this.prev = null;
        /** @type {LinkedListItem} */
        this.next = null;
    }
}

/**
 * Regular double linked list implemenation, with fast insert and remove operations at both ends.
 */
class LinkedList {
    constructor() {
        /** @private */
        this._head = null;
        /** @private */
        this._tail = null;
    };
    /**
     * Returns first item of linked list
     * @return {LinkedListItem}
     */
    head() {
        return this._head;
    };
    /**
     * Returns last item of list.
     * @return {LinkedListItem}
     */
    tail() {
        return this._tail || this._head;
    };
    /**
     * Appends value to the end of list.
     * @param {LinkedListItem|any} value
     * @returns {LinkedListItem}
     */
    append(value) {
        var item = value;
        if (value instanceof LinkedListItem)
            item.next = item.prev = null;
        else
            item = new LinkedListItem(value);
        if (!this._tail) {
            if (this._head) {
                this._head.next = this._tail = item;
                item.prev = this._head;
            } else {
                this._head = item;
            }
        } else {
            this._tail.next = item;
            item.prev = this._tail;
            this._tail = item;
        }
        return item;
    };
    /**
     * Inserts value as first item.
     * @param {LinkedListItem|any} value
     * @returns {LinkedListItem}
     */
    insert(value) {
        var item = value;
        if (value instanceof LinkedListItem)
            item.next = item.prev = null;
        else
            item = new LinkedListItem(value);
        if (!this._head)
            this._head = item;
        else {
            this._head.prev = item;
            item.next = this._head;
            if (!this._tail)
                this._tail = this._head;
            this._head = item;
        }
        return item;
    };
    remove(item) {
        if (item instanceof LinkedListItem) {
            if (item.prev)
                item.prev.next = item.next;
            if (item.next)
                item.next.prev = item.prev;
            if (this._tail == item) {
                this._tail = item.prev;
                if (this._tail == this._head)
                    this._tail = null;
            }
            if (this._head == item) {
                this._head = item.next;
                if (this._tail == this._head)
                    this._tail = null;
            }
            item.next = null;
            item.prev = null;
            return true;
        }
        return false;
    };
}

module.exports.Queue = Queue;
module.exports.LinkedList = LinkedList;