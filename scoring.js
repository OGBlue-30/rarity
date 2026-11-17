'use strict';
/**
 * Calcul de rareté.
 *
 * Chaque question possède une liste de réponses valides, chacune avec une
 * "popularité" a priori (0-100) = à quel point une personne moyenne la cite
 * spontanément. 100 = tout le monde, 1 = presque personne.
 *
 * Points d'une réponse =
 *     rareté a priori (100 - 0.95*popularité, entre 5 et 100)
 *   x coefficient de partage dans le salon
 *       1 joueur  -> x1    (réponse unique)
 *       2 joueurs -> x0.25 (partagée)
 *       3 joueurs -> x0.10
 *       4+        -> x0    (annulée)
 *
 * La saisie est reconnue malgré les accents, la casse, les articles
 * ("le", "la", "l'"), les tirets et les petites fautes de frappe.
 */
const fs = require('fs');

const ARTICLES = new Set(['le', 'la', 'les', 'l', 'un', 'une', 'des', 'du', 'de', 'd', 'the']);
const SHARE = [1, 0.25, 0.1]; // index = nombre de joueurs - 1 ; au-delà : 0
// Popularité attribuée à une réponse valide absente de la liste (validée par l'IA).
// 10 -> rareté 90 ; plus c'est bas, plus ça rapporte.
const AI_POP = Number(process.env.AI_POP || 10);

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/œ/g, 'oe').replace(/æ/g, 'ae')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim().replace(/\s+/g, ' ');
}

function key(s) {
  const t = normalize(s).split(' ').filter(Boolean);
  while (t.length > 1 && ARTICLES.has(t[0])) t.shift();
  return t.join(' ');
}

function lev(a, b) {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

//function rarityOf(pop) {
//  return Math.max(5, Math.min(100, Math.round(100 - pop * 0.95)));
//}

function rarityOf(pop) {
  // pop représente le pourcentage de popularité (ex: 98 = très courant, 2 = très rare)
  // On inverse : 100 - pop donne directement la rareté en points.
  // Math.max/min s'assurent de rester entre 5 et 100 points.
  return Math.max(5, Math.min(100, Math.round(100 - pop)));
}

// "Nom|popularité|alias1;alias2"
function parseEntry(str, id) {
  const [nom, pop, al] = String(str).split('|');
  const aliases = al ? al.split(';') : [];
  const keys = [...new Set([nom, ...aliases].map(key).filter(Boolean))];
  return { id, nom: nom.trim(), pop: Number(pop), keys };
}

function buildQuestion(raw, index) {
  const entries = raw.r.map((s, i) => parseEntry(s, i));
  const exact = new Map();
  const flatList = [];
  for (const e of entries) {
    if (!Number.isFinite(e.pop)) throw new Error(`Question ${raw.id}: popularité invalide pour "${e.nom}"`);
    for (const k of e.keys) {
      for (const variant of [k, k.replace(/ /g, '')]) {
        const prev = exact.get(variant);
        if (prev !== undefined && prev !== e.id) {
          console.warn(`[questions] conflit "${variant}" dans la question ${raw.id}`);
        } else {
          exact.set(variant, e.id);
        }
      }
      flatList.push([k.replace(/ /g, ''), e.id]);
    }
  }
  return { index, id: raw.id, texte: raw.texte, categorie: raw.categorie || '', entries, exact, flatList };
}

function loadQuestions(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return raw.map(buildQuestion);
}

function match(q, text) {
  const k = key(text);
  if (!k) return null;
  const flat = k.replace(/ /g, '');
  let id = q.exact.get(k);
  if (id === undefined) id = q.exact.get(flat);
  if (id !== undefined) return q.entries[id];

  // --- MODIFICATION ICI ---
  // On autorise un peu plus d'erreurs selon la longueur du texte
  const max = flat.length <= 4 ? 0 : flat.length <= 7 ? 1 : flat.length <= 11 ? 2 : 3;
  // ------------------------

  if (max === 0) return null;
  let best = Infinity, bestId = null, tie = false;
  for (const [kk, eid] of q.flatList) {
    if (Math.abs(kk.length - flat.length) > max) continue;
    const d = lev(flat, kk);
    if (d > max) continue;
    if (d < best) { best = d; bestId = eid; tie = false; }
    else if (d === best && eid !== bestId) tie = true;
  }
  return bestId !== null && !tie ? q.entries[bestId] : null;
}

/**
 * @param q        question construite (buildQuestion)
 * @param answers  Map playerId -> texte saisi
 * @param players  liste des playerId qui participent
 * @param verdicts (optionnel) Map playerId -> nom canonique, pour les réponses
 *                 absentes de la liste mais jugées valides par l'IA
 */
function scoreRound(q, answers, players, verdicts) {
  const rows = [];
  const groups = new Map();

  for (const pid of players) {
    const text = answers.get(pid) || '';
    if (!text) { rows.push({ pid, text: '', status: 'none', pts: 0, rarete: 0, groupSize: 0, canonical: '' }); continue; }
    let entry = match(q, text);
    let ia = false;
    if (!entry && verdicts && verdicts.has(pid)) {
      const nom = verdicts.get(pid);
      // l'IA a peut-être normalisé vers une réponse déjà listée ; sinon, réponse inédite
      entry = match(q, nom) || { id: 'ia:' + (key(nom) || nom), nom, pop: AI_POP };
      ia = true;
    }
    if (!entry) { rows.push({ pid, text, status: 'inconnue', pts: 0, rarete: 0, groupSize: 0, canonical: '' }); continue; }
    rows.push({ pid, text, entry, canonical: entry.nom, ia });
    groups.set(entry.id, (groups.get(entry.id) || 0) + 1);
  }

  for (const r of rows) {
    if (!r.entry) continue;
    const n = groups.get(r.entry.id);
    const factor = SHARE[n - 1] ?? 0;
    r.groupSize = n;
    r.rarete = rarityOf(r.entry.pop);
    r.pts = Math.round(r.rarete * factor);
    r.status = n === 1 ? 'unique' : factor > 0 ? 'partagee' : 'annulee';
  }

  // Pépites : réponses valides que personne n'a trouvées, les plus rares d'abord
  const used = new Set(groups.keys());
  const autres = q.entries
    .filter((e) => !used.has(e.id))
    .sort((a, b) => a.pop - b.pop)
    .slice(0, 3)
    .map((e) => ({ nom: e.nom, pts: rarityOf(e.pop) }));

  return { rows: rows.map(({ entry, ...rest }) => rest), autres };
}

module.exports = { normalize, key, match, rarityOf, scoreRound, loadQuestions, buildQuestion };
