'use strict';
const path = require('path');
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const { Game } = require('./src/game');

const PORT = Number(process.env.PORT) || 3000;
const HOST_KEY = process.env.HOST_KEY || crypto.randomBytes(3).toString('hex');

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return 'localhost';
}
const LAN_URL = `http://${lanAddress()}:${PORT}/`;

// Join link for the QR code: PUBLIC_URL if set; otherwise the address the host page
// was opened from (e.g. a tunnel URL); falls back to the LAN address for localhost.
function joinUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL;
  const host = req.get('x-forwarded-host') || req.get('host') || '';
  if (!host || /^(localhost|127\.|\[::1\])/.test(host)) return LAN_URL;
  const proto = (req.get('x-forwarded-proto') || req.protocol).split(',')[0].trim();
  return `${proto}://${host}/`;
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 10000, pingTimeout: 20000 });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/host', (req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));
app.get('/api/info', (req, res) => res.json({ joinUrl: joinUrl(req) }));
app.get('/api/qr.svg', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('image/svg+xml').send(await QRCode.toString(joinUrl(req), { type: 'svg', margin: 1 }));
});

new Game(io, HOST_KEY);

server.listen(PORT, () => {
  console.log('\n  Fare Dodgers is running');
  console.log(`  Players join:  ${process.env.PUBLIC_URL || LAN_URL}  (same Wi-Fi only; use a tunnel otherwise)`);
  console.log(`  Host page:     http://localhost:${PORT}/host?key=${HOST_KEY}\n`);
});
