/**
 * config.js — Toutes les constantes réglables du Trust Pipeline.
 *
 * Chargé en premier : les autres scripts lisent TP_CONFIG depuis la portée
 * globale. Aucun import ESM, pour rester compatible avec l'event page Firefox
 * et les <script> du popup sans build step.
 *
 * Le moteur de scoring ne contient aucune règle : il exécute les signaux
 * déclarés ici. Ajouter un critère = ajouter une entrée dans SIGNALS.
 */

const TP_CONFIG = {
  ALARM_NAME: 'tp-sync',

  /** Période de la synchro automatique. Firefox impose un minimum de 1 minute. */
  SYNC_PERIOD_MINUTES: 30,

  /** Au-delà, on abandonne le fetch d'un flux (évite qu'une source morte bloque tout). */
  FETCH_TIMEOUT_MS: 12000,

  /** Anti-tempête : on ne relance pas une synchro complète plus souvent que ça. */
  MIN_SYNC_INTERVAL_MS: 60 * 1000,

  /** Rétention locale. storage.local n'est pas illimité : on plafonne. */
  MAX_ITEMS_STORED: 500,
  MAX_HISTORY_PER_SOURCE: 20,

  SCORE: {
    INITIAL: 50,
    MIN: 0,
    MAX: 100,

    /** Plancher de décroissance : une source silencieuse tend vers FLOOR, pas vers 0. */
    FLOOR: 5,

    /** Demi-vie du silence : après 14 jours muet, la part au-dessus du plancher est divisée par 2. */
    HALF_LIFE_DAYS: 5,

    /** Délai de grâce : un flux hebdomadaire ne doit pas être puni comme un flux mort. */
    GRACE_DAYS: 1,

    /**
     * Plafonds par ARTICLE.
     *
     * Indispensable depuis l'ajout des signaux typographiques et sémantiques :
     * un seul article peut désormais déclencher six pénalités cumulées
     * (-2.5 appât, -2.0 majuscules, -1.8 émotion, -1.5 dogme,
     * -1.5 ponctuation, -0.6 contenu mince = -9.9). Sans plafond par article,
     * un seul titre saturerait le budget de la salve entière et masquerait
     * les vingt autres.
     *
     * Asymétrie assumée : la confiance se gagne plus lentement qu'elle ne se perd.
     */
    MAX_ITEM_GAIN: 3,
    MAX_ITEM_LOSS: -4,

    /** Plafond par SALVE : 60 articles d'un coup ne peuvent pas faire exploser un score. */
    MAX_DELTA_PER_SYNC: 3,

    /** Impact d'un vote manuel dans le popup. */
    MANUAL_VOTE: 5,

    /** Malus appliqué quand le fetch échoue (404, DNS, timeout...). */
    FETCH_ERROR_PENALTY: 1.5
  },

  // -------------------------------------------------------------------------
  // Langues et lexiques
  //
  // Un score n'est comparable entre sources que si chaque article est évalué
  // dans SA langue. Un article anglais passé au lexique français ne peut que
  // perdre des points (jamais « selon », jamais « d'après ») : ce serait un
  // artefact, pas un jugement.
  //
  // La détection est faite par mots-outils (stopwords) : les mots
  // grammaticaux sont les plus fréquents de toute langue et ne se recouvrent
  // presque pas entre français et anglais. Aucune bibliothèque, aucun appel
  // réseau — fidèle au contrat 100 % local.
  // -------------------------------------------------------------------------

  LANG: {
    /** Langue appliquée quand la détection ne tranche pas. */
    FALLBACK: 'fr',

    /** Écart minimal de mots-outils pour trancher entre deux langues. */
    MIN_MARGIN: 2,

    /**
     * Mots-outils discriminants. Volontairement SANS les ambigus :
     * « on » (fr/en), « a » (fr verbe / en article), « par/pas »…
     */
    STOPWORDS: {
      fr: [
        'le', 'la', 'les', 'des', 'une', 'du', 'au', 'aux', 'est', 'sont',
        'dans', 'pour', 'avec', 'sur', 'qui', 'que', 'ne', 'se', 'ce',
        'cette', 'mais', 'ou', 'où', 'donc', 'être', 'avoir', 'plus',
        'leur', 'nous', 'vous', 'ils', 'elles', 'été', 'était', 'après'
      ],
      en: [
        'the', 'of', 'and', 'to', 'in', 'is', 'are', 'was', 'were', 'has',
        'have', 'that', 'this', 'with', 'for', 'from', 'not', 'but', 'his',
        'her', 'they', 'their', 'been', 'will', 'would', 'could', 'said',
        'about', 'after', 'over', 'more', 'than', 'when', 'which'
      ]
    }
  },

  LEXICON: {
    fr: {
      /** Le texte cite, date, attribue. */
      sourcing: [
        'selon', "d'après", 'étude', 'rapport', 'enquête', 'données',
        'chiffres', 'analyse', 'publié dans', 'communiqué', 'source :',
        'a déclaré', 'a annoncé', 'estime que', 'révèle que'
      ],

      /** Le titre vend une émotion plutôt qu'une information. */
      bait: [
        'vous ne devinerez jamais', 'ce qui se passe ensuite', 'choc',
        'incroyable', 'ils ne veulent pas', 'cliquez', 'top 10',
        'astuce que', 'voici pourquoi', 'personne ne parle de'
      ],

      /** Le texte impose une vérité plutôt qu'il ne l'établit. */
      dogmatic: [
        'incontestable', 'la vérité sur', 'la preuve que', 'censure',
        'on nous cache', 'indéniable', "personne n'ose", 'personne n\u2019ose',
        "ce qu'on ne vous dit pas", 'ce qu\u2019on ne vous dit pas', 'réveillez-vous'
      ],

      /** Charge polarisante : conçu pour indigner ou exalter. */
      emotional: [
        'honteux', 'scandale', 'scandaleux', 'massacre', 'détruit',
        'anéantit', 'pathétique', 'humilie', 'lamentable',
        'terrifiant', 'révoltant', 'accablant'
      ]
    },

    en: {
      sourcing: [
        'according to', 'a study', 'a report', 'survey', 'data show',
        'data from', 'figures', 'analysis', 'published in', 'statement',
        'told reporters', 'announced', 'researchers', 'officials said',
        'sources say'
      ],

      bait: [
        "you won't believe", 'what happens next', 'shocking',
        'this one trick', 'doctors hate', 'top 10', 'click here',
        "here's why", 'no one is talking about', 'goes viral',
        'the real reason'
      ],

      dogmatic: [
        'undeniable', 'the truth about', 'proof that', 'censored',
        // Les formes contractées et développées coexistent dans les vrais
        // titres : « don't » et « do not » doivent tous deux déclencher.
        "they don't want you to know", 'they do not want you to know',
        "what they don't tell you", 'what they do not tell you',
        'wake up', 'mainstream media', 'cover-up', 'irrefutable',
        'the facts they hide'
      ],

      emotional: [
        'disgraceful', 'outrage', 'outrageous', 'slams', 'destroys',
        'obliterates', 'pathetic', 'humiliates', 'appalling',
        'terrifying', 'infuriating', 'devastating', 'shameful'
      ]
    }
  },

  // -------------------------------------------------------------------------
  // Signaux par ARTICLE
  //
  // Chaque `test` renvoie :
  //   false     → ne s'applique pas
  //   true      → s'applique, motif = label
  //   "détail"  → s'applique, motif = label « détail »
  //
  // `ctx` fournit : title, summary, text (title + summary en minuscules),
  // find(liste) → première expression de la liste trouvée dans text.
  // -------------------------------------------------------------------------

  SIGNALS: [
    // --- Sémantique -------------------------------------------------------
    {
      id: 'sourcing',
      label: 'sourcing',
      weight: 1.2,
      test: (item, ctx) => ctx.find('sourcing')
    },
    {
      id: 'bait',
      label: 'appât',
      weight: -2.5,
      test: (item, ctx) => ctx.find('bait')
    },
    {
      id: 'dogmatic',
      label: 'vocabulaire dogmatique',
      weight: -1.5,
      test: (item, ctx) => ctx.find('dogmatic')
    },
    {
      id: 'emotional',
      label: 'charge émotionnelle',
      weight: -1.8,
      test: (item, ctx) => ctx.find('emotional')
    },
    {
      id: 'quantitative',
      label: 'ancrage chiffré',
      weight: 0.8,
      // Pourcentage, montant, unité, ou nombre d'au moins trois chiffres.
      // Volontairement pas « toute date » : une année isolée apparaît dans un
      // titre sur trois et ne dit rien de la factualité du texte.
      test: (item) => {
        const text = `${item.title || ''} ${item.summary || ''}`;
        if (/\d[\d\s.,]*\s?(%|€|\$|£|km|kg|°C|millions?|milliards?|milliers)/i.test(text)) return true;
        // Un nombre d'au moins trois chiffres, à condition que ce ne soit pas
        // une année nue : « les accords de 1995 » n'est pas une mesure.
        return (text.match(/\b\d{3,}\b/g) || []).some((n) => {
          const value = Number(n);
          return !(n.length === 4 && value >= 1500 && value <= 2099);
        });
      }
    },
    {
      id: 'quotes',
      label: 'propos rapportés',
      weight: 0.6,
      // Guillemets typographiques (« » “ ”) toujours acceptés. Guillemets
      // droits acceptés dès 4 caractères si le contenu porte une espace ou un
      // chiffre — ce qui écarte le mot isolé entre quotes ("scandal") utilisé
      // comme surlignage, sans pénaliser les citations anglaises courtes.
      test: (item) => {
        const text = `${item.title || ''} ${item.summary || ''}`;
        if (/[«»\u201C\u201D]/.test(text)) return true;
        const quoted = text.match(/"([^"]{4,})"/g) || [];
        return quoted.some((q) => /[\s\d]/.test(q.slice(1, -1)));
      }
    },

    // --- Typographie ------------------------------------------------------
    {
      id: 'caps',
      label: 'titre en majuscules',
      weight: -2.0,
      // Les sigles sont retirés avant le calcul : « Le PSG affronte l'OM »
      // ne doit pas passer pour un hurlement typographique.
      test: (item) => {
        const title = String(item.title || '');
        const rawLetters = title.match(/\p{L}/gu) || [];
        if (rawLetters.length < 20) return false;
        const rawUpper = title.match(/\p{Lu}/gu) || [];

        // Titre massivement capitalisé : inutile de chercher des sigles, tout
        // en est un. Sans ce court-circuit, un titre anglais entièrement crié
        // passait à travers : ses mots font quatre ou cinq lettres, le retrait
        // des sigles les effaçait tous et il ne restait rien à mesurer.
        if (rawUpper.length / rawLetters.length > 0.8) return true;

        const stripped = title.replace(/\b\p{Lu}{1,5}\b/gu, ' ');
        const letters = stripped.match(/\p{L}/gu) || [];
        if (letters.length < 20) return false;
        const upper = stripped.match(/\p{Lu}/gu) || [];
        return upper.length / letters.length > 0.5;
      }
    },
    {
      id: 'punctuation',
      label: 'ponctuation d\u2019appel',
      weight: -1.5,
      // Points de suspension pénalisés en FIN de titre seulement : au milieu
      // d'une phrase française, ils sont parfaitement légitimes.
      test: (item) => {
        const title = String(item.title || '');
        return /[!?]{2,}|\?!|!\?/.test(title) || /(\.\.\.|\u2026)\s*$/.test(title);
      }
    },

    // --- Métadonnées et structure ----------------------------------------
    {
      id: 'author',
      label: 'auteur identifié',
      weight: 0.4,
      test: (item) => Boolean(item.author)
    },
    {
      id: 'links',
      label: 'liens sortants',
      weight: 1.0,
      test: (item) => Boolean(item.has_links)
    },
    {
      id: 'categories',
      label: 'article catégorisé',
      weight: 0.5,
      test: (item) => Array.isArray(item.categories) && item.categories.length > 0
    },
    {
      id: 'updated',
      label: 'article mis à jour',
      weight: 0.5,
      // Comparaison au niveau ARTICLE (atom:updated, date_modified), pas
      // <lastBuildDate> : cette balise décrit le CANAL, pas l'article. La
      // comparer au pubDate d'un article ferait feu à chaque publication.
      test: (item) =>
        Number.isFinite(item.updated_ts) &&
        Number.isFinite(item.published_ts) &&
        item.updated_ts - item.published_ts > 3600000
    },
    {
      id: 'thin',
      label: 'contenu mince',
      weight: -0.6,
      test: (item) => (item.summary || '').length < 120
    }
  ],

  // -------------------------------------------------------------------------
  // Signaux par SALVE — un rythme de publication ne s'observe pas article
  // par article. Évalués sur l'ensemble des articles inédits d'une synchro.
  // -------------------------------------------------------------------------

  BATCH_SIGNALS: [
    {
      id: 'bot_velocity',
      label: 'publication automatisée',
      weight: -3.0,
      // Seuil à 4 et non 2 : beaucoup de CMS horodatent un import groupé de
      // façon identique sans que ce soit du spam.
      test: (items) => {
        const buckets = new Map();
        for (const item of items) {
          if (!Number.isFinite(item.published_ts)) continue;
          const second = Math.floor(item.published_ts / 1000);
          buckets.set(second, (buckets.get(second) || 0) + 1);
        }
        const worst = buckets.size ? Math.max(...buckets.values()) : 0;
        return worst >= 4 ? `${worst} articles à la même seconde` : false;
      }
    }
  ],

  /** Flux installés au premier lancement, uniquement pour avoir un écran non vide. */
  DEFAULT_SOURCES: [
    { url: 'https://www.lemonde.fr/rss/une.xml', title: 'Le Monde — Une' },
    { url: 'https://feeds.bbci.co.uk/news/world/rss.xml', title: 'BBC News — World' },
    { url: 'https://hnrss.org/frontpage', title: 'Hacker News — Front page' }
  ]
};

// Partage explicite entre scripts classiques (event page + popup).
globalThis.TP_CONFIG = TP_CONFIG;
