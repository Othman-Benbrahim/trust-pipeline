/**
 * store.js — Unique point d'accès à browser.storage.local.
 *
 * SCHÉMA (étape 2 du livrable)
 * ----------------------------
 * storage.local = {
 *   schema_version: 1,
 *
 *   sources: [ Source ],       // tableau, trié à l'écriture par score effectif
 *   items:   [ Item ],         // flux fusionné, plafonné à MAX_ITEMS_STORED
 *   meta:    Meta
 * }
 *
 * Source = {
 *   id:                "src_k3f9x",     // identifiant stable, dérivé de l'URL
 *   url:               "https://…/rss.xml",
 *   title:             "Le Monde — Une",
 *   enabled:           true,
 *
 *   // --- état du score -------------------------------------------------
 *   score_anchor:      62.4,            // valeur ancrée (PAS le score affiché)
 *   anchor_ts:         1754500000000,   // quand l'ancre a été écrite (audit)
 *   last_active_ts:    1754400000000,   // dernière publication observée = origine de la décroissance
 *
 *   // --- télémétrie de fetch --------------------------------------------
 *   last_fetch_ts:     1754500000000,
 *   last_status:       "ok" | "error",
 *   last_error:        "HTTP 404",
 *   error_streak:      0,
 *
 *   // --- statistiques ----------------------------------------------------
 *   lang:              "fr" | "en" | null,  // verdict majoritaire, filet pour les titres courts
 *   lang_votes:        { fr: 12, en: 1 },    // comptage cumulatif des détections sûres
 *   items_seen:        137,
 *   seen_ids:          ["guid1", …],    // fenêtre glissante pour la déduplication
 *
 *   history: [ { ts, from, to, delta, reason } ]   // 20 derniers mouvements
 * }
 *
 * Item = {
 *   id, source_id, title, link, summary, author,
 *   published_ts, fetched_ts, score_at_ingest
 * }
 *
 * Meta = { last_sync_ts, last_sync_duration_ms, last_sync_trigger, syncing }
 *
 * Le score affiché n'est jamais persisté : il est dérivé de (score_anchor,
 * last_active_ts) par TP_SCORING.effectiveScore(). Voir scoring.js.
 */

const TP_STORE = (() => {
  const SCHEMA_VERSION = 1;
  const MAX_SEEN_IDS = 200;

  const api = typeof browser !== 'undefined' ? browser : chrome;

  function sourceId(url) {
    return `src_${TP_PARSER.fingerprint(url.trim().toLowerCase()).slice(3)}`;
  }

  /** Fabrique une Source neuve, au score neutre et considérée active à l'instant T. */
  function makeSource(url, title = '') {
    const now = Date.now();
    return {
      id: sourceId(url),
      url: url.trim(),
      title: title || new URL(url).hostname,
      enabled: true,

      score_anchor: TP_CONFIG.SCORE.INITIAL,
      anchor_ts: now,
      last_active_ts: now,

      last_fetch_ts: null,
      last_status: null,
      last_error: null,
      error_streak: 0,

      lang: null,
      lang_votes: {},
      items_seen: 0,
      seen_ids: [],
      history: []
    };
  }

  async function read(keys) {
    return api.storage.local.get(keys);
  }

  async function getSources() {
    const { sources } = await read('sources');
    return Array.isArray(sources) ? sources : [];
  }

  async function saveSources(sources) {
    // On persiste déjà trié : le popup n'a plus qu'à lire dans l'ordre.
    await api.storage.local.set({ sources: TP_SCORING.rank(sources) });
  }

  async function getItems() {
    const { items } = await read('items');
    return Array.isArray(items) ? items : [];
  }

  /** Fusionne, déduplique par id, trie par date, plafonne. */
  async function mergeItems(newItems) {
    const existing = await getItems();
    const byId = new Map(existing.map((i) => [i.id, i]));
    for (const item of newItems) if (!byId.has(item.id)) byId.set(item.id, item);

    const merged = [...byId.values()]
      .sort((a, b) => (b.published_ts || b.fetched_ts || 0) - (a.published_ts || a.fetched_ts || 0))
      .slice(0, TP_CONFIG.MAX_ITEMS_STORED);

    await api.storage.local.set({ items: merged });
    return merged;
  }

  async function getMeta() {
    const { meta } = await read('meta');
    return meta || { last_sync_ts: null, last_sync_duration_ms: null, last_sync_trigger: null, syncing: false };
  }

  async function setMeta(patch) {
    const meta = { ...(await getMeta()), ...patch };
    await api.storage.local.set({ meta });
    return meta;
  }

  /** Mémorise les identifiants déjà vus, en fenêtre glissante. */
  function rememberSeen(source, ids) {
    const set = new Set(source.seen_ids || []);
    for (const id of ids) set.add(id);
    source.seen_ids = [...set].slice(-MAX_SEEN_IDS);
  }

  function isNew(source, id) {
    return !(source.seen_ids || []).includes(id);
  }

  /** Amorçage au premier lancement. Idempotent. */
  async function bootstrap() {
    const { schema_version } = await read('schema_version');
    if (schema_version === SCHEMA_VERSION) return;

    const sources = await getSources();
    if (sources.length === 0) {
      for (const seed of TP_CONFIG.DEFAULT_SOURCES) {
        sources.push(makeSource(seed.url, seed.title));
      }
      await saveSources(sources);
    }
    await api.storage.local.set({ schema_version: SCHEMA_VERSION });
  }

  async function clearAll() {
    await api.storage.local.clear();
  }

  return {
    SCHEMA_VERSION,
    api,
    sourceId,
    makeSource,
    getSources,
    saveSources,
    getItems,
    mergeItems,
    getMeta,
    setMeta,
    rememberSeen,
    isNew,
    bootstrap,
    clearAll
  };
})();

globalThis.TP_STORE = TP_STORE;
