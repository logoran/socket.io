
/**
 * Module dependencies.
 */

var Emitter = require('events').EventEmitter;
var parser = require('socket.io-parser');
var url = require('url');
var debug = require('debug')('socket.io:socket');
var compose = require('logoran-compose');
var Cookies = require('cookies');
var parse = require('parseurl');
var qs = require('querystring');
const accepts = require('accepts');
const Stream = require('stream');
const statuses = require('statuses');
const BufferHelper = require('bufferhelper');
const only = require('only');

/**
 * Module exports.
 */

module.exports = exports = Socket;

/**
 * Blacklisted events.
 *
 * @api public
 */

exports.events = [
  'error',
  'connect',
  'disconnect',
  'disconnecting',
  'newListener',
  'removeListener'
];

/**
 * Flags.
 *
 * @api private
 */

var flags = [
  'json',
  'volatile',
  'broadcast'
];

/**
 * `EventEmitter#emit` reference.
 */

var emit = Emitter.prototype.emit;

/**
 * mock res for cookies
 * @type {Object}
 */

var res = {
  setHeader: function resSetHeader() {
  },
  getHeader: function resGetHeader() {
  },
};

/**
 * Interface to a `Client` for a given `Namespace`.
 *
 * @param {Namespace} nsp
 * @param {Client} client
 * @api public
 */

function Socket(nsp, client, query){
  this.nsp = nsp;
  this.server = nsp.server;
  this.adapter = this.nsp.adapter;
  this.id = nsp.name !== '/' ? nsp.name + '#' + client.id : client.id;
  this.client = client;
  this.conn = client.conn;
  this.rooms = {};
  this.acks = {};
  this.connected = true;
  this.disconnected = false;
  this.handshake = this.buildHandshake(query);
  this.fns = nsp.pfns;
  this.fn = compose(this.fns);
  this.flags = {};
  this._rooms = [];
  this.cookies = new Cookies(this.request, res, {
    keys: nsp.server.keys,
    secure: this.secure
  });
}

/**
 * Inherits from `EventEmitter`.
 */

Socket.prototype.__proto__ = Emitter.prototype;

/**
 * Return JSON representation.
 * We only bother showing settings.
 *
 * @return {Object}
 * @api public
 */

Socket.prototype.toJSON = function() {
  return only(this, [
    'flags',
    '_rooms'
  ]);
}

/**
 * Inspect implementation.
 *
 * @return {Object}
 * @api public
 */

Socket.prototype.inspect = function() {
  return this.toJSON();
}

/**
 * Apply flags from `Socket`.
 */

flags.forEach(function(flag){
  Object.defineProperty(Socket.prototype, flag, {
    get: function() {
      this.flags[flag] = true;
      return this;
    }
  });
});

/**
 * `request` engine.io shortcut.
 *
 * @api public
 */

Object.defineProperty(Socket.prototype, 'request', {
  get: function() {
    return this.conn.request;
  }
});

/**
 * Builds the `handshake` BC object
 *
 * @api private
 */

Socket.prototype.buildHandshake = function(query){
  var self = this;
  function buildQuery(){
    var requestQuery = url.parse(self.request.url, true).query;
    //if socket-specific query exist, replace query strings in requestQuery
    return Object.assign({}, query, requestQuery);
  }
  return {
    headers: this.request.headers,
    time: (new Date) + '',
    address: this.conn.remoteAddress,
    xdomain: !!this.request.headers.origin,
    secure: !!this.request.connection.encrypted,
    issued: +(new Date),
    url: this.request.url,
    query: buildQuery()
  };
};

/**
 * Emits to this client.
 *
 * @return {Socket} self
 * @api public
 */

Socket.prototype.emit = function(ev){
  if (~exports.events.indexOf(ev)) {
    emit.apply(this, arguments);
    return this;
  }

  var args = Array.prototype.slice.call(arguments);
  var packet = {
    type: parser.EVENT,
    data: args
  };

  // access last argument to see if it's an ACK callback
  if (typeof args[args.length - 1] === 'function') {
    if (this._rooms.length || this.flags.broadcast) {
      throw new Error('Callbacks are not supported when broadcasting');
    }

    debug('emitting packet with ack id %d', this.nsp.ids);
    this.acks[this.nsp.ids] = args.pop();
    packet.id = this.nsp.ids++;
  }

  var rooms = this._rooms.slice(0);
  var flags = Object.assign({}, this.flags);

  // reset flags
  this._rooms = [];
  this.flags = {};

  if (rooms.length || flags.broadcast) {
    this.adapter.broadcast(packet, {
      except: [this.id],
      rooms: rooms,
      flags: flags
    });
  } else {
    // dispatch packet
    this.packet(packet, flags);
  }
  return this;
};

/**
 * Targets a room when broadcasting.
 *
 * @param {String} name
 * @return {Socket} self
 * @api public
 */

Socket.prototype.to =
Socket.prototype.in = function(name){
  if (!~this._rooms.indexOf(name)) this._rooms.push(name);
  return this;
};

/**
 * Sends a `message` event.
 *
 * @return {Socket} self
 * @api public
 */

Socket.prototype.send =
Socket.prototype.write = function(){
  var args = Array.prototype.slice.call(arguments);
  args.unshift('message');
  this.emit.apply(this, args);
  return this;
};

var methods = [
  'head',
  'options',
  'get',
  'put',
  'patch',
  'post',
  'delete'
];

/**
 * Sends a `http` event with method argument.
 *
 * @param {String} method
 * @param {Object} headers object
 * @param {String} url
 * @return {Socket} self
 * @api public
 */

Socket.prototype.http = function(method, headers, url) {
  let args = Array.prototype.slice.call(arguments, 1);
  args.unshift('http' + method.toUpperCase());
  let origin = arguments[arguments.length - 1];
  if ('function' == typeof origin) {
    args[arguments.length - 1] = responseHandler(origin);
  }
  this.emit.apply(this, args);
  return this;
};

/**
 * Create functions sends a `http` event of method.
 *
 * @param {Object} headers object
 * @param {String} url
 * @return {Socket} self
 * @api public
 */

methods.forEach(function (method) {
  debug('Create http function %s', method);
  let fullMethod = 'http' + method.toUpperCase();
  Socket.prototype[method] = function (headers, url) {
    let args = Array.prototype.slice.call(arguments);
    args.unshift(fullMethod);
    let origin = arguments[arguments.length - 1];
    if ('function' == typeof origin) {
      args[arguments.length - 1] = responseHandler(origin);
    }
    this.emit.apply(this, args);
    return this;
  };
});

/**
 * Writes a packet.
 *
 * @param {Object} packet object
 * @param {Object} opts options
 * @api private
 */

Socket.prototype.packet = function(packet, opts){
  packet.nsp = this.nsp.name;
  opts = opts || {};
  opts.compress = false !== opts.compress;
  this.client.packet(packet, opts);
};

/**
 * Joins a room.
 *
 * @param {String|Array} room or array of rooms
 * @param {Function} fn optional, callback
 * @return {Socket} self
 * @api private
 */

Socket.prototype.join = function(rooms, fn){
  debug('joining room %s', rooms);
  var self = this;
  if (!Array.isArray(rooms)) {
    rooms = [rooms];
  }
  rooms = rooms.filter(function (room) {
    return !self.rooms.hasOwnProperty(room);
  });
  if (!rooms.length) {
    fn && fn(null);
    return this;
  }
  this.adapter.addAll(this.id, rooms, function(err){
    if (err) return fn && fn(err);
    debug('joined room %s', rooms);
    rooms.forEach(function (room) {
      self.rooms[room] = room;
    });
    fn && fn(null);
  });
  return this;
};

/**
 * Leaves a room.
 *
 * @param {String} room
 * @param {Function} fn optional, callback
 * @return {Socket} self
 * @api private
 */

Socket.prototype.leave = function(room, fn){
  debug('leave room %s', room);
  var self = this;
  this.adapter.del(this.id, room, function(err){
    if (err) return fn && fn(err);
    debug('left room %s', room);
    delete self.rooms[room];
    fn && fn(null);
  });
  return this;
};

/**
 * Leave all rooms.
 *
 * @api private
 */

Socket.prototype.leaveAll = function(){
  this.adapter.delAll(this.id);
  this.rooms = {};
};

/**
 * Called by `Namespace` upon successful
 * middleware execution (ie: authorization).
 * Socket is added to namespace array before
 * call to join, so adapters can access it.
 *
 * @api private
 */

Socket.prototype.onconnect = function(){
  debug('socket connected - writing packet');
  this.nsp.connected[this.id] = this;
  this.join(this.id);
  var skip = this.nsp.name === '/' && this.nsp.fns.length === 0;
  if (skip) {
    debug('packet already sent in initial handshake');
  } else {
    this.packet({ type: parser.CONNECT });
  }
};

/**
 * Called with each packet. Called by `Client`.
 *
 * @param {Object} packet
 * @api private
 */

Socket.prototype.onpacket = function(packet){
  debug('got packet %j', packet);
  switch (packet.type) {
    case parser.EVENT:
      this.onevent(packet);
      break;

    case parser.BINARY_EVENT:
      this.onevent(packet);
      break;

    case parser.ACK:
      this.onack(packet);
      break;

    case parser.BINARY_ACK:
      this.onack(packet);
      break;

    case parser.DISCONNECT:
      this.ondisconnect();
      break;

    case parser.ERROR:
      this.onerror(new Error(packet.data));
  }
};

/**
 * Called upon event packet.
 *
 * @param {Object} packet object
 * @api private
 */

Socket.prototype.onevent = function(packet){
  var args = packet.data || [];
  debug('emitting event %j', args);

  if (null != packet.id) {
    debug('attaching ack callback to event');
    args.push(this.ack(packet.id));
  }

  this.dispatch(args);
};

/**
 * Produces an ack callback to emit with an event.
 *
 * @param {Number} id packet id
 * @api private
 */

Socket.prototype.ack = function(id){
  var self = this;
  var sent = false;
  return function(){
    // prevent double callbacks
    if (sent) return;
    var args = Array.prototype.slice.call(arguments);
    debug('sending ack %j', args);

    self.packet({
      id: id,
      type: parser.ACK,
      data: args
    });

    sent = true;
  };
};

/**
 * Called upon ack packet.
 *
 * @api private
 */

Socket.prototype.onack = function(packet){
  var ack = this.acks[packet.id];
  if ('function' == typeof ack) {
    debug('calling ack %s with %j', packet.id, packet.data);
    ack.apply(this, packet.data);
    delete this.acks[packet.id];
  } else {
    debug('bad ack %s', packet.id);
  }
};

/**
 * Called upon client disconnect packet.
 *
 * @api private
 */

Socket.prototype.ondisconnect = function(){
  debug('got disconnect packet');
  this.onclose('client namespace disconnect');
};

/**
 * Handles a client error.
 *
 * @api private
 */

Socket.prototype.onerror = function(err){
  if (this.listeners('error').length) {
    this.emit('error', err);
  } else {
    console.error('Missing error handler on `socket`.');
    console.error(err.stack);
  }
};

/**
 * Called upon closing. Called by `Client`.
 *
 * @param {String} reason
 * @throw {Error} optional error object
 * @api private
 */

Socket.prototype.onclose = function(reason){
  if (!this.connected) return this;
  debug('closing socket - reason %s', reason);
  this.emit('disconnecting', reason);
  this.leaveAll();
  this.nsp.remove(this);
  this.client.remove(this);
  this.connected = false;
  this.disconnected = true;
  delete this.nsp.connected[this.id];
  this.emit('disconnect', reason);
};

/**
 * Produces an `error` packet.
 *
 * @param {Object} err error object
 * @api private
 */

Socket.prototype.error = function(err){
  this.packet({ type: parser.ERROR, data: err });
};

/**
 * Disconnects this client.
 *
 * @param {Boolean} close if `true`, closes the underlying connection
 * @return {Socket} self
 * @api public
 */

Socket.prototype.disconnect = function(close){
  if (!this.connected) return this;
  if (close) {
    this.client.disconnect();
  } else {
    this.packet({ type: parser.DISCONNECT });
    this.onclose('server namespace disconnect');
  }
  return this;
};

/**
 * Sets the compress flag.
 *
 * @param {Boolean} compress if `true`, compresses the sending data
 * @return {Socket} self
 * @api public
 */

Socket.prototype.compress = function(compress){
  this.flags.compress = compress;
  return this;
};

/**
 * Initialize a new context.
 *
 * @api private
 */

Socket.prototype.createContext = function(req, res) {
  const context = Object.create(this.nsp.context);
  const request = context.request = Object.create(this.nsp.request);
  const response = context.response = Object.create(this.nsp.response);
  context.app = request.app = response.app = this.server;
  context.req = request.req = response.req = req;
  context.res = request.res = response.res = res;
  request.ctx = response.ctx = context;
  request.response = response;
  response.request = request;
  context.originalUrl = request.originalUrl = req.url;
  context.accept = request.accept = accepts(req);
  context.cookies = this.cookies;
  request.ip = this.ip;
  //context.state = this.state;
  return context;
}

/**
 * Handle request in callback.
 *
 * @api private
 */

Socket.prototype.handleRequest = function(ctx) {
  const res = ctx.res;
  res.statusCode = 404;
  const onerror = err => ctx.onerror(err);
  const handleResponse = () => respond(ctx);
  return ((this.fn) || compose(this.fns))(ctx).then(handleResponse).catch(onerror);
}

/**
 * Handle event in callback.
 *
 * @api private
 */

Socket.prototype.handleEvent = function(event) {
  try {
    emit.apply(this, event);
  } catch(err) {
    this.error(err.data || err.message);
  };
}

/**
 * Dispatch incoming event to socket listeners.
 *
 * @param {Array} event that will get emitted
 * @api private
 */

Socket.prototype.dispatch = function(event){
  debug('dispatching an event %j', event);
  var self = this;
  let req = prepareRequest(event, this);
  if (req){
    let res = prepareResponse(event);
    const ctx = this.createContext(req, res);
    this.handleRequest(ctx);
  } else {
    this.handleEvent(event);
  }
};

/**
 * Sets up socket middleware.
 *
 * @param {Function} middleware function (event, next)
 * @return {Socket} self
 * @api public
 */

Socket.prototype.use = function(fn){
  if (this.fn) {
    this.fn = undefined;
    this.fns = this.fns.slice(0);
  }
  this.fns.push(fn);
  return this;
};

/**
 * Executes the middleware for an incoming event.
 *
 * @param {Array} event that will get emitted
 * @param {Function} last fn call in the middleware
 * @api private
 */
Socket.prototype.run = function(event, fn){
  ((this.fn) || compose(this.fns))(event).then(fn).catch(fn);
};

/**
 * Return request header
 *
 * @return {Object}
 * @api public
 */

Socket.prototype.__defineGetter__('header', function headerGetter() {
  return this.request.headers;
});

/**
 * Return request header, alias as request.header
 *
 * @return {Object}
 * @api public
 */

Socket.prototype.__defineGetter__('headers', function headersGetter() {
  return this.request.headers;
});

/**
 * Get request URL.
 *
 * @return {String}
 * @api public
 */

Socket.prototype.__defineGetter__('url', function urlGetter() {
  return this.request.url;
});

/**
 * Get request pathname.
 *
 * @return {String}
 * @api public
 */

Socket.prototype.__defineGetter__('path', function pathGetter() {
  return parse(this.request).pathname;
});

/**
 * Get parsed query-string.
 *
 * @return {Object}
 * @api public
 */

Socket.prototype.__defineGetter__('query', function queryGetter() {
  var str = this.querystring;
  /*istanbul ignore if*/ if (!str) return {};

  var c = this._querycache = this._querycache || {};
  return c[str] || (c[str] = qs.parse(str));
});


/**
 * Get query string.
 *
 * @return {String}
 * @api public
 */

Socket.prototype.__defineGetter__('querystring', function querystringGetter() {
  return parse(this.request).query || /*istanbul ignore next*/ '';
});

/**
 * Get the search string. Same as the querystring
 * except it includes the leading ?.
 *
 * @return {String}
 * @api public
 */

Socket.prototype.__defineGetter__('search', function searchGetter() {
  /*istanbul ignore if*/ if (!this.querystring) return '';
  return '?' + this.querystring;
});

/**
 * Parse the "Host" header field host
 * and support X-Forwarded-Host when a
 * proxy is enabled.
 *
 * @return {String} hostname:port
 * @api public
 */

Socket.prototype.__defineGetter__('host', function hostGetter() {
  var proxy = this.server.proxy;
  var host = proxy && this.get('X-Forwarded-Host');
  host = host || this.get('Host');
  /*istanbul ignore if*/ if (!host) return null;
  return host.split(/\s*,\s*/)[0];
});

/**
 * Parse the "Host" header field hostname
 * and support X-Forwarded-Host when a
 * proxy is enabled.
 *
 * @return {String} hostname
 * @api public
 */

Socket.prototype.__defineGetter__('hostname', function hostnameGetter() {
  var host = this.host;
  /*istanbul ignore if*/ if (!host) return null;
  return host.split(':')[0];
});

/**
 * Get the charset when present or undefined.
 *
 * @return {String}
 * @api public
 */

Socket.prototype.__defineGetter__('charset', function charsetGetter() {
  var type = this.get('Content-Type');
  /*istanbul ignore next*/ if (!type) return null;

  return typer.parse(type).parameters.charset;
});

/**
 * Return parsed Content-Length when present.
 *
 * @return {Number}
 * @api public
 */

Socket.prototype.__defineGetter__('length', function lengthGetter() {
  var len = this.get('Content-Length');
  /*istanbul ignore if*/ if (len === null) return null;
  return ~~len;
});

/**
 * Return the protocol string "http" or "https"
 * when requested with TLS. When the proxy setting
 * is enabled the "X-Forwarded-Proto" header
 * field will be trusted. If you're running behind
 * a reverse proxy that supplies https for you this
 * may be enabled.
 *
 * @return {String}
 * @api public
 */

Socket.prototype.__defineGetter__('protocol', function protocolGetter() {
  var proxy = this.server.proxy;
  if (this.request.connection.encrypted) return 'https';
  if (!proxy) return 'http';
  var proto = this.get('X-Forwarded-Proto') || 'http';
  return proto.split(/\s*,\s*/)[0];
});

/**
 * Short-hand for:
 *
 *    this.protocol == 'https'
 *
 * @return {Boolean}
 * @api public
 */

Socket.prototype.__defineGetter__('secure', function secureGetter() {
  return this.protocol === 'https';
});

/**
 * Return the remote address, or when
 * `server.proxy` is `true` return
 * the upstream addr.
 *
 * @return {String}
 * @api public
 */

Socket.prototype.__defineGetter__('ip', function ipGetter() {
  return this.ips[0] || this.conn.remoteAddress || '';
});

/**
 * When `server.proxy` is `true`, parse
 * the "X-Forwarded-For" ip address list.
 *
 * For example if the value were "client, proxy1, proxy2"
 * you would receive the array `["client", "proxy1", "proxy2"]`
 * where "proxy2" is the furthest down-stream.
 *
 * @return {Array}
 * @api public
 */

Socket.prototype.__defineGetter__('ips', function ipsGetter() {
  var proxy = this.server.proxy;
  var val = this.get('X-Forwarded-For');
  return proxy && val
    ? val.split(/ *, */)
    : [];
});

/**
 * Return request header.
 *
 * The `Referrer` header field is special-cased,
 * both `Referrer` and `Referer` are interchangeable.
 *
 * Examples:
 *
 *     this.get('Content-Type');
 *     // => "text/plain"
 *
 *     this.get('content-type');
 *     // => "text/plain"
 *
 *     this.get('Something');
 *     // => undefined
 *
 * @param {String} field
 * @return {String}
 * @api public
 */

Socket.prototype.get = function socketGet(_field) {
  var req = this.request;
  var field = _field.toLowerCase();
  switch (field) {
  case 'referer':
  case 'referrer':
    return req.headers.referrer || req.headers.referer;
  default:
    return req.headers[field];
  }
};


// for compact
Socket.prototype.set = function socketSet() {
  debug('socket.io can not set header');
};

/**
 * Response helper.
 */

function respond(ctx) {
  // allow bypassing logoran
  // if (false === ctx.respond) return;

  const res = ctx.res;
  if (!ctx.writable) return;

  let body = ctx.body;
  const code = ctx.status;

  // ignore body
  if (statuses.empty[code]) {
    // strip headers
    ctx.body = null;
    return res.end();
  }

  if ('HEAD' == ctx.method) {
    /*if (!res.headersSent && isJSON(body)) {
      ctx.length = Buffer.byteLength(JSON.stringify(body));
    }*/
    return res.end();
  }

  // set slot to body
  if (undefined === body && ctx.slot) {
    ctx.status = 200;
    body = ctx.slot;
  }

  // status body
  if (null == body) {
    body = ctx.message || String(code);
    /*if (!res.headersSent) {
      ctx.type = 'text';
      ctx.length = Buffer.byteLength(body);
    }*/
    return res.end(body);
  }

  // responses
  if (Buffer.isBuffer(body)) return res.end(body);
  if ('string' == typeof body) return res.end(body);
  if (body instanceof Stream) return res.end(body);

  // body: json
  /*body = JSON.stringify(body);
  if (!res.headersSent) {
    ctx.length = Buffer.byteLength(body);
  }*/
  if (Array.isArray(body)) return res.end(body);
  return res.end(body);
}

/**
 * Response handler helper.
 */

function responseHandler(fn) {
  return function() {
    let headers;
    let status;
    let body;
    let offset;
    let length = arguments.length;
    if ('object' == typeof arguments[0]) {
      header = arguments[0];
      status = arguments[1];
      offset = 2;
    } else {
      header = {};
      status = arguments[0];
      offset = 1;
    }
    if (offset == length - 1) {
      body = null;
    } else if (offset == length - 2) {
      body = arguments[offset];
    } else {
      body = arguments.slice(offset);
    }
    fn({headers: headers, status: status, body: body});
  }
}

function prepareRequest(event, socket) {
  if ('HTTP' !== event[0].slice(0, 4).toUpperCase()) {
    return null;
  }
  let method = event[0].slice(4);
  let url;
  let headers;
  let cbfn;
  let body;
  let length = event.length;
  let offset;
  if ('object' == typeof event[1]) {
    headers = event[1];
    url = event[2];
    offset = 3;
  } else {
    headers = {};
    url = event[1];
    offset = 2;
  }
  if ('string' != typeof url) {
    return null;
  }
  if ('function' == typeof event[length - 1]) {
    if (offset == length - 1) {
      boby = null;
    } else if (offset == length - 2) {
      body = event[offset];
    } else {
      body = event.slice(offset, -1);
    }
    cbfn = event[event.length - 1];
  } else {
    if (offset == length) {
      boby = null;
    } else if (offset == length - 1) {
      body = event[offset];
    } else {
      body = event.slice(offset);
    }
    cnfn = null;
  }
  return {method: method, url: url, headers: headers, body: body, socket: socket};
}

function prepareResponse(event) {
  let cbfn = event[event.length - 1];
  if ('function' != typeof cbfn) {
    return {headers: {}, cbfn: null, end: function(data) {
      console.error('can\'t respond to client');
    }};
  }
  return {headers: {}, cbfn: cbfn, end: function(data) {
    if (Array.isArray(data)) {
      let _data = data.slice();
      if (Object.keys(this.headers).length) {
        _data.unshift(this.headers, this.statusCode);
      } else {
        _data.unshift(this.statusCode)
      }
      return this.cbfn.apply(null, _data);
    }
    if (data instanceof Stream) {
      let _data = new BufferHelper();
      data.on('data', function(chunk){
        _data.concat(chunk);
      });
      let self = this;
      data.on('end', function(){
        data.destroy();
        Object.keys(self.headers).length ? self.cbfn(self.headers, self.statusCode, _data.toBuffer()) : self.cbfn(self.statusCode, _data.toBuffer());
      });
      return;
    }
    if (data) {
      return Object.keys(this.headers).length ? this.cbfn(this.headers, this.statusCode, data) : this.cbfn(this.statusCode, data);
    } else {
      return Object.keys(this.headers).length ? this.cbfn(this.headers, this.statusCode) : this.cbfn(this.statusCode);
    }
  }};
}

