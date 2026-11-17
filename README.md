# Rareté – jeu multijoueur façon Pointless / Jackbox

Node.js + Express + Socket.io. Pas de base de données, pas de compte : les salons vivent en mémoire.
Jouable sur navigateur PC et téléphone (page unique, responsive).

## Lancer en local

```bash
npm install
npm start
# → http://localhost:3000
```

Pour jouer avec des amis sur le même Wi-Fi : ouvre `http://IP-DE-TON-PC:3000` sur les téléphones
(`ipconfig` sous Windows, `ifconfig` / `ip a` sous Mac/Linux).

Pour jouer à distance sans héberger : `npx cloudflared tunnel --url http://localhost:3000`
(ou ngrok) te donne un lien public temporaire.

## Héberger gratuitement (Render)

1. Mets le dossier sur GitHub.
2. Sur render.com : **New → Web Service**, choisis le dépôt.
3. Build command : `npm install` — Start command : `npm start` — plan **Free**.

Les WebSockets sont gérés. Sur le plan gratuit, le serveur se met en veille après ~15 min d'inactivité
(le premier chargement prend alors ~30 s) et les salons en cours sont perdus au redémarrage.
Railway, Fly.io ou un petit VPS marchent aussi sans rien changer.

## Règles

- Un joueur crée un salon (code à 4 lettres), règle le nombre de manches (5 ou 10) et le temps par question.
- Les autres rejoignent avec leur pseudo + le code (ou le lien partagé).
- La manche se termine quand le chrono tombe à 0 ou quand tout le monde a répondu.
- Fin de partie : podium + classement. Le chef de salon peut relancer une partie.

## Calcul des points

Chaque question a une liste de réponses valides, avec une popularité a priori (0-100) :
`"Guyana|8|alias1;alias2"` = nom, popularité, alias éventuels.

```
rareté   = max(5, 100 - 0,95 × popularité)        → de 5 (évidente) à 99 (très rare)
points   = rareté × coefficient de partage
           1 joueur : ×1   |   2 joueurs : ×0,25   |   3 : ×0,10   |   4 et + : annulée
```

La saisie est reconnue malgré la casse, les accents, les articles (« le », « l' »), les tirets
et les petites fautes (distance de Levenshtein ≤ 1 ou 2 selon la longueur du mot).
Une réponse absente de la liste est affichée « Non reconnue » et vaut 0.

## Ajouter ou modifier des questions

Édite `questions.json` :

```json
{ "id": 31, "categorie": "Géographie", "texte": "Citez un océan",
  "r": ["Atlantique|90", "Pacifique|88", "Indien|60", "Arctique|35", "Austral|5|antarctique"] }
```

Plus la liste est longue, moins il y aura de « Non reconnue » injustes. Ajoute-y les réponses
que tes joueurs tentent et qui sont refusées.

## Fichiers

| Fichier | Rôle |
|---|---|
| `server.js` | Salons, manches, chrono, Socket.io |
| `scoring.js` | Normalisation, reconnaissance floue, calcul de rareté |
<<<<<<< HEAD
| `questions.json` | 530 questions, ~8 830 réponses valides |
=======
| `questions.json` | 30 questions, ~1 370 réponses valides |
>>>>>>> 0651caf9a2c21f85f93c9664b7e61ec453fe7fb0
| `public/index.html` | Interface (accueil, salon, question, résultats, podium) |
| `test/` | `npm test` : tests du scoring + simulation d'une partie à 3 joueurs |
