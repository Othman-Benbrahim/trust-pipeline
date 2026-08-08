const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadEngine, replayCorpus, groupByDay } = require('../tools/replay.js');

const ROOT = path.join(__dirname, '..');
const CORPUS = path.join(__dirname, 'fixtures', 'corpus.sample.json');

let fails = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? ' ok ' : 'FAIL'}  ${label}${extra ? '  → ' + extra : ''}`);
  if (!cond) fails++;
};

const corpus = JSON.parse(fs.readFileSync(CORPUS, 'utf8'));
const options = { now: corpus.exported_at, scoreAll: false };
const engine = loadEngine(path.join(ROOT, 'src', 'config.js'));

// --- Isolation des moteurs ---------------------------------------------------
const variant = loadEngine(path.join(ROOT, 'variants', 'decroissance-rapide.js'));
check('deux configs cohabitent sans s’écraser',
  engine.config.SCORE.HALF_LIFE_DAYS === 14 && variant.config.SCORE.HALF_LIFE_DAYS === 5,
  `${engine.config.SCORE.HALF_LIFE_DAYS} / ${variant.config.SCORE.HALF_LIFE_DAYS}`);

// --- Regroupement ------------------------------------------------------------
const days = groupByDay(corpus.items.filter((i) => i.source_id === 'src_fr_quality'));
check('articles groupés par jour', days.length > 1 && days.every(([, b]) => b.length > 0));
check('jours en ordre chronologique', days.every((d, i, a) => i === 0 || a[i - 1][0] < d[0]));
check('horodatage manquant ignoré', groupByDay([{ id: 'x' }]).length === 0);

// --- Déterminisme ------------------------------------------------------------
const a = replayCorpus(corpus, engine, options);
const b = replayCorpus(corpus, engine, options);
check('replay déterministe', JSON.stringify(a.map((r) => r.final)) === JSON.stringify(b.map((r) => r.final)));
check('corpus source non muté', corpus.sources.every((s) => s.score_anchor === 50),
  'le replay ne doit jamais écrire dans le corpus');

// --- Discrimination ----------------------------------------------------------
const byId = new Map(a.map((r) => [r.id, r]));
check('source de qualité au-dessus du neutre', byId.get('src_fr_quality').final > 50,
  String(byId.get('src_fr_quality').final.toFixed(1)));
check('source d’appât sous le neutre', byId.get('src_fr_bait').final < 50,
  String(byId.get('src_fr_bait').final.toFixed(1)));
check('qualité EN traitée comme qualité FR',
  Math.sign(byId.get('src_en_quality').final - 50) === Math.sign(byId.get('src_fr_quality').final - 50));
check('appât EN traité comme appât FR',
  Math.sign(byId.get('src_en_bait').final - 50) === Math.sign(byId.get('src_fr_bait').final - 50));

// --- Fidélité à la production ------------------------------------------------
const slow = byId.get('src_slow');
check('premier lot non scoré par défaut', slow.scoredBatches === slow.days - 1,
  `${slow.scoredBatches} lots scorés sur ${slow.days} jours`);
const all = replayCorpus(corpus, engine, { ...options, scoreAll: true });
check('--score-all score tous les lots',
  new Map(all.map((r) => [r.id, r])).get('src_slow').scoredBatches === slow.days);

// --- Bornes ------------------------------------------------------------------
check('scores dans [0,100]', a.every((r) => r.final >= 0 && r.final <= 100));
check('déclenchements comptés', a.every((r) => r.firings instanceof Map));

// --- Sensibilité aux règles --------------------------------------------------
// Tous les poids à zéro : les sources de MÊME cadence doivent converger sur la
// valeur initiale. Les sources à cadence différente, elles, divergent toujours
// — la décroissance temporelle est indépendante des signaux, c'est voulu.
const neutered = loadEngine(path.join(ROOT, 'src', 'config.js'));
neutered.config.SIGNALS.forEach((s) => { s.weight = 0; });
neutered.config.BATCH_SIGNALS.forEach((s) => { s.weight = 0; });
const flat = new Map(replayCorpus(corpus, neutered, options).map((r) => [r.id, r]));
const daily = ['src_fr_quality', 'src_fr_bait', 'src_en_quality', 'src_en_bait'].map((id) => flat.get(id).final);
check('poids nuls → sources quotidiennes toutes au neutre',
  daily.every((v) => Math.abs(v - neutered.config.SCORE.INITIAL) < 0.01),
  daily.map((v) => v.toFixed(1)).join(' '));
check('poids nuls → la décroissance agit toujours sur la source lente',
  flat.get('src_slow').final < neutered.config.SCORE.INITIAL,
  flat.get('src_slow').final.toFixed(1));

// --- CLI ---------------------------------------------------------------------
const out = execFileSync('node', [path.join(ROOT, 'tools', 'replay.js'), CORPUS], { encoding: 'utf8' });
check('CLI produit le tableau de déclenchement', /Taux de déclenchement/.test(out));
check('CLI produit le classement', /Classement rejoué/.test(out));
check('CLI signale les signaux muets', /signal muet/.test(out));

const compared = execFileSync('node', [
  path.join(ROOT, 'tools', 'replay.js'), CORPUS,
  '--compare', path.join(ROOT, 'variants', 'decroissance-rapide.js')
], { encoding: 'utf8' });
check('CLI compare deux configs', /Comparaison/.test(compared) && /brassage/.test(compared));

let rejected = false;
try {
  execFileSync('node', [path.join(ROOT, 'tools', 'replay.js'), path.join(__dirname, 'test-replay.js')], { stdio: 'pipe' });
} catch { rejected = true; }
check('format inattendu rejeté', rejected);

console.log(fails ? `\n${fails} échec(s)` : '\nTous les tests passent.');
process.exit(fails ? 1 : 0);
