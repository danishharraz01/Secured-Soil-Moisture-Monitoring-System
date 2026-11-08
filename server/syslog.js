'use strict';
// Sends events to a central syslog server, as in the proposal ("sends data to syslog server").
// Format: RFC 5424. Transport: syslog over TLS (RFC 5425, port 6514) so logs can't be read
// or forged on the network the way plain UDP syslog (port 514) can.
const tls = require('node:tls');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const HOST = process.env.SYSLOG_HOST || '127.0.0.1';
const PORT = Number(process.env.SYSLOG_PORT || 6514);
const CA = path.join(__dirname, '..', 'certs', 'server.crt');
const MAX_QUEUE = 2000;

// Severity: 2 crit, 4 warning, 5 notice, 6 info. Facility: 4 auth (security), 16 local0 (sensor data)
const SEV = { crit: 2, warning: 4, notice: 5, info: 6 };
const FAC = { auth: 4, sensor: 16 };

let socket = null;
let connecting = false;
let retryAt = 0;
const queue = [];

function sdEscape(v) {
  return String(v).replace(/["\\\]]/g, (c) => '\\' + c);
}

function format({ facility, severity, msgId, data, message }) {
  const pri = FAC[facility] * 8 + SEV[severity];
  const sd = data && Object.keys(data).length
    ? '[soil@32473 ' + Object.entries(data).map(([k, v]) => `${k}="${sdEscape(v)}"`).join(' ') + ']'
    : '-';
  return `<${pri}>1 ${new Date().toISOString()} ${os.hostname()} soil-server ${process.pid} ${msgId} ${sd} ${message}`;
}

function connect() {
  if (connecting || socket || Date.now() < retryAt) return;
  connecting = true;
  const s = tls.connect({ host: HOST, port: PORT, ca: fs.readFileSync(CA), servername: 'localhost' }, () => {
    connecting = false;
    socket = s;
    flush();
  });
  const drop = () => {
    connecting = false;
    if (socket === s) socket = null;
    retryAt = Date.now() + 5000; // collector down: keep queuing, retry in 5 s
  };
  s.on('error', drop);
  s.on('close', drop);
}

function flush() {
  while (socket && queue.length) {
    const msg = Buffer.from(queue.shift(), 'utf8');
    socket.write(`${msg.length} `); // octet-counting framing (RFC 6587)
    socket.write(msg);
  }
}

function log(event) {
  queue.push(format(event));
  if (queue.length > MAX_QUEUE) queue.shift();
  if (socket) flush(); else connect();
}

module.exports = { log };
