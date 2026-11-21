(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const key = new URLSearchParams(location.search).get('key') || '';
  const socket = io();

  fetch('/api/info').then((r) => r.json()).then((d) => { $('#url').textContent = d.joinUrl; });

  socket.on('connect', () => {
    socket.emit('host:auth', key, (res) => {
      $('#lock').classList.toggle('hidden', res.ok);
      $('#app').classList.toggle('hidden', !res.ok);
    });
  });

  $('#start').addEventListener('click', () => { $('#msg').textContent = ''; socket.emit('host:start'); });
  $('#stop').addEventListener('click', () => {
    if (confirm('Stop the round and send everyone back to the lobby?')) socket.emit('host:stop');
  });
  socket.on('hostError', (m) => { $('#msg').textContent = m; });

  const STATE = { lobby: 'Lobby', countdown: 'Starting', playing: 'Playing', ended: 'Round over' };
  socket.on('hostStatus', (s) => {
    const parts = [`<b>${STATE[s.state] || s.state}</b>`, `${s.players} connected`];
    if (s.total) {
      parts.push(`${s.pacsAlive}/${s.pacs} dodgers`, `${s.ghosts} inspectors`, `${s.left}/${s.total} coins`, `map ${s.map}`);
      if (s.suddenDeath) parts.push('<b>sudden death</b>');
    }
    $('#status').innerHTML = parts.join(' &nbsp;·&nbsp; ');
    const running = s.state === 'countdown' || s.state === 'playing';
    $('#start').disabled = running;
    $('#stop').disabled = s.state === 'lobby';
    if (running) $('#results').classList.add('hidden');
  });

  socket.on('lobby', (d) => {
    $('#count').textContent = d.count;
    $('#players').innerHTML = d.players.map((p) =>
      `<span>${FD.escapeHtml(p.name)}</span>`).join('');
  });

  socket.on('roundEnd', (res) => {
    $('#resTitle').textContent = res.winner === 'pac' ? 'Fare dodgers win' : 'Inspectors win';
    $('#pacBoard').innerHTML = FD.boardHtml(res.pacBoard, 'pac', null, 15);
    $('#ghostBoard').innerHTML = FD.boardHtml(res.ghostBoard, 'ghost', null, 15);
    $('#results').classList.remove('hidden');
  });
})();
