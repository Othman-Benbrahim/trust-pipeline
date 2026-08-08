#!/usr/bin/env node
/**
 * replay.js — Rejoue un corpus exporté sous un jeu de règles arbitraire.
 *
 * POURQUOI
 * --------
 * Toutes les constantes du moteur (poids des signaux, demi-vie, lexiques) sont
 * des hypothèses. Les régler à l'aveugle sur l'extension en production demande
 * des semaines et ne permet aucune comparaison : on ne voit jamais ce qu'aurait
 * donné l'autre réglage.
 *
 * Le replay est possible parce que le corpus conserve les champs BRUTS lus par
 * les signaux, et parce que le score n'est jamais stocké — il est dérivé d'une
 * ancre. Rejouer, c'est simplement dériver autrement.
 *
 * USAGE
 * -----
 *   node tools/replay.js corpus.json
 *   node tools/replay.js corpus.json --compare variants/agressif.js
 *   node tools/replay.js corpus.json --score-all --top 15
 *
 * Un « variant » est une copie de src/config.js avec d'autres valeurs. Aucun
 * format particulier : le fichier doit simplement définir TP_CONFIG.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src');
const DAY_MS = 86400000;

// ---------------------------------------------------------------------------
// Chargement d'un moteur isolé par jeu de règles
// ---------------------------------------------------------------------------

/**
 * Chaque variant vit dans son propre contexte VM : deux configurations
 * cohabitent sans que l'une écrase les globales de l'autre.
 */
function loadEngine(configPath) {
  const ctx = vm.createContext({
    console, Date, Math, Number, Array, Map, Set, URL, JSON, String, Object, Boolean, RegExp
  });
  vm.runInContext(fs.readFileSync(configPath, 'utf8'), ctx, { filename: configPath });
  vm.runInContext(fs.readFileSync(path.join(SRC, 'scoring.js'), 'utf8'), ctx, { filename: 'scoring.js' });
  return { config: ctx.TP_CONFIG, scoring: ctx.TP_SCORING, label: path.basename(configPath) };
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

/** Articles regroupés par jour de publication, dans l'ordre chronologique. */
function groupByDay(items) {
  const days = new Map();
  for (const item of items) {
    const ts = item.published_ts || item.fetched_ts;
    if (!Number.isFinite(ts)) continue;
    const day = Math.floor(ts / DAY_MS);
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(item);
  }
  return [...days.entries()].sort((a, b) => a[0] - b[0]);
}

/**
 * Rejoue l'historique d'une source jour par jour.
 *
 * Fidélité à la production : le premier lot n'est pas scoré, comme lors de la
 * première ingestion réelle d'un flux. `--score-all` lève cette règle quand on
 * cherche à maximiser le signal disponible plutôt qu'à prédire le comportement.
 */
function replaySource(source, items, engine, options) {
  const { scoring, config } = engine;
  const cfg = config.SCORE;
  const days = groupByDay(items);
  if (days.length === 0) return null;

  const state = {
    score_anchor: cfg.INITIAL,
    anchor_ts: days[0][0] * DAY_MS,
    last_active_ts: days[0][0] * DAY_MS,
    lang: source.lang || null,
    history: []
  };

  const firings = new Map();
  let scoredBatches = 0;

  days.forEach(([day, batch], index) => {
    const at = day * DAY_MS;

    for (const item of batch) {
      const evaluation = scoring.evaluateItem({ ...item, lang: state.lang });
      for (const id of evaluation.fired) {
        const key = `${id}|${evaluation.lang}`;
        firings.set(key, (firings.get(key) || 0) + 1);
      }
    }

    if (index === 0 && !options.scoreAll) return; // premier lot absorbé

    const evaluation = scoring.evaluateBatch(batch.map((i) => ({ ...i, lang: state.lang })));
    const newest = Math.max(...batch.map((i) => i.published_ts || at));
    scoring.reanchor(state, evaluation.delta, {
      now: at,
      activeTs: Math.min(newest, at + DAY_MS - 1),
      reason: `${batch.length} article(s) — ${evaluation.reasons.join(', ') || 'aucun signal'}`
    });
    scoredBatches++;
  });

  return {
    id: source.id,
    title: source.title || source.url,
    lang: state.lang,
    items: items.length,
    days: days.length,
    scoredBatches,
    firings,
    final: scoring.effectiveScore(state, options.now, cfg),
    peak: Math.max(...state.history.map((h) => h.to), cfg.INITIAL),
    trough: Math.min(...state.history.map((h) => h.to), cfg.INITIAL)
  };
}

function replayCorpus(corpus, engine, options) {
  const bySource = new Map();
  for (const item of corpus.items) {
    if (!bySource.has(item.source_id)) bySource.set(item.source_id, []);
    bySource.get(item.source_id).push(item);
  }

  const results = [];
  for (const source of corpus.sources) {
    const items = bySource.get(source.id) || [];
    const result = replaySource(source, items, engine, options);
    if (result) results.push(result);
  }

  results.sort((a, b) => b.final - a.final);
  return results;
}

// ---------------------------------------------------------------------------
// Rapport
// ---------------------------------------------------------------------------

const pad = (s, n) => String(s).padEnd(n).slice(0, n);
const num = (v, n = 6, d = 1) => Number(v).toFixed(d).padStart(n);
const rule = (n = 78) => console.log('─'.repeat(n));

function reportCorpus(corpus) {
  const dates = corpus.items.map((i) => i.published_ts || i.fetched_ts).filter(Boolean);
  const span = dates.length ? (Math.max(...dates) - Math.min(...dates)) / DAY_MS : 0;
  const langs = {};
  for (const s of corpus.sources) langs[s.lang || '?'] = (langs[s.lang || '?'] || 0) + 1;

  console.log(`\nCorpus  ${corpus.sources.length} sources · ${corpus.items.length} articles · ${span.toFixed(0)} jours couverts`);
  console.log(`Langues ${Object.entries(langs).map(([l, n]) => `${l}:${n}`).join('  ')}`);
}

/**
 * Le tableau qui sert vraiment à calibrer : à quelle fréquence chaque signal
 * se déclenche, par langue. Un signal à 0 % est un lexique mort. Un signal
 * à 90 % ne discrimine rien.
 */
function reportFirings(results, engine) {
  const totals = new Map();
  const itemsByLang = new Map();

  for (const r of results) {
    itemsByLang.set(r.lang || '?', (itemsByLang.get(r.lang || '?') || 0) + r.items);
    for (const [key, count] of r.firings) {
      totals.set(key, (totals.get(key) || 0) + count);
    }
  }

  const langs = [...itemsByLang.keys()].sort();
  console.log(`\nTaux de déclenchement des signaux`);
  rule();
  console.log(`${pad('signal', 24)}${pad('poids', 8)}${langs.map((l) => pad(l, 14)).join('')}`);
  rule();

  for (const signal of engine.config.SIGNALS) {
    const cells = langs.map((lang) => {
      const fired = totals.get(`${signal.id}|${lang}`) || 0;
      const base = itemsByLang.get(lang) || 0;
      const pct = base ? (fired / base) * 100 : 0;
      return pad(`${String(fired).padStart(4)} ${pct.toFixed(0).padStart(3)}%`, 14);
    });
    const flag = langs.some((lang) => (totals.get(`${signal.id}|${lang}`) || 0) === 0) ? ' ←' : '';
    console.log(`${pad(signal.id, 24)}${pad(signal.weight > 0 ? `+${signal.weight}` : signal.weight, 8)}${cells.join('')}${flag}`);
  }
  rule();
  console.log('← signal muet dans au moins une langue : lexique à revoir ou critère inadapté');
}

function reportRanking(results, top) {
  console.log(`\nClassement rejoué`);
  rule();
  console.log(`${pad('#', 4)}${pad('source', 34)}${pad('lang', 6)}${pad('score', 8)}${pad('creux', 8)}${pad('pic', 8)}${pad('lots', 6)}`);
  rule();
  results.slice(0, top).forEach((r, i) => {
    console.log(
      `${pad(String(i + 1).padStart(2, '0'), 4)}${pad(r.title, 34)}${pad(r.lang || '—', 6)}` +
      `${num(r.final, 6)}  ${num(r.trough, 6)}  ${num(r.peak, 6)}  ${String(r.scoredBatches).padStart(4)}`
    );
  });
  rule();
}

/** Ce qui compte dans une comparaison, ce n'est pas l'écart de score : c'est le changement d'ordre. */
function reportComparison(a, b, labelA, labelB, top) {
  const rankB = new Map(b.map((r, i) => [r.id, i]));
  const scoreB = new Map(b.map((r) => [r.id, r.final]));

  console.log(`\nComparaison  ${labelA}  →  ${labelB}`);
  rule();
  console.log(`${pad('source', 34)}${pad('score A', 10)}${pad('score B', 10)}${pad('Δ score', 10)}${pad('Δ rang', 8)}`);
  rule();

  const rows = a.map((r, i) => ({
    title: r.title,
    scoreA: r.final,
    scoreB: scoreB.has(r.id) ? scoreB.get(r.id) : NaN,
    rankShift: rankB.has(r.id) ? i - rankB.get(r.id) : NaN
  }));

  rows
    .slice()
    .sort((x, y) => Math.abs(y.scoreB - y.scoreA) - Math.abs(x.scoreB - x.scoreA))
    .slice(0, top)
    .forEach((r) => {
      const shift = Number.isFinite(r.rankShift)
        ? (r.rankShift > 0 ? `+${r.rankShift}` : String(r.rankShift))
        : '—';
      console.log(
        `${pad(r.title, 34)}${num(r.scoreA, 8)}  ${num(r.scoreB, 8)}  ` +
        `${num(r.scoreB - r.scoreA, 8)}  ${pad(shift, 8)}`
      );
    });
  rule();

  const moved = rows.filter((r) => r.rankShift !== 0 && Number.isFinite(r.rankShift)).length;
  const churn = rows.length ? (moved / rows.length) * 100 : 0;
  console.log(`${moved} source(s) sur ${rows.length} changent de rang — ${churn.toFixed(0)} % de brassage`);
  if (churn === 0) {
    console.log('Aucun effet sur l’ordre : la modification ne change rien à ce que vous lisez en premier.');
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { corpus: null, config: path.join(SRC, 'config.js'), compare: null, top: 20, scoreAll: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--compare') args.compare = argv[++i];
    else if (arg === '--config') args.config = argv[++i];
    else if (arg === '--top') args.top = Number(argv[++i]) || 20;
    else if (arg === '--score-all') args.scoreAll = true;
    else if (!arg.startsWith('--')) args.corpus = arg;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.corpus) {
    console.error(`Usage : node tools/replay.js <corpus.json> [--config f] [--compare f] [--top n] [--score-all]

Le corpus s'obtient depuis le popup de l'extension, via « Exporter le corpus ».`);
    process.exit(2);
  }

  const corpus = JSON.parse(fs.readFileSync(args.corpus, 'utf8'));
  if (corpus.format !== 'trust-pipeline-corpus') {
    console.error(`Format inattendu : ${corpus.format || 'inconnu'}`);
    process.exit(2);
  }

  const options = { now: corpus.exported_at || Date.now(), scoreAll: args.scoreAll };

  reportCorpus(corpus);
  if (args.scoreAll) console.log('Mode --score-all : le premier lot est scoré (diffère de la production).');

  const engineA = loadEngine(args.config);
  const resultsA = replayCorpus(corpus, engineA, options);

  reportFirings(resultsA, engineA);
  reportRanking(resultsA, args.top);

  if (args.compare) {
    const engineB = loadEngine(args.compare);
    const resultsB = replayCorpus(corpus, engineB, options);
    reportComparison(resultsA, resultsB, engineA.label, engineB.label, args.top);
  }

  console.log('');
}

if (require.main === module) main();

module.exports = { loadEngine, replayCorpus, groupByDay };
