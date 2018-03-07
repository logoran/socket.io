var server = require('http').createServer();
var ioc = require('logoran-socket.io-client');
var io = require('../..')(server);

var srv = server.listen(function() {
  var socket = ioc('ws://localhost:' + server.address().port);
  socket.on('connect', function() {
    io.close();
    socket.close();
  });
});
