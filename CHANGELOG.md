# Journal des modifications

Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/).
Versionnage [SemVer](https://semver.org/lang/fr/).

## [Non publié]

### Ajouté
- Mode replay (`tools/replay.js`) : rejoue un corpus exporté sous un jeu de
  règles arbitraire, compare deux configurations, mesure le taux de
  déclenchement de chaque signal par langue.
- Export du corpus depuis le popup, sans permission `downloads`.
- Répertoire `variants/` pour les configurations alternatives.

### Corrigé
- Découvert par le replay : un titre anglais entièrement en capitales
  échappait au signal `caps`. Les mots anglais font quatre à cinq lettres,
  donc le retrait des sigles les effaçait tous et il ne restait rien à
  mesurer. Court-circuit ajouté au-delà de 80 % de capitales brutes.
- Découvert par le replay : le lexique dogmatique anglais ne contenait que
  les formes contractées (« they don't want you to know »). Les formes
  développées ont été ajoutées.

## [0.1.0]

### Ajouté
- Agrégation RSS 2.0, RSS 1.0 (RDF), Atom et JSON Feed.
- Scoring de confiance par source, décroissance exponentielle ancrée.
- Treize signaux d'article et un signal de salve, déclarés en configuration.
- Lexiques français et anglais, détection de langue par mots-outils.
- Permissions hôtes optionnelles, demandées domaine par domaine.
- Parseur XML en JavaScript pur, sans dépendance au DOM.
- Interface : classement, synchro manuelle, votes, journal de score auditable.
