/**
 * scoring.js — Le coeur mathématique du Trust Pipeline.
 *
 * PRINCIPE D'ANCRAGE
 * ------------------
 * Le piège classique : appliquer `score *= exp(-λ·Δt)` à chaque passage de
 * l'alarme. Avec une synchro toutes les 30 min, le facteur se compose 48 fois
 * par jour et le score s'effondre en quelques heures.
 *
 * Ici, le score stocké n'est PAS le score courant : c'est une ancre
 * (`score_anchor`) valable à un instant précis (`last_active_ts`, la dernière
 * publication observée). Le score effectif est toujours *dérivé* :
 *
 *     effectif(t) = FLOOR + (ancre − FLOOR) · exp(−λ · max(0, silence − grâce))
 *
 * L'opération est idempotente : la recalculer 1 fois ou 1000 fois donne le même
 * résultat. On ne réécrit l'ancre que lorsqu'un événement arrive (nouvel
 * article, vote manuel, erreur de fetch), et à ce moment-là on cristallise
 * d'abord la décroissance accumulée.
 */

const TP_SCORING = (() => {
  const DAY_MS = 86400000;

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /**
   * Facteur de décroissance dans [0, 1].
   * λ = ln(2) / demi-vie → après `HALF_LIFE_DAYS` de silence effectif, retour à 0.5.
   */
  function decayFactor(elapsedMs, cfg = TP_CONFIG.SCORE) {
    const days = Math.max(0, elapsedMs) / DAY_MS;
    const effective = days - cfg.GRACE_DAYS;
    if (effective <= 0) return 1;
    const lambda = Math.LN2 / cfg.HALF_LIFE_DAYS;
    return Math.exp(-lambda * effective);
  }

  /** Score réellement en vigueur à l'instant `now`. Lecture seule, sans effet de bord. */
  function effectiveScore(source, now = Date.now(), cfg = TP_CONFIG.SCORE) {
    const anchor = Number.isFinite(source.score_anchor) ? source.score_anchor : cfg.INITIAL;
    // Sous le plancher, la décroissance n'a plus rien à éroder.
    if (anchor <= cfg.FLOOR) return clamp(anchor, cfg.MIN, cfg.MAX);

    const origin = source.last_active_ts || source.anchor_ts || now;
    const factor = decayFactor(now - origin, cfg);
    return clamp(cfg.FLOOR + (anchor - cfg.FLOOR) * factor, cfg.MIN, cfg.MAX);
  }

  /** Score projeté si la source reste muette pendant `daysAhead` jours de plus. */
  function projectedScore(source, daysAhead, now = Date.now(), cfg = TP_CONFIG.SCORE) {
    return effectiveScore(source, now + daysAhead * DAY_MS, cfg);
  }

  /** Durée de silence en jours (pour l'affichage et les diagnostics). */
  function silenceDays(source, now = Date.now()) {
    const origin = source.last_active_ts || source.anchor_ts || now;
    return Math.max(0, (now - origin) / DAY_MS);
  }

  /**
   * Détection de langue par mots-outils.
   *
   * Les mots grammaticaux sont les plus fréquents de toute langue et se
   * recouvrent très peu entre français et anglais. On compte les occurrences
   * de chaque liste et on exige une marge minimale pour trancher — un titre
   * de six mots ne suffit souvent pas, et dans ce cas on retombe sur la
   * langue de la source (`item.lang`) puis sur la langue par défaut.
   *
   * @returns {{lang: string, confident: boolean}}
   */
  function detectLang(text, cfg = TP_CONFIG.LANG) {
    const words = String(text || '')
      .toLowerCase()
      .match(/[\p{L}'\u2019]+/gu) || [];

    const scores = {};
    for (const [lang, stopwords] of Object.entries(cfg.STOPWORDS)) {
      const set = new Set(stopwords);
      scores[lang] = words.reduce((n, w) => n + (set.has(w) ? 1 : 0), 0);
    }

    const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    const [bestLang, bestCount] = ranked[0];
    const second = ranked[1] ? ranked[1][1] : 0;

    return {
      lang: bestLang,
      confident: bestCount - second >= cfg.MIN_MARGIN
    };
  }

  /** Contexte de lecture partagé par tous les signaux d'un même article. */
  function itemContext(item) {
    const title = String(item.title || '');
    const summary = String(item.summary || '');
    const text = `${title} ${summary}`.toLowerCase();

    // Priorité : détection sur le texte → langue de la source → défaut.
    const detected = detectLang(text);
    const lang =
      (detected.confident && detected.lang) ||
      (TP_CONFIG.LEXICON[item.lang] && item.lang) ||
      TP_CONFIG.LANG.FALLBACK;

    const lexicon = TP_CONFIG.LEXICON[lang] || TP_CONFIG.LEXICON[TP_CONFIG.LANG.FALLBACK];

    return {
      title,
      summary,
      text,
      lang,
      /** `find('bait')` cherche dans le lexique de LA langue de l'article. */
      find: (category) => {
        const list = Array.isArray(category) ? category : lexicon[category] || [];
        return list.find((expression) => text.includes(expression)) || false;
      }
    };
  }

  /**
   * Évaluation d'un article : chaque signal déclaré dans TP_CONFIG.SIGNALS est
   * exécuté, son poids ajouté, son motif conservé. Le total est écrêté par
   * article — sans ça, un seul titre saturerait le budget de la salve.
   *
   * Rien n'est jugé ici : le moteur applique des règles qu'il ne connaît pas.
   */
  function evaluateItem(item, signals = TP_CONFIG.SIGNALS, cfg = TP_CONFIG.SCORE) {
    let raw = 0;
    const reasons = [];
    const fired = [];

    const context = itemContext(item);
    for (const signal of signals) {
      let outcome;
      try {
        outcome = signal.test(item, context);
      } catch {
        continue; // un signal défectueux ne doit pas interrompre l'ingestion
      }
      if (!outcome) continue;

      raw += signal.weight;
      fired.push(signal.id);
      reasons.push(typeof outcome === 'string' ? `${signal.label} « ${outcome} »` : signal.label);
    }

    const delta = clamp(raw, cfg.MAX_ITEM_LOSS, cfg.MAX_ITEM_GAIN);
    return { delta, raw, clipped: delta !== raw, reasons, fired, lang: context.lang };
  }

  /**
   * Somme des articles, puis signaux de salve (rythme de publication),
   * puis écrêtage global.
   */
  function evaluateBatch(items, cfg = TP_CONFIG.SCORE, signals = TP_CONFIG.SIGNALS) {
    let raw = 0;
    const tally = new Map();

    for (const item of items) {
      const { delta, reasons } = evaluateItem(item, signals, cfg);
      raw += delta;
      for (const reason of reasons) tally.set(reason, (tally.get(reason) || 0) + 1);
    }

    for (const signal of TP_CONFIG.BATCH_SIGNALS || []) {
      let outcome;
      try {
        outcome = signal.test(items);
      } catch {
        continue;
      }
      if (!outcome) continue;
      raw += signal.weight;
      const label = typeof outcome === 'string' ? `${signal.label} « ${outcome} »` : signal.label;
      tally.set(label, (tally.get(label) || 0) + 1);
    }

    const capped = clamp(raw, -cfg.MAX_DELTA_PER_SYNC, cfg.MAX_DELTA_PER_SYNC);
    const reasons = [...tally.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([reason, count]) => (count > 1 ? `${reason} ×${count}` : reason));

    return { raw, delta: capped, clipped: capped !== raw, reasons };
  }

  /**
   * Ré-ancrage. Seul endroit où `score_anchor` est réécrit.
   * Séquence : cristalliser la décroissance → appliquer le delta → repartir de maintenant.
   *
   * @param {object} source        muté sur place
   * @param {number} delta         variation à appliquer
   * @param {object} opts
   * @param {number} opts.now
   * @param {number} [opts.activeTs] date de l'événement (publication) ; défaut = now
   * @param {string} opts.reason   libellé pour l'historique
   */
  function reanchor(source, delta, { now = Date.now(), activeTs, reason = '' } = {}) {
    const cfg = TP_CONFIG.SCORE;
    const before = effectiveScore(source, now, cfg);
    const after = clamp(before + delta, cfg.MIN, cfg.MAX);

    source.score_anchor = after;
    source.anchor_ts = now;
    // Une date de publication future ou aberrante ne doit pas geler la décroissance.
    if (Number.isFinite(activeTs)) {
      source.last_active_ts = clamp(activeTs, source.last_active_ts || 0, now);
    }

    source.history = source.history || [];
    source.history.unshift({
      ts: now,
      from: Number(before.toFixed(2)),
      to: Number(after.toFixed(2)),
      delta: Number(delta.toFixed(2)),
      reason
    });
    source.history.length = Math.min(source.history.length, TP_CONFIG.MAX_HISTORY_PER_SOURCE);

    return after;
  }

  /** Tri décroissant par score effectif. Départage par récence pour un ordre stable. */
  function rank(sources, now = Date.now()) {
    return [...sources].sort((a, b) => {
      const diff = effectiveScore(b, now) - effectiveScore(a, now);
      if (Math.abs(diff) > 1e-9) return diff;
      return (b.last_active_ts || 0) - (a.last_active_ts || 0);
    });
  }

  return {
    detectLang,
    decayFactor,
    effectiveScore,
    projectedScore,
    silenceDays,
    evaluateItem,
    evaluateBatch,
    reanchor,
    rank,
    clamp
  };
})();

globalThis.TP_SCORING = TP_SCORING;
