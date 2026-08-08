/**
 * test-structure.js — Vérifie que l'arborescence livrée est cohérente.
 *
 * Ce test existe à cause d'une panne réelle : les fichiers téléchargés à plat,
 * sans les sous-dossiers `src/`, `popup/` et `icons/`. Le manifeste restait
 * valide, l'extension s'installait, le bouton apparaissait — et le popup
 * s'ouvrait sur une pastille blanche vide, parce que chaque chemin pointait
 * dans le vide. Aucun linter ne détecte ça : addons-linter valide la syntaxe
 * du manifeste, pas la présence des fichiers au moment du chargement.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let fails = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? ' ok ' : 'FAIL'}  ${label}${extra ? '  → ' + extra : ''}`);
  if (!cond) fails++;
};

const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

// --- Chemins déclarés dans le manifeste --------------------------------------
const referenced = [
  ...manifest.background.scripts,
  manifest.action.default_popup,
  ...Object.values(manifest.action.default_icon || {}),
  ...Object.values(manifest.icons || {})
];

for (const rel of referenced) {
  check(`manifeste → ${rel}`, exists(rel));
}

// --- Ressources référencées depuis le HTML -----------------------------------
const popupDir = path.dirname(manifest.action.default_popup);
const html = fs.readFileSync(path.join(ROOT, manifest.action.default_popup), 'utf8');
const assets = [...html.matchAll(/(?:src|href)\s*=\s*"([^"]+)"/g)].map((m) => m[1]);

check('le popup référence au moins une ressource', assets.length > 0);
for (const rel of assets) {
  check(`popup → ${rel}`, exists(path.join(popupDir, rel)));
}

// --- Dépendances entre scripts de fond ---------------------------------------
// Chaque module doit être chargé avant celui qui le consomme.
const order = manifest.background.scripts;
const position = (needle) => order.findIndex((f) => f.endsWith(needle));
const deps = [
  ['config.js', 'scoring.js'],
  ['xml.js', 'parser.js'],
  ['scoring.js', 'store.js'],
  ['parser.js', 'store.js'],
  ['store.js', 'background.js']
];
for (const [before, after] of deps) {
  check(`${before} chargé avant ${after}`, position(before) < position(after),
    `${position(before)} < ${position(after)}`);
}

// --- Pas de dépendance résiduelle au DOM dans le background ------------------
for (const rel of manifest.background.scripts) {
  const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const usesDom = /\bnew DOMParser\b|\bdocument\.(getElementById|querySelector)/.test(code);
  check(`${rel} sans dépendance au DOM`, !usesDom);
}

// --- Le manifeste doit être à la racine de ce qui est livré ------------------
check('manifest.json à la racine du projet', exists('manifest.json'));
check('aucun chemin absolu dans le manifeste',
  !referenced.some((r) => r.startsWith('/') || /^[a-z]+:\/\//i.test(r)),
  referenced.filter((r) => r.startsWith('/')).join(' '));

console.log(fails ? `\n${fails} échec(s)` : '\nArborescence cohérente.');
process.exit(fails ? 1 : 0);
