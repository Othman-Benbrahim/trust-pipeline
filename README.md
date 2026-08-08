# Trust Pipeline

[![CI](https://github.com/Othman-Benbrahim/trust-pipeline/actions/workflows/ci.yml/badge.svg)](https://github.com/Othman-Benbrahim/trust-pipeline/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-1D5C4E.svg)](LICENSE)

Add-on Firefox (Manifest V3) qui agrège des flux RSS/Atom/JSON Feed et attribue à chaque **source** un score de confiance qui se dégrade avec le silence.

Aucun backend, aucun processus permanent, aucune donnée qui sort du navigateur. Chaque point de score est justifiable par une règle lisible dans `src/config.js` — et rejouable hors ligne pour tester un autre réglage.

## Installation

**Firefox 142 minimum** (`about:support` pour vérifier). La clé `data_collection_permissions`, obligatoire pour toute nouvelle extension, n'existe pas avant.

### La méthode qui marche

1. Télécharger **`trust-pipeline.zip`**
2. Ouvrir `about:debugging#/runtime/this-firefox`
3. **Charger un module complémentaire temporaire…**
4. Sélectionner **le fichier `.zip` lui-même** — ne pas le décompresser

Firefox accepte directement une archive. C'est la seule méthode qui garantit l'arborescence.

### Pourquoi le zip et pas les fichiers séparés

Le manifeste référence `src/config.js`, `popup/popup.html`, `icons/icon-48.png`. Si les fichiers sont récupérés à plat, dans un seul dossier sans les sous-répertoires, le résultat est déroutant : **le manifeste reste valide, l'extension s'installe, le bouton apparaît dans la barre d'outils** — mais chaque chemin pointe dans le vide. L'icône ne s'affiche pas et le popup s'ouvre sur une pastille blanche vide. Aucune erreur explicite nulle part.

`npm run test:structure` vérifie désormais que chaque chemin référencé existe réellement.

Si vous préférez travailler depuis les sources décompressées, sélectionnez `manifest.json` (le fichier, pas le dossier) après avoir vérifié que `src/`, `popup/` et `icons/` sont bien présents à côté.

### Au premier lancement

Trois flux de démonstration sont amorcés et une bannière **Autoriser** s'affiche. Tant qu'elle n'est pas validée, les flux restent en attente : comportement attendu, pas une panne.

### Si ça ne se charge toujours pas

`about:debugging` donne l'erreur exacte, à deux endroits :

- message rouge sous la ligne de l'extension → refus de manifeste ;
- bouton **Inspecter** → onglet Console → exception du background.

```bash
npm install     # jsdom, uniquement pour les harnais
npm test        # 6 suites
npm run build   # régénère trust-pipeline.zip
npm run lint    # addons-linter, le validateur officiel AMO
```

---

## Arborescence

```
trust-pipeline.zip     archive prête à charger dans Firefox (manifeste à la racine)
build.js               assemble l'archive et vérifie la position du manifeste
manifest.json          permissions storage + alarms, host permissions optionnelles
src/config.js          constantes de scoring, règles, flux par défaut
src/scoring.js         décroissance exponentielle, évaluation, ré-ancrage, classement
src/xml.js             parseur XML pur JS + décodage d'entités
src/parser.js          RSS 2.0 / RSS 1.0 (RDF) / Atom / JSON Feed → forme unique
src/store.js           accès unique à browser.storage.local + schéma
src/background.js      alarms, messages, permissions, cycle de synchronisation
popup/                 classement, force sync, votes, bannière d'autorisation
icons/                 PNG 16 à 128 px
tests/                 6 suites unitaires + 2 harnais d'intégration + corpus de démonstration
tools/replay.js        rejoue un corpus sous un jeu de règles arbitraire
variants/              configurations alternatives à comparer
```

---

## Lire le classement

Chaque ligne est une source, ordonnée par score effectif.

| Élément | Sens |
|---|---|
| `01` `02` `03` | rang courant — il change à chaque synchronisation |
| Score à droite | score effectif sur 100, décroissance déjà appliquée |
| Barre pleine (vert) | ce score, à l'échelle 0–100 |
| Zone hachurée (ocre) | ce que 7 jours de silence supplémentaires coûteraient |
| Repère central | 50, le neutre — toute source démarre là |
| Badge `FR` / `EN` | langue détectée — les signaux sémantiques utilisent ce lexique |
| `silence 2 h` | temps écoulé depuis la dernière publication observée |
| `16 articles` | articles inédits comptés depuis l'ajout de la source |
| `+` `−` | vote manuel, ±5 |

La zone hachurée est le seul élément qui parle du futur. Elle répond à « que se passe-t-il si cette source se tait ? » — courte pour un flux actif, longue pour un flux qui approche du décrochage.

**Pourquoi ce score ?** ouvre le journal de la source : les six derniers mouvements, chacun avec son delta et son motif (`3 article(s) — sourcing « selon » ×2, contenu mince`). Les motifs sont enregistrés à l'ingestion et jamais recalculés après coup. Un score qu'on ne peut pas justifier ne vaut rien.

---

## Schéma de données

Quatre clés dans `browser.storage.local` :

```js
{
  schema_version: 1,
  sources: [ Source ],   // persisté déjà trié par score effectif
  items:   [ Item ],     // flux fusionné, plafonné à 500
  meta:    { last_sync_ts, last_sync_duration_ms, last_sync_trigger, syncing }
}
```

### Source

| Champ | Rôle |
|---|---|
| `id`, `url`, `title`, `enabled` | identité, `id` dérivé de l'URL normalisée |
| `score_anchor` | **valeur ancrée — ce n'est pas le score affiché** |
| `anchor_ts` | quand l'ancre a été écrite (audit) |
| `last_active_ts` | dernière publication observée = origine de la décroissance |
| `last_fetch_ts`, `last_status`, `last_error`, `error_streak` | télémétrie réseau ; `last_status ∈ {ok, error, blocked}` |
| `items_seen`, `seen_ids` | statistiques et déduplication (fenêtre de 200) |
| `history[]` | 20 derniers mouvements `{ ts, from, to, delta, reason }` |

### Item

`{ id, source_id, title, link, summary, author, published_ts, fetched_ts, score_at_ingest }`

`score_at_ingest` fige la confiance accordée à la source **au moment** où l'article est entré. Un article ne doit pas être relu à l'aune d'un score qui a bougé depuis.

---

## Le modèle de score

Le score affiché n'est jamais persisté. Il est **dérivé** :

```
effectif(t) = FLOOR + (score_anchor − FLOOR) · exp(−λ · max(0, silence − grâce))
λ = ln(2) / demi_vie
```

Le piège que ça évite : appliquer `score *= exp(−λΔt)` à chaque réveil de l'alarme. Avec une synchro toutes les 30 minutes, le facteur se compose 48 fois par jour et le score s'effondre en quelques heures. Ici l'opération est **idempotente** — la recalculer mille fois donne le même résultat.

L'ancre n'est réécrite que sur événement : nouvel article, vote manuel, échec de fetch. Le ré-ancrage cristallise d'abord la décroissance accumulée, puis applique le delta.

### Réglages (`config.js`)

| Paramètre | Valeur | Effet |
|---|---|---|
| `HALF_LIFE_DAYS` | 14 | 14 jours de silence → la part au-dessus du plancher est divisée par 2 |
| `GRACE_DAYS` | 2 | un flux hebdomadaire n'est pas puni comme un flux mort |
| `FLOOR` | 5 | une source moribonde peut toujours ressusciter |
| `MAX_DELTA_PER_SYNC` | ±8 | une salve de 60 articles ne peut pas faire exploser un score |
| `MANUAL_VOTE` | ±5 | poids d'une validation humaine |
| `FETCH_ERROR_PENALTY` | 1.5 | par échec réseau réel (jamais pour une permission manquante) |

### Signaux d'évaluation

Le moteur ne contient aucune règle : il exécute les signaux déclarés dans `TP_CONFIG.SIGNALS`. Ajouter un critère revient à ajouter une entrée `{ id, label, weight, test }` — aucune ligne de `scoring.js` à toucher.

**Par article**

| Signal | Poids | Déclencheur |
|---|---|---|
| `sourcing` | +1,2 | « selon », « étude », « rapport », « a déclaré »… |
| `quantitative` | +0,8 | pourcentage, montant, unité, ou nombre ≥ 3 chiffres |
| `quotes` | +0,6 | guillemets typographiques ou citation entre `"` |
| `links` | +1,0 | balise `<a href>` dans le HTML brut de la description |
| `categories` | +0,5 | au moins une `<category>` renseignée |
| `updated` | +0,5 | article édité plus d'une heure après publication |
| `author` | +0,4 | auteur renseigné dans le flux |
| `thin` | −0,6 | résumé sous 120 caractères |
| `punctuation` | −1,5 | `!!!`, `?!`, ou points de suspension en fin de titre |
| `dogmatic` | −1,5 | « incontestable », « la vérité sur », « on nous cache »… |
| `emotional` | −1,8 | « honteux », « massacre », « lamentable », « révoltant »… |
| `caps` | −2,0 | plus de 50 % de majuscules dans le titre |
| `bait` | −2,5 | « vous ne devinerez jamais », « top 10 », « cliquez »… |

**Par salve**

| Signal | Poids | Déclencheur |
|---|---|---|
| `bot_velocity` | −3,0 | 4 articles ou plus horodatés à la même seconde exacte |

Un rythme de publication ne s'observe pas article par article : ce signal est évalué sur l'ensemble des articles inédits d'une synchronisation.

### Langues

Les quatre signaux lexicaux (`sourcing`, `bait`, `dogmatic`, `emotional`) existent en **français et en anglais**, dans `TP_CONFIG.LEXICON.fr` et `.en`. Chaque article est évalué dans SA langue — un article anglais passé au lexique français ne pourrait que perdre des points, jamais en gagner, et le classement mélangé serait un artefact.

La résolution suit trois niveaux :

1. **Détection sur l'article** — comptage de mots-outils (les mots grammaticaux sont les plus fréquents de toute langue et ne se recouvrent presque pas entre fr et en). Une marge minimale de 2 est exigée pour trancher ; un titre de six mots ne suffit généralement pas. Aucune bibliothèque, aucun appel réseau.
2. **Langue de la source** — chaque détection sûre vote pendant l'ingestion, la majorité devient `source.lang`. Le vote court sur TOUS les articles parsés, y compris au premier passage (celui qui en montre le plus), pas seulement les inédits. C'est le filet pour les titres trop courts.
3. **Défaut** — `LANG.FALLBACK` (`fr`) quand rien d'autre ne tranche.

La langue retenue est affichée sur chaque ligne du classement (badge `FR`/`EN`), pour qu'une détection erronée soit visible et corrigeable.

L'équité est testée de bout en bout : un article vertueux obtient le même delta dans les deux langues, un article toxique aussi, et les lexiques sont étanches — « choc » est inerte dans un texte anglais, « slams » est inerte dans un texte français. Ajouter une langue = ajouter `LEXICON.xx` + `LANG.STOPWORDS.xx`, sans toucher au moteur.

### Trois arbitrages non évidents

**Le plafond par article est structurel, pas cosmétique.** Un titre peut désormais déclencher six pénalités cumulées (−9,9 au total). Sans `MAX_ITEM_LOSS`, ce seul article saturerait à lui seul le budget de la salve entière et masquerait les vingt autres. Les plafonds sont asymétriques — +3 en gain, −4 en perte : la confiance se gagne plus lentement qu'elle ne se perd.

**`<lastBuildDate>` ne sert pas à détecter une mise à jour.** Cette balise décrit le *canal*, pas l'article. La comparer au `pubDate` d'un article ferait feu à chaque publication, sur tous les flux, en permanence. Le signal `updated` lit `atom:updated`, `dc:modified` ou `date_modified`, au niveau de l'article, et exige un écart d'au moins une heure.

**Deux faux positifs francophones sont neutralisés explicitement.** Les sigles sont retirés du titre avant le calcul du ratio de majuscules, sans quoi « Le PSG affronte l'OM » passerait pour un hurlement typographique. Et les années nues sont exclues de l'ancrage chiffré : « les accords de 1995 » n'est pas une mesure. Les deux cas sont couverts par `tests/test-signals.js`.

### Garde-fous d'ingestion

- **Le premier passage n'est pas scoré.** Un flux exposant 50 articles archivés fausserait le score initial. La première ingestion mémorise les identifiants, rien de plus.
- **Zéro nouveauté ≠ événement.** Quand un fetch ne rapporte rien, on ne ré-ancre pas : la décroissance continue de courir depuis `last_active_ts`.
- **Permission manquante ≠ échec.** Statut `blocked`, delta nul.
- **Un signal qui lève est ignoré.** Une expression régulière défectueuse ne doit pas interrompre l'ingestion des vingt autres articles.

---

## Déclenchement

| Origine | Chemin |
|---|---|
| Alarme périodique | `alarms.onAlarm` → `runSync('alarm')` |
| Bouton Synchroniser | popup → `sendMessage({type:'FORCE_SYNC'})` → `runSync('manual')` |
| Ajout de source | demande de permission → `ADD_SOURCE` → synchro immédiate |
| Installation | `runtime.onInstalled` → amorçage + première passe |

Un verrou mémoire (`syncInFlight`) empêche l'alarme et un clic simultanés de lancer deux cycles. Les flux sont interrogés en parallèle : ils sont indépendants.

Les écouteurs sont enregistrés **de façon synchrone à la racine** de `background.js`. Obligatoire sur une event page MV3 : elle est déchargée quand elle est inactive, et c'est l'événement lui-même qui la réveille.

---

## Tests

```bash
npm test
```

| Suite | Portée |
|---|---|
| `test-lang.js` | 20 assertions : détection fr/en, marge d'incertitude, cascade détection→source→défaut, lexiques anglais, étanchéité croisée, équité de delta entre langues, disjonction des stopwords |
| `test-signals.js` | 30 assertions : chaque signal isolé, faux positifs francophones (sigles, années), plafonds par article, seuil de rafale, résistance à un signal défectueux, chaîne parser → scoring |
| `test-replay.js` | 21 assertions : isolation des moteurs, déterminisme, corpus jamais muté, discrimination qualité/appât dans les deux langues, fidélité au premier lot non scoré, CLI |
| `test-scoring.js` | 15 assertions : grâce, demi-vie exacte, idempotence sur 1000 lectures, asymptote au plancher, bornes 0–100, écrêtage de salve, tri |
| `test-xml.js` | 31 assertions : `>` dans une valeur d'attribut, CDATA, DOCTYPE à sous-ensemble interne, préfixes, auto-fermeture, double encodage, rejets, volume |
| `test-parser.js` | 23 assertions : `dc:creator`, liens relatifs, `rel="alternate"`, items RDF hors channel, JSON Feed, rejet du HTML |
| `harness-background.js` | charge les 6 scripts dans l'ordre du manifeste avec `storage`/`alarms`/`fetch`/`permissions` simulés, rejoue installation, synchro, vote, panne réseau, permission refusée |
| `harness-popup.js` | charge `popup.html` + `popup.js` dans un DOM réel et vérifie le rendu complet |
| `test-structure.js` | chaque chemin du manifeste et du HTML existe sur le disque, ordre de chargement des modules respecté, aucun appel au DOM dans le background |

Le harnais popup couvre notamment une régression réelle : `.grant { display: flex }` écrasait la règle `[hidden] { display: none }` du navigateur, et la bannière « Autoriser » restait affichée, vide, en permanence. Un `display` explicite dans la feuille auteur bat toujours l'attribut `hidden`. La parade est une règle globale `[hidden] { display: none !important }`.

Les deux harnais existent parce qu'une exception au niveau racine d'une event page est invisible autrement : elle casse tout sans laisser de trace exploitable.

---

## Mode replay — calibrer sans attendre

Toutes les constantes du moteur sont des hypothèses : poids des signaux, demi-vie de 14 jours, lexiques. Les régler à l'aveugle en production demande des semaines et n'autorise aucune comparaison — on ne voit jamais ce qu'aurait donné l'autre réglage.

Le replay est possible parce que **le score n'est jamais stocké** : il est dérivé d'une ancre, et le corpus exporté conserve les champs bruts lus par les signaux plutôt que le résultat de leur évaluation. Rejouer, c'est simplement dériver autrement.

```bash
# 1. Popup → « Exporter le corpus » (aucune permission requise, rien ne transite par un serveur)
# 2. Rapport sur les règles actuelles
npm run replay -- corpus.json

# 3. Comparer un réglage alternatif
cp src/config.js variants/mon-essai.js   # éditer les valeurs
npm run replay -- corpus.json --compare variants/mon-essai.js
```

Trois sorties :

**Taux de déclenchement par signal et par langue.** Le tableau le plus utile. Un signal à 0 % est un lexique mort ; un signal à 90 % ne discrimine rien. Les signaux muets dans une langue sont marqués `←`.

**Classement rejoué**, avec creux et pic de chaque source sur la période.

**Comparaison de deux configurations.** Ce qui compte n'est pas l'écart de score mais le **taux de brassage** : si aucune source ne change de rang, la modification ne change rien à ce que vous lisez en premier, quelle que soit l'ampleur des deltas.

Par défaut le replay reproduit la production, premier lot non scoré compris. `--score-all` lève cette règle quand on cherche à maximiser le signal disponible plutôt qu'à prédire le comportement réel.

### Ce que le replay a déjà trouvé

Deux bugs invisibles autrement, dès le premier passage sur un corpus de démonstration :

- Un titre anglais entièrement en capitales échappait au signal `caps`. Les mots anglais font quatre à cinq lettres, donc le retrait des sigles — nécessaire pour épargner « Le PSG affronte l'OM » — les effaçait tous et il ne restait rien à mesurer.
- Le lexique dogmatique anglais ne contenait que les formes contractées. « they do not want you to know » ne déclenchait rien.

Les deux sont désormais verrouillés par `tests/test-lang.js`.

---

## Publier et distribuer

Le dépôt est prêt pour GitHub et soumissible à AMO sans retouche.

| Élément | État |
|---|---|
| `addons-linter` | 0 erreur, 0 avertissement, 0 notice sur l'archive |
| `data_collection_permissions` | `["none"]` — aucune collecte déclarée |
| Permissions hôtes | optionnelles, demandées domaine par domaine |
| Code minifié | aucun — pas de soumission de sources séparée à fournir |
| Dépendances runtime | aucune — `jsdom` et `addons-linter` sont en `devDependencies` |
| CI | `npm test` + validation AMO à chaque push |

Avant publication, remplacez `VOTRE-COMPTE` dans `package.json`, `manifest.json` (`homepage_url`) et ce README. Pour une soumission AMO, incrémentez `version` dans `manifest.json` **et** `package.json` — les deux doivent rester alignés.

La licence par défaut est MIT. Changez `LICENSE` et le champ `license` de `package.json` si un autre choix vous convient mieux.

---

## Notes de conception

**Permissions hôtes optionnelles.** Le manifeste ne demande aucun accès réseau à l'installation ; l'accès est demandé domaine par domaine à l'ajout d'une source. `permissions.request()` doit être appelé pendant un geste utilisateur — impossible depuis le background. La demande vit donc dans `popup.js`, et c'est le **premier `await`** de son gestionnaire : un `await` placé avant invaliderait le geste et Firefox refuserait sans rien dire.

**Parseur XML en JavaScript pur.** `DOMParser` ne fonctionnait que parce que le background Firefox MV3 est une event page, c'est-à-dire un vrai document caché. Un service worker Chrome n'a pas de DOM. `src/xml.js` (~200 lignes) expose exactement l'interface utilisée par `parser.js` et tourne partout, y compris sous Node — les tests n'ont plus besoin de jsdom.

**Décodage d'entités en un seul passage.** Décoder `&amp;` avant les entités numériques transforme `&amp;#233;` en « é » fantôme. Un passage unique élimine la classe de bug entière : le texte produit par une substitution n'est jamais réexaminé.

**`[hidden]` et `display`.** Un `display` explicite dans la feuille auteur bat l'attribut `hidden` du navigateur. La parade est une règle globale `[hidden] { display: none !important }` — sans elle, une bannière marquée cachée reste affichée, vide.

**L'arborescence fait partie du livrable.** Le manifeste référence `src/`, `popup/` et `icons/`. Récupérés à plat, les fichiers produisent une extension qui s'installe, affiche un bouton, et ouvre un popup vide — sans le moindre message d'erreur. D'où le zip, et `npm run test:structure` qui vérifie que chaque chemin référencé existe.

---

## Ce qui reste ouvert

**Les règles de mots-clés sont un point de départ, pas un classificateur.** Elles attrapent le sur-titrage grossier et rien d'autre. Extensions naturelles : ratio titre/corps, densité de liens sortants, détection de reprise d'agence, écart entre `published_ts` et `fetched_ts`.

**`HALF_LIFE_DAYS` est un arbitrage éditorial, pas technique.** Trop court, on tue des sources lentes mais précieuses. Trop long, le classement ne bouge jamais. 14 jours reste une hypothèse — mais elle est désormais testable : `npm run replay -- corpus.json --compare variants/decroissance-rapide.js`.

**Le plafond haut est atteint trop vite.** Sur le corpus de démonstration, une source de qualité sature à 100 en une semaine et n'en bouge plus. Passé ce point, le modèle ne distingue plus « bonne » de « excellente », et modifier la décroissance n'a plus aucun effet sur l'ordre. Deux pistes : un gain décroissant à mesure qu'on approche du plafond, ou une fenêtre glissante remplaçant le cumul à vie.

**Le mode replay ne mesure que ce qu'il a vu.** Le corpus est plafonné à 500 articles et ne conserve pas les flux non autorisés. Une calibration sérieuse demande de laisser tourner l'extension plusieurs semaines avant d'exporter.

**Le portage Chrome est maintenant possible mais pas fait.** Il reste à basculer `background.scripts` vers `service_worker` (donc passer les modules en ESM avec `importScripts` ou un bundle) et à remplacer `browser.*` par une couche de compatibilité.
