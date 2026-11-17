'use strict';
// Simule une partie complète : 3 joueurs, 5 manches, via Socket.io.
const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const { io } = require('socket.io-client');
const { loadQuestions } = require('../scoring');

const PORT = 3111;
const Q = loadQuestions(path.join(__dirname, '..', 'questions.json'));
const server = spawn('node', ['server.js'], {
  cwd: path.join(__dirname, '..'),
  env: { ...process.env, PORT, REVEAL_MS: '60000' },
  stdio: ['ignore', 'inherit', 'inherit'],
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (s, ev, data) => new Promise((res) => s.emit(ev, data, res));

function client(name) {
  const s = io(`http://localhost:${PORT}`, { transports: ['websocket'] });
  const c = { s, name, state: null, waiters: [] };
  s.on('state', (st) => {
    c.state = st;
    c.waiters = c.waiters.filter((w) => !(w.cond(st) && (w.res(st), true)));
  });
  c.until = (cond) => (c.state && cond(c.state) ? Promise.resolve(c.state) : new Promise((res) => c.waiters.push({ cond, res })));
  return c;
}

(async () => {
  await wait(800);
  const [A, B, C] = ['Alice', 'Bob', 'Chloé'].map(client);

  const created = await emit(A.s, 'create_room', { pseudo: 'Alice' });
  assert.ok(created.ok && /^[A-Z]{4}$/.test(created.code), 'code à 4 lettres');
  const code = created.code;

  // erreurs attendues
  assert.ok(!(await emit(B.s, 'join_room', { code: 'ZZZZ', pseudo: 'Bob' })).ok, 'code inconnu refusé');
  assert.ok((await emit(B.s, 'join_room', { code, pseudo: 'Bob' })).ok);
  assert.ok(!(await emit(C.s, 'join_room', { code, pseudo: 'bob' })).ok, 'pseudo en double refusé');
  assert.ok((await emit(C.s, 'join_room', { code, pseudo: 'Chloé' })).ok);

  assert.ok(!(await emit(B.s, 'start_game', {})).ok, 'seul le chef lance');
  await emit(A.s, 'update_settings', { manches: 5, temps: 15 });
  assert.ok((await emit(A.s, 'start_game', {})).ok);

  for (let round = 1; round <= 5; round++) {
    const st = await A.until((s) => s.phase === 'question' && s.round === round);
    const q = Q.find((x) => x.texte === st.question.texte);
    const byPop = [...q.entries].sort((a, b) => b.pop - a.pop);
    const evident = byPop[0].nom, rare = byPop[byPop.length - 1].nom;
    const typo = byPop[1].nom.slice(0, -1) + (byPop[1].nom.length > 9 ? '' : '');

    // Alice et Bob : même réponse évidente. Chloé : la plus rare.
    await emit(A.s, 'submit_answer', { text: evident });
    assert.ok(!(await A.until(() => true)).reveal, 'pas de fuite avant la fin');
    await emit(B.s, 'submit_answer', { text: evident.toUpperCase() });
    await emit(C.s, 'submit_answer', { text: rare });

    const rv = await A.until((s) => s.phase === 'reveal' && s.round === round);
    const rows = Object.fromEntries(rv.reveal.rows.map((r) => [r.pseudo, r]));
    assert.strictEqual(rows.Chloé.status, 'unique');
    assert.ok(['partagee', 'annulee'].includes(rows.Alice.status) && rows.Alice.groupSize === 2);
    assert.ok(rows.Chloé.pts > rows.Alice.pts, 'la réponse rare bat la réponse évidente');
    console.log(`manche ${round}: "${q.texte}" -> Alice/Bob "${evident}" = ${rows.Alice.pts} | Chloé "${rare}" = ${rows.Chloé.pts}`);

    assert.ok(!(await emit(B.s, 'play_again', {})).ok);
    B.s.emit('skip_reveal'); // sans effet : pas le chef
    await wait(100);
    assert.strictEqual(A.state.phase, 'reveal', 'un non-chef ne peut pas passer');
    A.s.emit('skip_reveal');
  }

  const fin = await A.until((s) => s.phase === 'final');
  console.log('classement final :', fin.ranking.map((r) => `${r.rank}. ${r.pseudo} ${r.score}`).join(' | '));
  assert.strictEqual(fin.ranking[0].pseudo, 'Chloé');
  assert.ok(fin.ranking[0].score > fin.ranking[1].score);

  // rejouer
  assert.ok((await emit(A.s, 'play_again', {})).ok);
  const lobby = await A.until((s) => s.phase === 'lobby');
  assert.ok(lobby.players.every((p) => p.score === 0));

  // reconnexion : Bob se déconnecte puis revient avec son identifiant
  const bobId = B.state.you;
  B.s.disconnect();
  const B2 = client('Bob2');
  await new Promise((r) => B2.s.on('connect', r));
  assert.ok((await emit(B2.s, 'reconnect_room', { code, pid: bobId })).ok);
  await B2.until((s) => s.phase === 'lobby' && s.you === bobId);

  console.log('\nPARTIE COMPLÈTE OK');
  [A, B2, C].forEach((c) => c.s.close());
  server.kill();
  process.exit(0);
})().catch((e) => {
  console.error('ÉCHEC :', e);
  server.kill();
  process.exit(1);
});
