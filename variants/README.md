# Variants de configuration

Un variant est une copie de `src/config.js` avec d'autres valeurs. Aucun format
particulier : le fichier doit simplement définir `TP_CONFIG`.

```bash
cp src/config.js variants/mon-essai.js
# éditer les valeurs
node tools/replay.js corpus.json --compare variants/mon-essai.js
```

Ce qui compte dans le rapport de comparaison n'est pas l'écart de score mais le
**taux de brassage** : si aucune source ne change de rang, la modification ne
change rien à ce que vous lisez en premier, quelle que soit l'ampleur des deltas.
