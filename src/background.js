/**
 * background.js — Orchestration événementielle.
 *
 * Aucune boucle, aucun daemon. Trois portes d'entrée seulement :
 *   1. browser.alarms          → synchro périodique
 *   2. browser.runtime.onMessage → actions du popup (dont « Force Sync »)
 *   3. onInstalled / onStartup   → amorçage et (ré)armement de l'alarme
 *
 * Les écouteurs sont enregistrés au niveau racine du script, de façon
 * synchrone : c'est obligatoire sur une event page MV3, qui est déchargée
 * quand elle est inactive et réveillée par l'événement lui-même.
 */

const api = TP_STORE.api;

/** Verrou mémoire : empêche deux cycles concurrents (alarme + clic simultanés). */
let syncInFlight = null;

// ---------------------------------------------------------------------------
// Autorisations d'accès aux domaines
// ---------------------------------------------------------------------------

/** Motif de permission minimal pour un flux : un domaine, pas tout le web. */
function originPattern(url) {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.hostname}/*`;
}

async function hasAccess(url) {
  if (!api.permissions || !api.permissions.contains) return true;
  try {
    return await api.permissions.contains({ origins: [originPattern(url)] });
  } catch {
    return false;
  }
}

/** Motifs manquants, pour que le popup puisse les demander en un seul geste. */
async function missingOrigins() {
  const sources = await TP_STORE.getSources();
  const checks = await Promise.all(
    sources
      .filter((s) => s.enabled !== false)
      .map(async (s) => ((await hasAccess(s.url)) ? null : originPattern(s.url)))
  );
  return [...new Set(checks.filter(Boolean))];
}

// ---------------------------------------------------------------------------
// Réseau
// ---------------------------------------------------------------------------

async function fetchFeed(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TP_CONFIG.FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      cache: 'no-cache',
      headers: { Accept: 'application/rss+xml, application/atom+xml, application/json, text/xml, */*' }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return {
      body: await response.text(),
      contentType: response.headers.get('content-type') || ''
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Ingestion d'une source
// ---------------------------------------------------------------------------

/**
 * Récupère, parse, filtre les nouveautés, score, ré-ancre.
 * Mute `source` sur place et renvoie les articles inédits.
 */
async function ingestSource(source, now) {
  const result = { sourceId: source.id, added: 0, delta: 0, reasons: [], error: null, blocked: false };

  // Une source non autorisée n'est pas une source défaillante : aucun malus.
  // L'utilisateur n'a simplement pas encore donné son accord pour ce domaine.
  if (!(await hasAccess(source.url))) {
    source.last_fetch_ts = now;
    source.last_status = 'blocked';
    source.last_error = 'Accès au domaine non autorisé';
    result.error = source.last_error;
    result.blocked = true;
    return { result, items: [] };
  }

  let parsed;
  try {
    const { body, contentType } = await fetchFeed(source.url);
    parsed = TP_PARSER.parseFeed(body, contentType, source.url);
  } catch (error) {
    source.last_fetch_ts = now;
    source.last_status = 'error';
    source.last_error = error.name === 'AbortError' ? 'Délai dépassé' : error.message;
    source.error_streak = (source.error_streak || 0) + 1;

    // Un flux injoignable perd de la confiance, mais lentement.
    TP_SCORING.reanchor(source, -TP_CONFIG.SCORE.FETCH_ERROR_PENALTY, {
      now,
      reason: `échec de récupération : ${source.last_error}`
    });

    result.error = source.last_error;
    result.delta = -TP_CONFIG.SCORE.FETCH_ERROR_PENALTY;
    return { result, items: [] };
  }

  source.last_fetch_ts = now;
  source.last_status = 'ok';
  source.last_error = null;
  source.error_streak = 0;
  if (!source.title && parsed.title) source.title = parsed.title;

  const fresh = parsed.items.filter((item) => TP_STORE.isNew(source, item.id));

  // Mémoire de langue : chaque détection sûre vote, la majorité devient la
  // langue de la source. Fait sur TOUS les articles parsés — y compris au
  // premier passage, qui est justement celui qui en montre le plus — et non
  // sur les seuls inédits, car le court-circuit d'amorçage ne doit pas
  // retarder le verdict d'une synchro entière.
  for (const item of parsed.items) {
    const guess = TP_SCORING.detectLang(`${item.title} ${item.summary}`);
    if (guess.confident) {
      source.lang_votes = source.lang_votes || {};
      source.lang_votes[guess.lang] = (source.lang_votes[guess.lang] || 0) + 1;
    }
  }
  const votes = Object.entries(source.lang_votes || {}).sort((a, b) => b[1] - a[1]);
  if (votes.length) source.lang = votes[0][0];
  for (const item of fresh) item.lang = source.lang;

  // Premier passage : on absorbe l'historique sans le scorer, sinon un flux
  // de 50 articles archivés fausserait complètement le score initial.
  const seeding = (source.seen_ids || []).length === 0;
  TP_STORE.rememberSeen(source, parsed.items.map((i) => i.id));
  source.items_seen = (source.items_seen || 0) + fresh.length;

  if (fresh.length === 0 || seeding) {
    // Rien de neuf : on ne ré-ancre PAS. La décroissance continue de courir
    // depuis last_active_ts — c'est exactement l'effet recherché.
    if (seeding && parsed.items.length) {
      const newest = Math.max(...parsed.items.map((i) => i.published_ts || 0), 0);
      if (newest) source.last_active_ts = Math.min(newest, now);
    }
    return { result, items: [] };
  }

  const evaluation = TP_SCORING.evaluateBatch(fresh);
  const newest = Math.max(...fresh.map((i) => i.published_ts || 0), 0) || now;

  TP_SCORING.reanchor(source, evaluation.delta, {
    now,
    activeTs: newest,
    reason: `${fresh.length} article(s) — ${evaluation.reasons.join(', ') || 'aucun signal'}`
  });

  result.added = fresh.length;
  result.delta = evaluation.delta;
  result.reasons = evaluation.reasons;

  const scoreNow = TP_SCORING.effectiveScore(source, now);
  const items = fresh.map((item) => ({
    ...item,
    source_id: source.id,
    fetched_ts: now,
    score_at_ingest: Number(scoreNow.toFixed(2))
  }));

  return { result, items };
}

// ---------------------------------------------------------------------------
// Cycle complet
// ---------------------------------------------------------------------------

async function runSync(trigger = 'alarm') {
  if (syncInFlight) return syncInFlight;

  syncInFlight = (async () => {
    const started = Date.now();
    await TP_STORE.setMeta({ syncing: true, last_sync_trigger: trigger });
    broadcast({ type: 'SYNC_STARTED', trigger });

    const sources = await TP_STORE.getSources();
    const active = sources.filter((s) => s.enabled !== false);

    // Parallèle : les flux sont indépendants, inutile de les sérialiser.
    const outcomes = await Promise.all(
      active.map((source) =>
        ingestSource(source, started).catch((error) => ({
          result: { sourceId: source.id, added: 0, delta: 0, reasons: [], error: error.message },
          items: []
        }))
      )
    );

    const collected = outcomes.flatMap((o) => o.items);
    if (collected.length) await TP_STORE.mergeItems(collected);

    // saveSources() applique le classement dynamique avant écriture.
    await TP_STORE.saveSources(sources);

    const summary = {
      trigger,
      duration_ms: Date.now() - started,
      sources_checked: active.length,
      items_added: collected.length,
      errors: outcomes.filter((o) => o.result.error).length,
      details: outcomes.map((o) => o.result)
    };

    await TP_STORE.setMeta({
      syncing: false,
      last_sync_ts: started,
      last_sync_duration_ms: summary.duration_ms
    });
    broadcast({ type: 'SYNC_DONE', summary });

    return summary;
  })().finally(() => {
    syncInFlight = null;
  });

  return syncInFlight;
}

/** Notifie le popup s'il est ouvert. S'il ne l'est pas, l'échec est normal. */
function broadcast(message) {
  api.runtime.sendMessage(message).catch(() => {});
}

// ---------------------------------------------------------------------------
// Lecture d'état pour l'interface
// ---------------------------------------------------------------------------

async function getState() {
  const now = Date.now();
  const [sources, items, meta] = await Promise.all([
    TP_STORE.getSources(),
    TP_STORE.getItems(),
    TP_STORE.getMeta()
  ]);

  const ranked = TP_SCORING.rank(sources, now);
  const access = await Promise.all(ranked.map((source) => hasAccess(source.url)));

  return {
    now,
    meta,
    items: items.slice(0, 40),
    missing_origins: [
      ...new Set(ranked.filter((s, i) => !access[i] && s.enabled !== false).map((s) => originPattern(s.url)))
    ],
    sources: ranked.map((source, i) => ({
      ...source,
      seen_ids: undefined, // inutile à l'affichage, et volumineux
      needs_permission: !access[i],
      score: Number(TP_SCORING.effectiveScore(source, now).toFixed(1)),
      projected_7d: Number(TP_SCORING.projectedScore(source, 7, now).toFixed(1)),
      silence_days: Number(TP_SCORING.silenceDays(source, now).toFixed(1))
    }))
  };
}

/**
 * Corpus exportable : tout ce qu'il faut pour rejouer le scoring hors ligne.
 *
 * Les articles conservent les champs BRUTS lus par les signaux (titre, résumé,
 * auteur, catégories, liens, horodatages) et non le résultat de leur
 * évaluation. C'est la condition pour qu'un autre jeu de règles produise un
 * autre score : rejouer un verdict figé n'aurait aucun intérêt.
 */
async function exportCorpus() {
  const [sources, items] = await Promise.all([TP_STORE.getSources(), TP_STORE.getItems()]);

  return {
    format: 'trust-pipeline-corpus',
    version: 1,
    exported_at: Date.now(),
    config_snapshot: {
      half_life_days: TP_CONFIG.SCORE.HALF_LIFE_DAYS,
      grace_days: TP_CONFIG.SCORE.GRACE_DAYS,
      floor: TP_CONFIG.SCORE.FLOOR,
      signals: TP_CONFIG.SIGNALS.map((s) => ({ id: s.id, weight: s.weight }))
    },
    sources: sources.map((s) => ({
      id: s.id,
      url: s.url,
      title: s.title,
      lang: s.lang || null,
      lang_votes: s.lang_votes || {},
      score_anchor: s.score_anchor,
      anchor_ts: s.anchor_ts,
      last_active_ts: s.last_active_ts,
      items_seen: s.items_seen || 0,
      history: s.history || []
    })),
    items: items.map((i) => ({
      id: i.id,
      source_id: i.source_id,
      title: i.title,
      summary: i.summary,
      author: i.author,
      categories: i.categories || [],
      has_links: Boolean(i.has_links),
      published_ts: i.published_ts,
      updated_ts: i.updated_ts || null,
      fetched_ts: i.fetched_ts,
      score_at_ingest: i.score_at_ingest
    }))
  };
}

// ---------------------------------------------------------------------------
// Actions du popup
// ---------------------------------------------------------------------------

async function addSource(url) {
  const clean = url.trim();
  new URL(clean); // lève si l'URL est invalide
  const sources = await TP_STORE.getSources();
  const id = TP_STORE.sourceId(clean);
  if (sources.some((s) => s.id === id)) throw new Error('Cette source est déjà suivie.');

  sources.push(TP_STORE.makeSource(clean));
  await TP_STORE.saveSources(sources);
  return runSync('add-source');
}

async function removeSource(id) {
  const sources = await TP_STORE.getSources();
  await TP_STORE.saveSources(sources.filter((s) => s.id !== id));
}

async function vote(id, direction) {
  const sources = await TP_STORE.getSources();
  const source = sources.find((s) => s.id === id);
  if (!source) throw new Error('Source introuvable.');

  const delta = direction === 'up' ? TP_CONFIG.SCORE.MANUAL_VOTE : -TP_CONFIG.SCORE.MANUAL_VOTE;
  TP_SCORING.reanchor(source, delta, { now: Date.now(), reason: 'validation manuelle' });
  await TP_STORE.saveSources(sources);
  return TP_SCORING.effectiveScore(source);
}

async function setPeriod(minutes) {
  const value = Math.max(1, Math.round(minutes));
  TP_CONFIG.SYNC_PERIOD_MINUTES = value;
  await api.storage.local.set({ sync_period_minutes: value });
  await api.alarms.clear(TP_CONFIG.ALARM_NAME);
  api.alarms.create(TP_CONFIG.ALARM_NAME, { periodInMinutes: value, delayInMinutes: value });
  return value;
}

// ---------------------------------------------------------------------------
// Écouteurs — enregistrés au chargement du script, sans await préalable
// ---------------------------------------------------------------------------

async function ensureAlarm() {
  const { sync_period_minutes } = await api.storage.local.get('sync_period_minutes');
  const period = sync_period_minutes || TP_CONFIG.SYNC_PERIOD_MINUTES;
  TP_CONFIG.SYNC_PERIOD_MINUTES = period;

  const existing = await api.alarms.get(TP_CONFIG.ALARM_NAME);
  if (!existing) {
    api.alarms.create(TP_CONFIG.ALARM_NAME, { periodInMinutes: period, delayInMinutes: 1 });
  }
}

api.runtime.onInstalled.addListener(async () => {
  await TP_STORE.bootstrap();
  await ensureAlarm();
  runSync('install');
});

api.runtime.onStartup.addListener(async () => {
  await TP_STORE.bootstrap();
  await ensureAlarm();
});

api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== TP_CONFIG.ALARM_NAME) return;
  runSync('alarm');
});

api.runtime.onMessage.addListener((message) => {
  switch (message && message.type) {
    case 'GET_STATE':
      return getState();
    case 'GET_MISSING_ORIGINS':
      return missingOrigins();
    case 'EXPORT_CORPUS':
      return exportCorpus();
    case 'FORCE_SYNC':
      return runSync('manual');
    case 'ADD_SOURCE':
      return addSource(message.url);
    case 'REMOVE_SOURCE':
      return removeSource(message.id).then(getState);
    case 'VOTE':
      return vote(message.id, message.direction).then(getState);
    case 'SET_PERIOD':
      return setPeriod(message.minutes);
    default:
      return undefined; // pas de réponse asynchrone attendue
  }
});
