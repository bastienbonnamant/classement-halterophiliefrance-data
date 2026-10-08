# classement-halterophiliefrance-data

Données du classement affiché sur [halterophiliefrance.fr](https://halterophiliefrance.fr).

Chaque lundi, une GitHub Action lit les résultats publiés sur
[scoresheet.ffhaltero.fr](https://scoresheet.ffhaltero.fr/scoresheet/) et met à jour les fichiers
du dossier `data/` :

- `data/index.json` : liste des saisons disponibles ;
- `data/<saison>.json` : un résultat par athlète et par compétition (la saison 9 = 2025/2026).

Le widget du site charge ces fichiers et calcule le classement dans le navigateur.

## Lancer en local

```bash
npm install
npm run build                  # saison en cours
npm run build -- --season=8    # une saison précise
npm run build -- --all         # toutes les saisons
npm run build -- --limit=15    # test rapide (15 compétitions)
```

Le scraper s'identifie auprès du site source, limite à 3 requêtes en parallèle avec des pauses,
et s'arrête si plus de 20 % des requêtes échouent.
