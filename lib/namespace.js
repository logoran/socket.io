
/**
 * Module dependencies.
 */

var Socket = require('./socket');
var Emitter = require('events').EventEmitter;
var parser = require('socket.io-parser');
var debug = require('debug')('socket.io:namespace');
var compose = require('logoran-compose');
const context = require('./context');
const response = require('./response');
const request = require('./request');
const assert = require('assert');
const isError = require('is-error');

/**
 * Module exports.
 */

module.exports = exports = Namespace;

/**
 * Blacklisted events.
 */

exports.events = [
  'error',
  'connect',    // for symmetry with client
  'connection',
  'newListener'
];

/**
 * Flags.
 */

exports.flags = [
  'json',
  'volatile',
  'local'
];

/**
 * `EventEmitter#emit` reference.
 */

var emit = Emitter.prototype.emit;

/**
 * Namespace constructor.
 *
 * @param {Server} server instance
 * @param {Socket} name
 * @api private
 */

function Namespace(server, name){
  this.name = name;
  this.server = server;
  this.sockets = {};
  this.connected = {};
  this.fns = [];
  this.fn = compose(this.fns);
  this.pfns = [];
  this.ids = 0;
  this.rooms = [];
  this.flags = {};
  this.initAdapter();
  this.context = Object.create(context);
  this.request = Object.create(request);
  this.response = Object.create(response);
}

/**
 * Inherits from `EventEmitter`.
 */

Namespace.prototype.__proto__ = Emitter.prototype;

/**
 * Apply flags from `Socket`.
 */

exports.flags.forEach(function(flag){
  Object.defineProperty(Namespace.prototype, flag, {
    get: function() {
      this.flags[flag] = true;
      return this;
    }
  });
});

/**
 * Initializes the `Adapter` for this nsp.
 * Run upon changing adapter by `Server#adapter`
 * in addition to the constructor.
 *
 * @api private
 */

Namespace.prototype.initAdapter = function(){
  this.adapter = new (this.server.adapter())(this);
};

/**
 * Sets up namespace middleware.
 *
 * @return {Namespace} self
 * @api public
 */

Namespace.prototype.use = function(fn){
  if (this.server.eio) {
    debug('removing initial packet');
    delete this.server.eio.initialPacket;
  }
  this.fns.push(fn);
  this.fn = compose(this.fns);
  return this;
};

/**
 * Presets up socket middleware.
 *
 * @return {Namespace} self
 * @api public
 */

Namespace.prototype.puse = function(fn){
  this.pfns.push(fn);
  return this;
};

/**
 * Executes the middleware for an incoming client.
 *
 * @param {Socket} socket that will get added
 * @param {Function} fn last fn call in the middleware
 * @api private
 */

Namespace.prototype.run = function(socket, fn){
  this.fn(socket).then(fn).catch(fn);
};

/**
 * Targets a room when emitting.
 *
 * @param {String} name
 * @return {Namespace} self
 * @api public
 */

Namespace.prototype.to =
Namespace.prototype.in = function(name){
  if (!~this.rooms.indexOf(name)) this.rooms.push(name);
  return this;
};

/**
 * Adds a new client.
 *
 * @return {Socket}
 * @api private
 */

Namespace.prototype.add = function(client, query, fn){
  debug('adding socket to nsp %s', this.name);
  var socket = new Socket(this, client, query);
  var self = this;
  this.run(socket, function(err){
    process.nextTick(function(){
      if ('open' == client.conn.readyState) {
        if (err) return socket.error(err.data || err.message);

        // track socket
        self.sockets[socket.id] = socket;

        // it's paramount that the internal `onconnect` logic
        // fires before user-set events to prevent state order
        // violations (such as a disconnection before the connection
        // logic is complete)
        socket.onconnect();
        if (fn) fn();

        // fire user-set events
        self.emit('connect', socket);
        self.emit('connection', socket);
      } else {
        debug('next called after client was closed - ignoring socket');
      }
    });
  });
  return socket;
};

/**
 * Removes a client. Called by each `Socket`.
 *
 * @api private
 */

Namespace.prototype.remove = function(socket){
  if (this.sockets.hasOwnProperty(socket.id)) {
    delete this.sockets[socket.id];
  } else {
    debug('ignoring remove for %s', socket.id);
  }
};

/**
 * Emits to all clients.
 *
 * @return {Namespace} self
 * @api public
 */

Namespace.prototype.emit = function(ev){
  if (~exports.events.indexOf(ev)) {
    emit.apply(this, arguments);
    return this;
  }
  // set up packet object
  var args = Array.prototype.slice.call(arguments);
  var packet = { type: parser.EVENT, data: args };

  if ('function' == typeof args[args.length - 1]) {
    throw new Error('Callbacks are not supported when broadcasting');
  }

  var rooms = this.rooms.slice(0);
  var flags = Object.assign({}, this.flags);

  // reset flags
  this.rooms = [];
  this.flags = {};

  this.adapter.broadcast(packet, {
    rooms: rooms,
    flags: flags
  });

  return this;
};

/**
 * Sends a `message` event to all clients.
 *
 * @return {Namespace} self
 * @api public
 */

Namespace.prototype.send =
Namespace.prototype.write = function(){
  var args = Array.prototype.slice.call(arguments);
  args.unshift('message');
  this.emit.apply(this, args);
  return this;
};

/**
 * Gets a list of clients.
 *
 * @return {Namespace} self
 * @api public
 */

Namespace.prototype.clients = function(fn){
  this.adapter.clients(this.rooms, fn);
  // reset rooms for scenario:
  // .in('room').clients() (GH-1978)
  this.rooms = [];
  return this;
};

/**
 * Sets the compress flag.
 *
 * @param {Boolean} compress if `true`, compresses the sending data
 * @return {Socket} self
 * @api public
 */

Namespace.prototype.compress = function(compress){
  this.flags.compress = compress;
  return this;
};

/**
 * Default error handler.
 *
 * @param {Error} err
 * @api private
 */

Namespace.prototype.onerror = function(err) {
  assert(isError(err), `non-error thrown: ${err}`);

  if (404 == err.status || err.expose) return;
  if (this.silent) return;

  const msg = err.stack || err.toString();
  console.error();
  console.error(msg.replace(/^/gm, '  '));
  console.error();
};
