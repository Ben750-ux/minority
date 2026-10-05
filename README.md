# Minority

Jeu de bluff et de déduction. Un joueur pose la question, tous les autres répondent
**OUI**, **NON** ou **BLANC**. Les joueurs de la minorité gagnent des points ; un vote
blanc isolé est une prime, deux blancs ou plus sont un malus.

## Règles

- **Le questionneur ne vote pas.** Pendant son tour, il ne marque rien.
- **Minorité** : le plus petit groupe parmi *oui* et *non* (un groupe vide ne compte pas).
  Chaque membre gagne `pMinority` points. Les autres ne gagnent rien.
- **Blanc unique** : si un seul joueur a voté blanc, il gagne `pBlankSolo`.
- **Blanc multiple** : si deux joueurs ou plus ont voté blanc, chacun perd `pBlankMulti`.
- **Fin** : premier joueur à atteindre `pTarget` points.
- Timers et barèmes sont réglés par le maître de jeu à la création du salon.

## Lancer en local

```bash
npm start      # http://localhost:3000
npm test       # 46 tests de bout en bout
npm run reset  # vide data/minority.db
```

Aucune dépendance npm : `node:sqlite` et les modules ES natifs couvrent tout.

## Variables d'environnement

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `3000` | Port d'écoute (Render l'injecte) |
| `HOST` | `0.0.0.0` | Interface d'écoute |
| `DATA_DIR` | `<projet>/data` | Dossier de la base ; sur Render, `/var/data` |
| `DB_PATH` | `<DATA_DIR>/minority.db` | Chemin exact de la base |

## Instances multiples (développement)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\server\start-instances.ps1
```

Lance 3 serveurs sur les ports 3001-3003 avec une base chacun.

## Déploiement

Le serveur est dans `server/` et sert aussi le front :

```
server/
  index.js       HTTP, routes REST, flux SSE
  game.js        moteur de règles, timers, calcul des points
  db.js          schéma SQLite + requêtes préparées
  test.js        46 tests
  client-test.js exécute le module client avec un shim DOM
```

- `GET /api/health` — sonde de santé pour Render
- `GET /api/rooms/:code/events` — flux SSE, état du salon en temps réel

### Render

`render.yaml` est fourni : runtime Node, `npm start`, sonde sur `/api/health`.

```bash
git init
git add .
git commit -m "Minority"
git remote add origin <ton-depot-github>
git push -u origin main
```

Puis dans Render : **New → Web Service** → choisis le dépôt. Render détecte `render.yaml`
automatiquement.

**Plan gratuit** : le disque système est effacé à chaque redéploiement, donc
`minority.db` repart à zéro. Les parties en cours sont perdues au redémarrage — c'est
acceptable pour tester. Pour garder l'historique, passe le plan payant et ajoute le disk
sur `/var/data` (voir les commentaires dans `render.yaml`).

## Front

| Fichier | Contenu |
|---|---|
| `index.html` | Page d'accueil |
| `pages/login.html` | Pseudo + code de salon |
| `pages/lobby.html` | Salon, réglages, joueurs |
| `pages/game.html` | Question, vote, révélation, gagnant |
| `js/net.js` | Session, `fetch`, SSE |