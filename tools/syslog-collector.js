'use strict';
// Central syslog server (the "syslog server" box in the block diagram).
// Listens for syslog over TLS on port 6514, prints each event and appends it to logs/syslog.log.
// In a company you'd use rsyslog / Graylog / Splunk / Wazuh here instead; they accept the same format.
const tls = require('node:tls');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.SYSLOG_PORT || 6514);
const LOG = path.join(ROOT, 'logs', 'syslog.log');
fs.mkdirSync(path.dirname(LOG), { recursive: true });

const SEV = ['EMERG', 'ALERT', 'CRIT ', 'ERROR', 'WARN ', 'NOTE ', 'INFO ', 'DEBUG'];

function handle(line) {
  fs.appendFileSync(LOG, line + '\n');
  const m = /^<(\d+)>1 (\S+) \S+ (\S+) \S+ (\S+) (-|\[.*?\]) ?(.*)$/.exec(line);
  if (!m) return console.log(line);
  const sev = SEV[Number(m[1]) % 8];
  const time = m[2].slice(11, 19);
  console.log(`${time} ${sev} ${m[4].padEnd(20)} ${m[6]}${m[5] !== '-' ? '  ' + m[5] : ''}`);
}

const server = tls.createServer({
  key: fs.readFileSync(path.join(ROOT, 'certs', 'server.key')),
  cert: fs.readFileSync(path.join(ROOT, 'certs', 'server.crt')),
  minVersion: 'TLSv1.2',
}, (sock) => {
  let buf = Buffer.alloc(0);
  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    // octet-counting framing: "<length> <message>"
    for (;;) {
      const sp = buf.indexOf(0x20);
      if (sp < 1) break;
      const len = Number(buf.subarray(0, sp).toString());
      if (!Number.isInteger(len) || len <= 0 || len > 8192) { sock.destroy(); return; }
      if (buf.length < sp + 1 + len) break;
      handle(buf.subarray(sp + 1, sp + 1 + len).toString('utf8'));
      buf = buf.subarray(sp + 1 + len);
    }
  });
  sock.on('error', () => {});
});

server.listen(PORT, () => console.log(`Syslog server (TLS) listening on port ${PORT}. Writing to logs/syslog.log\n`));
