const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const scripts = manifest.background.scripts;

let fails = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? ' ok ' : 'FAIL'}  ${label}${extra ? '  → ' + extra : ''}`);
  if (!cond) fails++;
};

// --- Environnement event page simulé ---------------------------------------
const store = {};
const listeners = { installed: [], startup: [], alarm: [], message: [] };
const alarms = {};
const fetched = [];

const FEED = `<?xml version="1.0"?><rss version="2.0"><channel><title>Test</title>
<item><title>Selon une étude, le résultat est net pour les communes qui sont dans le rapport</title><link>https://t.test/1</link><guid>g1</guid>
<pubDate>${new Date(Date.now() - 3600000).toUTCString()}</pubDate>
<description>${'Un texte suffisamment long pour dépasser le seuil de contenu mince. '.repeat(3)}</description>
</item></channel></rss>`;

const browserApi = {
  storage: {
    local: {
      get: async (keys) => {
        const list = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const k of list) if (k in store) out[k] = store[k];
        return out;
      },
      set: async (obj) => Object.assign(store, obj),
      clear: async () => { for (const k of Object.keys(store)) delete store[k]; }
    }
  },
  alarms: {
    get: async (name) => alarms[name],
    clear: async (name) => { delete alarms[name]; return true; },
    create: (name, opts) => { alarms[name] = { name, ...opts }; },
    onAlarm: { addListener: (fn) => listeners.alarm.push(fn) }
  },
  runtime: {
    onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
    onStartup: { addListener: (fn) => listeners.startup.push(fn) },
    onMessage: { addListener: (fn) => listeners.message.push(fn) },
    sendMessage: async () => { throw new Error('no receiver'); }
  },
  permissions: {
    contains: async () => true,
    request: async () => true
  }
};

const ctx = vm.createContext({
  console, Date, Math, Number, Array, Map, Set, URL, JSON, String, Object, Promise, Error,
  setTimeout, clearTimeout, AbortController,
  browser: browserApi,
  fetch: async (url) => {
    fetched.push(url);
    if (url.includes('boom')) throw new Error('DNS');
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/rss+xml' },
      text: async () => FEED
    };
  }
});

// --- Chargement dans l'ordre du manifeste -----------------------------------
let loadError = null;
try {
  for (const rel of scripts) {
    const file = path.join(ROOT, rel);
    vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: rel });
  }
} catch (e) {
  loadError = e;
}

check('les scripts de fond se chargent', !loadError, loadError ? `${loadError.message}` : '');
if (loadError) { console.log(loadError.stack); process.exit(1); }

check('ordre du manifeste cohérent', scripts[scripts.length - 1].endsWith('background.js'), scripts.join(', '));
check('écouteur onInstalled enregistré', listeners.installed.length === 1);
check('écouteur onAlarm enregistré', listeners.alarm.length === 1);
check('écouteur onMessage enregistré', listeners.message.length === 1);

(async () => {
  // Installation
  await listeners.installed[0]();
  await new Promise((r) => setTimeout(r, 60));

  check('alarme armée', Boolean(alarms['tp-sync']), JSON.stringify(alarms['tp-sync']));
  check('sources amorcées', (store.sources || []).length >= 1, String((store.sources || []).length));
  check('flux effectivement interrogés', fetched.length >= 1, String(fetched.length));

  // Premier passage : pas de scoring (absorption de l'historique)
  const seeded = store.sources[0];
  check('premier passage non scoré', seeded.score_anchor === 50, String(seeded.score_anchor));

  // Deuxième passage : le guid g1 est déjà connu, rien de neuf
  const dispatch = (msg) => listeners.message[0](msg);
  const summary = await dispatch({ type: 'FORCE_SYNC' });
  check('FORCE_SYNC renvoie un résumé', summary && summary.trigger === 'manual', JSON.stringify(summary && summary.trigger));
  check('déduplication par guid', summary.items_added === 0, String(summary.items_added));

  // GET_STATE
  const state = await dispatch({ type: 'GET_STATE' });
  check('GET_STATE expose un score dérivé', typeof state.sources[0].score === 'number', String(state.sources[0].score));
  check('GET_STATE expose la projection', typeof state.sources[0].projected_7d === 'number');
  check('seen_ids purgé de la réponse', state.sources[0].seen_ids === undefined);

  // Langue votée pendant l'ingestion (le flux de test est en français)
  const frSource = (await dispatch({ type: 'GET_STATE' })).sources.find((s) => s.items_seen > 0 || s.lang);
  check('langue de source votée', store.sources.some((s) => s.lang === 'fr'),
    store.sources.map((s) => `${s.title}:${s.lang}`).join(' '));

  // Vote manuel
  const before = state.sources[0].score;
  const voted = await dispatch({ type: 'VOTE', id: state.sources[0].id, direction: 'up' });
  const after = voted.sources.find((s) => s.id === state.sources[0].id).score;
  check('vote manuel +5', Math.abs(after - before - 5) < 0.01, `${before} → ${after}`);

  // Source injoignable
  await dispatch({ type: 'ADD_SOURCE', url: 'https://boom.test/rss' });
  const st2 = await dispatch({ type: 'GET_STATE' });
  const broken = st2.sources.find((s) => s.url === 'https://boom.test/rss');
  check('erreur de fetch enregistrée', broken && broken.last_status === 'error', broken && broken.last_error);
  check('classement décroissant', st2.sources.every((s, i, a) => i === 0 || a[i - 1].score >= s.score),
    st2.sources.map((s) => s.score).join(' ≥ '));

  // Autorisation refusée : aucun malus, statut « blocked »
  browserApi.permissions.contains = async () => false;
  const blockedSummary = await dispatch({ type: 'FORCE_SYNC' });
  const st3 = await dispatch({ type: 'GET_STATE' });
  const first = st3.sources[0];
  check('source non autorisée marquée', first.needs_permission === true && first.last_status === 'blocked', first.last_error);
  check('aucun malus sans autorisation', blockedSummary.details.every((d) => d.blocked && d.delta === 0));
  check('motifs manquants exposés', (st3.missing_origins || []).length > 0, (st3.missing_origins || []).join(' '));
  const patterns = await dispatch({ type: 'GET_MISSING_ORIGINS' });
  check('motif limité au domaine', patterns.every((p) => /^https?:\/\/[^/*]+\/\*$/.test(p)), patterns.join(' '));
  browserApi.permissions.contains = async () => true;

  // URL invalide
  let rejected = false;
  try { await dispatch({ type: 'ADD_SOURCE', url: 'pas-une-url' }); } catch { rejected = true; }
  check('URL invalide rejetée', rejected);

  console.log(fails ? `\n${fails} échec(s)` : '\nBackground opérationnel.');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.log('FAIL  exception non capturée →', e.message);
  console.log(e.stack);
  process.exit(1);
});
