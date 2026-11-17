'use strict';
const assert = require('assert');
const path = require('path');
const { loadQuestions, match, scoreRound, key } = require('../scoring');

const Q = loadQuestions(path.join(__dirname, '..', 'questions.json'));
assert.strictEqual(Q.length, 530, '530 questions attendues');
for (const q of Q) assert.ok(q.entries.length >= 4, `question ${q.id} : trop peu de réponses`);

const pays = Q.find((q) => q.id === 1);
const nom = (txt) => (match(pays, txt) || {}).nom;

// normalisation, articles, accents, casse
assert.strictEqual(nom('bresil'), 'Brésil');
assert.strictEqual(nom('  LE BRÉSIL '), 'Brésil');
assert.strictEqual(nom('equateur'), 'Équateur');
// fautes de frappe
assert.strictEqual(nom('Argentne'), 'Argentine');
assert.strictEqual(nom('Colombi'), 'Colombie');
// pays hors liste ou faux
assert.strictEqual(nom('France'), undefined);
assert.strictEqual(nom('Iran'), undefined);
// alias / sans espaces / tirets
const hero = Q.find((q) => q.id === 8);
assert.strictEqual(match(hero, 'spiderman').nom, 'Spider-Man');
assert.strictEqual(match(hero, 'Spider Man').nom, 'Spider-Man');
const spiel = Q.find((q) => q.id === 2);
assert.strictEqual(match(spiel, 'ET').nom, "E.T. l'extra-terrestre");
assert.strictEqual(match(spiel, 'les dents de la mer').nom, 'Les Dents de la mer');
assert.strictEqual(key("L'Extra-Terrestre"), 'extra terrestre');

// calcul des points
const ans = (obj) => new Map(Object.entries(obj));
let res = scoreRound(pays, ans({ a: 'Brésil', b: 'Guyana', c: 'Pérou', d: 'Zzzz' }), ['a', 'b', 'c', 'd', 'e']);
const by = Object.fromEntries(res.rows.map((r) => [r.pid, r]));
assert.strictEqual(by.a.status, 'unique');
assert.ok(by.b.pts > by.c.pts && by.c.pts > by.a.pts, 'plus rare = plus de points');
assert.ok(by.b.pts <= 100 && by.b.pts >= 90, 'Guyana vaut ~90+');
assert.strictEqual(by.d.status, 'inconnue');
assert.strictEqual(by.d.pts, 0);
assert.strictEqual(by.e.status, 'none');

// partage : 2 joueurs = 25 %, 3 = 10 %, 4+ = annulée
const base = scoreRound(pays, ans({ a: 'Pérou' }), ['a']).rows[0].pts;
res = scoreRound(pays, ans({ a: 'Pérou', b: 'perou' }), ['a', 'b']);
assert.strictEqual(res.rows[0].status, 'partagee');
assert.strictEqual(res.rows[0].pts, Math.round(base * 0.25));
res = scoreRound(pays, ans({ a: 'Pérou', b: 'Pérou', c: 'Pérou', d: 'Pérou' }), ['a', 'b', 'c', 'd']);
assert.ok(res.rows.every((r) => r.status === 'annulee' && r.pts === 0));

console.log('scoring OK (' + Q.reduce((n, q) => n + q.entries.length, 0) + ' réponses valides au total)');
