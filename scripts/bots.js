// Load-test / demo helper: connects N bot players that wander the maze.
// Usage: node scripts/bots.js [count] [url]
'use strict';
const { io } = require('socket.io-client');

const N = Number(process.argv[2]) || 20;
const URL = process.argv[3] || 'http://localhost:3000';

for (let i = 0; i < N; i++) {
  const s = io(URL, { transports: ['websocket'] });
  const token = `bot-token-${i}-${Math.random().toString(36).slice(2)}`;
  let timer = null;
  s.on('connect', () => {
    s.emit('join', { name: `Bot${i + 1}`, token }, (res) => {
      if (!res.ok) console.error(`Bot${i + 1}:`, res.error);
    });
  });
  s.on('roundStart', () => {
    clearInterval(timer);
    // Bots let the server move them: pick a new direction now and then.
    timer = setInterval(() => s.emit('dir', Math.floor(Math.random() * 4)), 400 + Math.random() * 900);
  });
  s.on('roundEnd', () => clearInterval(timer));
  s.on('roundAbort', () => clearInterval(timer));
}
console.log(`Connected ${N} bots to ${URL}`);
