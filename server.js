'use strict';
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const { loadQuestions, scoreRound } = require('./scoring');

const PORT = process.env.PORT || 3000;
const MIN_PLAYERS = Number(process.env.MIN_PLAYERS || 1);
const REVEAL_MS = Number(process.env.REVEAL_MS || 12000);
const MAX_PLAYERS = 12;
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // sans I ni O (confusion avec 1 et 0)

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.send('ok'));

const QUESTIONS = loadQuestions(path.join(__dirname, 'questions.json'));
const rooms = new Map();

/* ---------- utilitaires ---------- */

const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 14);
const cleanAnswer = (s) => String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 60);
const shuffle = (a) => {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

function makeCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += LETTERS[crypto.randomInt(LETTERS.length)];
    if (!rooms.has(c)) return c;
  }
}

function addPlayer(room, pseudo, socket) {
  const p = {
    id: crypto.randomBytes(8).toString('hex'),
    pseudo, socketId: socket.id, score: 0, connected: true, dcTimer: null,
  };
  room.players.set(p.id, p);
  socket.data = { code: room.code, pid: p.id };
  socket.join(room.code);
  return p;
}

function transferHost(room) {
  const list = [...room.players.values()];
  const next = list.find((p) => p.connected) || list[0];
  if (next) room.hostId = next.id;
}

function closeRoom(room) {
  clearTimeout(room.timer);
  rooms.delete(room.code);
}

function removePlayer(room, pid) {
  const p = room.players.get(pid);
  if (!p) return;
  clearTimeout(p.dcTimer);
  room.players.delete(pid);
  if (room.players.size === 0) return closeRoom(room);
  if (room.hostId === pid) transferHost(room);
  if (room.phase === 'question') maybeEndEarly(room);
  broadcast(room);
}

/* ---------- état envoyé aux clients ---------- */

function snapshot(room, pid) {
  const players = [...room.players.values()].map((p) => ({
    id: p.id, pseudo: p.pseudo, score: p.score, connected: p.connected,
    answered: room.phase === 'question' ? room.answers.has(p.id) : undefined,
  }));
  const s = {
    code: room.code, phase: room.phase, hostId: room.hostId, you: pid,
    settings: room.settings, players,
    round: room.round + 1, totalRounds: room.settings.manches,
    serverNow: Date.now(),
  };
  if (room.phase === 'question' || room.phase === 'reveal') {
    const q = QUESTIONS[room.questionIds[room.round]];
    s.question = { texte: q.texte, categorie: q.categorie };
  }
  if (room.phase === 'question') {
    s.endsAt = room.endsAt;
    s.myAnswer = room.answers.get(pid) || '';
  }
  if (room.phase === 'reveal') {
    s.reveal = room.lastReveal;
    s.revealEndsAt = room.revealEndsAt;
    s.lastRound = room.round + 1 >= room.settings.manches;
  }
  if (room.phase === 'final') {
    const sorted = [...room.players.values()].sort((a, b) => b.score - a.score);
    let rank = 0, prev = null;
    s.ranking = sorted.map((p, i) => {
      if (p.score !== prev) { rank = i + 1; prev = p.score; }
      return { id: p.id, pseudo: p.pseudo, score: p.score, rank };
    });
  }
  return s;
}

function broadcast(room) {
  for (const p of room.players.values()) {
    if (p.connected) io.to(p.socketId).emit('state', snapshot(room, p.id));
  }
}

/* ---------- déroulement d'une partie ---------- */

function startRound(room) {
  clearTimeout(room.timer);
  room.phase = 'question';
  room.answers = new Map();
  const ms = room.settings.temps * 1000;
  room.endsAt = Date.now() + ms;
  room.timer = setTimeout(() => endRound(room), ms);
  broadcast(room);
}

function maybeEndEarly(room) {
  const connected = [...room.players.values()].filter((p) => p.connected);
  if (connected.length > 0 && connected.every((p) => room.answers.has(p.id))) endRound(room);
}

function endRound(room) {
  if (room.phase !== 'question') return;
  clearTimeout(room.timer);
  const q = QUESTIONS[room.questionIds[room.round]];
  const ids = [...room.players.keys()];
  const { rows, autres } = scoreRound(q, room.answers, ids);

  for (const r of rows) {
    const p = room.players.get(r.pid);
    p.score += r.pts;
    r.id = r.pid; delete r.pid;
    r.pseudo = p.pseudo;
    r.total = p.score;
  }
  rows.sort((a, b) => b.pts - a.pts || b.rarete - a.rarete);

  room.lastReveal = { rows, autres };
  room.phase = 'reveal';
  room.revealEndsAt = Date.now() + REVEAL_MS;
  room.timer = setTimeout(() => nextRound(room), REVEAL_MS);
  broadcast(room);
}

function nextRound(room) {
  if (room.phase !== 'reveal') return;
  clearTimeout(room.timer);
  room.round += 1;
  if (room.round >= room.settings.manches) {
    room.phase = 'final';
    broadcast(room);
  } else {
    startRound(room);
  }
}

/* ---------- sockets ---------- */

io.on('connection', (socket) => {
  const ctx = () => {
    const { code, pid } = socket.data || {};
    const room = code ? rooms.get(code) : null;
    const player = room ? room.players.get(pid) : null;
    return room && player ? { room, player } : {};
  };
  const done = (ack, payload) => { if (typeof ack === 'function') ack(payload); };

  socket.on('create_room', (data, ack) => {
    const pseudo = cleanName(data && data.pseudo);
    if (pseudo.length < 2) return done(ack, { ok: false, error: 'Pseudo trop court (2 caractères minimum).' });
    const room = {
      code: makeCode(), hostId: null, settings: { manches: 5, temps: 30 },
      players: new Map(), phase: 'lobby', round: 0, questionIds: [],
      answers: new Map(), timer: null, endsAt: 0, revealEndsAt: 0, lastReveal: null,
      touched: Date.now(),
    };
    rooms.set(room.code, room);
    const p = addPlayer(room, pseudo, socket);
    room.hostId = p.id;
    done(ack, { ok: true, code: room.code, pid: p.id });
    broadcast(room);
  });

  socket.on('join_room', (data, ack) => {
    const code = String((data && data.code) || '').toUpperCase().trim();
    const pseudo = cleanName(data && data.pseudo);
    const room = rooms.get(code);
    if (pseudo.length < 2) return done(ack, { ok: false, error: 'Pseudo trop court (2 caractères minimum).' });
    if (!room) return done(ack, { ok: false, error: 'Code inconnu. Vérifie les 4 lettres.' });
    if (room.phase !== 'lobby') return done(ack, { ok: false, error: 'La partie a déjà commencé.' });
    if (room.players.size >= MAX_PLAYERS) return done(ack, { ok: false, error: 'Salon plein (12 joueurs max).' });
    const taken = [...room.players.values()].some((p) => p.pseudo.toLowerCase() === pseudo.toLowerCase());
    if (taken) return done(ack, { ok: false, error: 'Ce pseudo est déjà pris dans ce salon.' });
    const p = addPlayer(room, pseudo, socket);
    room.touched = Date.now();
    done(ack, { ok: true, code: room.code, pid: p.id });
    broadcast(room);
  });

  socket.on('reconnect_room', (data, ack) => {
    const room = rooms.get(String((data && data.code) || '').toUpperCase());
    const p = room && room.players.get(data && data.pid);
    if (!p) return done(ack, { ok: false });
    clearTimeout(p.dcTimer);
    p.socketId = socket.id;
    p.connected = true;
    socket.data = { code: room.code, pid: p.id };
    socket.join(room.code);
    room.touched = Date.now();
    done(ack, { ok: true });
    broadcast(room);
  });

  socket.on('update_settings', (data, ack) => {
    const { room, player } = ctx();
    if (!room || room.hostId !== player.id || room.phase !== 'lobby') return done(ack, { ok: false });
    const m = Number(data && data.manches), t = Number(data && data.temps);
    if (m === 5 || m === 10) room.settings.manches = m;
    if (Number.isInteger(t) && t >= 10 && t <= 120) room.settings.temps = t;
    done(ack, { ok: true });
    broadcast(room);
  });

  socket.on('start_game', (_data, ack) => {
    const { room, player } = ctx();
    if (!room || room.hostId !== player.id || room.phase !== 'lobby') return done(ack, { ok: false, error: 'Action impossible.' });
    const connected = [...room.players.values()].filter((p) => p.connected).length;
    if (connected < MIN_PLAYERS) return done(ack, { ok: false, error: `Il faut au moins ${MIN_PLAYERS} joueurs.` });
    for (const p of room.players.values()) p.score = 0;
    room.questionIds = shuffle(QUESTIONS.map((_, i) => i)).slice(0, room.settings.manches);
    room.round = 0;
    room.touched = Date.now();
    done(ack, { ok: true });
    startRound(room);
  });

  socket.on('submit_answer', (data, ack) => {
    const { room, player } = ctx();
    if (!room || room.phase !== 'question') return done(ack, { ok: false });
    const text = cleanAnswer(data && data.text);
    if (!text) return done(ack, { ok: false });
    room.answers.set(player.id, text);
    room.touched = Date.now();
    done(ack, { ok: true });
    if ([...room.players.values()].filter((p) => p.connected).every((p) => room.answers.has(p.id))) {
      endRound(room);
    } else {
      broadcast(room);
    }
  });

  socket.on('skip_reveal', () => {
    const { room, player } = ctx();
    if (room && room.hostId === player.id) nextRound(room);
  });

  socket.on('play_again', (_data, ack) => {
    const { room, player } = ctx();
    if (!room || room.hostId !== player.id || room.phase !== 'final') return done(ack, { ok: false });
    for (const p of room.players.values()) p.score = 0;
    room.phase = 'lobby';
    room.round = 0;
    done(ack, { ok: true });
    broadcast(room);
  });

  socket.on('leave_room', () => {
    const { room, player } = ctx();
    if (!room) return;
    socket.leave(room.code);
    socket.data = {};
    removePlayer(room, player.id);
  });

  socket.on('disconnect', () => {
    const { room, player } = ctx();
    if (!room || player.socketId !== socket.id) return;
    player.connected = false;
    player.dcTimer = setTimeout(() => {
      if (player.connected || !rooms.has(room.code)) return;
      if (room.phase === 'lobby') return removePlayer(room, player.id);
      if (room.hostId === player.id) { transferHost(room); broadcast(room); }
    }, 30000);
    if (room.phase === 'question') maybeEndEarly(room);
    if (rooms.has(room.code)) broadcast(room);
  });
});

/* ---------- ménage & démarrage ---------- */

// Ménage : salons vides depuis plus de 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const anyone = [...room.players.values()].some((p) => p.connected);
    if (!anyone && now - room.touched > 10 * 60 * 1000) closeRoom(room);
  }
}, 60 * 1000).unref();

server.listen(PORT, () => {
  console.log(`Rareté en ligne sur http://localhost:${PORT}  (${QUESTIONS.length} questions)`);
});