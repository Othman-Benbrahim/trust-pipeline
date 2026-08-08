/**
 * build.js — Assemble trust-pipeline.zip, prêt à charger dans Firefox.
 *
 * Contrainte non négociable : manifest.json doit être à la RACINE de l'archive,
 * pas dans un sous-dossier. Firefox refuse silencieusement une archive dont le
 * manifeste est enfoui d'un niveau — c'est l'erreur d'empaquetage classique.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'trust-pipeline.zip');

const INCLUDE = ['manifest.json', 'src', 'popup', 'icons'];

fs.rmSync(OUT, { force: true });
execFileSync('zip', ['-r', '-X', '-q', OUT, ...INCLUDE], { cwd: ROOT });

const listing = execFileSync('unzip', ['-l', OUT], { encoding: 'utf8' });
if (!/\smanifest\.json\s*$/m.test(listing)) {
  throw new Error('manifest.json absent de la racine de l’archive');
}
console.log(listing.trim());
console.log(`\n${path.basename(OUT)} — ${(fs.statSync(OUT).size / 1024).toFixed(1)} Ko`);
