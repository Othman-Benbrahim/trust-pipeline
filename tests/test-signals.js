const fs = require('fs');
const vm = require('vm');
const base = require('path').join(__dirname, '..', 'src') + '/';

const ctx = vm.createContext({ console, Date, Math, Number, Array, Map, Set, URL, JSON, String, Object, Boolean });
for (const f of ['config.js', 'scoring.js', 'xml.js', 'parser.js']) {
  vm.runInContext(fs.readFileSync(base + f, 'utf8'), ctx, { filename: f });
}
const { TP_SCORING, TP_CONFIG, TP_PARSER } = ctx;

let fails = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? ' ok ' : 'FAIL'}  ${label}${extra ? '  → ' + extra : ''}`);
  if (!cond) fails++;
};

const LONG = 'Un paragraphe de résumé assez long pour ne pas déclencher le signal de contenu mince, avec de la matière descriptive dedans et encore un peu.';
const item = (o) => ({ title: '', summary: LONG, author: '', categories: [], ...o });
const fired = (o) => TP_SCORING.evaluateItem(item(o)).fired;

// --- Typographie -------------------------------------------------------------
check('majuscules détectées', fired({ title: 'UN TITRE ENTIEREMENT CRIE PAR LA REDACTION' }).includes('caps'));
check('titre normal épargné', !fired({ title: 'Le conseil municipal a voté le budget hier soir' }).includes('caps'));
check('sigles non pénalisés', !fired({ title: "Le PSG affronte l'OM ce soir au Parc des Princes" }).includes('caps'),
  'PSG/OM retirés avant calcul');
check('titre court ignoré', !fired({ title: 'ALERTE' }).includes('caps'));

check('ponctuation multiple', fired({ title: 'Il a vraiment dit ça ?!' }).includes('punctuation'));
check('suspension finale', fired({ title: 'Ce qu’il a répondu ensuite...' }).includes('punctuation'));
check('suspension médiane épargnée',
  !fired({ title: 'Il hésite... puis signe le contrat en fin de séance' }).includes('punctuation'));

// --- Sémantique --------------------------------------------------------------
check('ancrage chiffré %', fired({ title: 'Le chômage recule de 2,3 % au deuxième trimestre' }).includes('quantitative'));
check('année seule non comptée', !fired({ title: 'Retour sur les accords de 1995' }).includes('quantitative'),
  'une date n’est pas un ancrage factuel');
check('propos rapportés', fired({ title: 'Le maire annonce « une réforme complète »' }).includes('quotes'));
check('dogmatique', fired({ title: 'La vérité sur ce qu’on ne vous dit pas' }).includes('dogmatic'));
check('émotionnel', fired({ title: 'Un budget lamentable et révoltant' }).includes('emotional'));

// --- Métadonnées -------------------------------------------------------------
check('liens sortants', fired({ title: 'Note', has_links: true }).includes('links'));
check('catégories', fired({ title: 'Note', categories: ['Politique'] }).includes('categories'));

const now = Date.now();
check('mise à jour a posteriori',
  fired({ title: 'Note', published_ts: now - 7200000, updated_ts: now }).includes('updated'));
check('mise à jour simultanée ignorée',
  !fired({ title: 'Note', published_ts: now, updated_ts: now + 1000 }).includes('updated'));

// --- Plafond par article -----------------------------------------------------
const worst = TP_SCORING.evaluateItem(item({
  title: 'SCANDALE INCONTESTABLE : LA VERITE SUR CE MASSACRE HONTEUX !!!',
  summary: 'Court.'
}));
check('article catastrophique écrêté',
  worst.delta === TP_CONFIG.SCORE.MAX_ITEM_LOSS && worst.clipped,
  `brut ${worst.raw.toFixed(1)} → ${worst.delta}`);

const best = TP_SCORING.evaluateItem(item({
  title: 'Selon une étude, les émissions reculent de 12 % « depuis 2020 »',
  author: 'A. Dupont', categories: ['Climat'], has_links: true,
  published_ts: now - 7200000, updated_ts: now
}));
check('article exemplaire écrêté',
  best.delta === TP_CONFIG.SCORE.MAX_ITEM_GAIN && best.clipped,
  `brut ${best.raw.toFixed(1)} → ${best.delta}`);
check('gain plafonné sous la perte', TP_CONFIG.SCORE.MAX_ITEM_GAIN < -TP_CONFIG.SCORE.MAX_ITEM_LOSS);

// --- Signal de salve ---------------------------------------------------------
const sameSecond = Array.from({ length: 5 }, (_, i) => item({ title: `Dépêche ${i}`, published_ts: 1750000000000 }));
const spread = Array.from({ length: 5 }, (_, i) => item({ title: `Dépêche ${i}`, published_ts: 1750000000000 + i * 60000 }));
const botBatch = TP_SCORING.evaluateBatch(sameSecond);
check('rafale automatisée détectée', botBatch.reasons.some((r) => /automatisée/.test(r)), botBatch.reasons.join(' | '));
check('publication étalée épargnée',
  !TP_SCORING.evaluateBatch(spread).reasons.some((r) => /automatisée/.test(r)));
check('seuil à 4 respecté',
  !TP_SCORING.evaluateBatch(sameSecond.slice(0, 3)).reasons.some((r) => /automatisée/.test(r)));

// --- Robustesse --------------------------------------------------------------
const broken = { id: 'x', label: 'défectueux', weight: -99, test: () => { throw new Error('boom'); } };
const safe = TP_SCORING.evaluateItem(item({ title: 'Note' }), [...TP_CONFIG.SIGNALS, broken]);
check('signal défectueux ignoré', !safe.fired.includes('x') && safe.delta > -50, String(safe.delta));
check('article vide ne casse rien', typeof TP_SCORING.evaluateItem({}).delta === 'number');

// --- Chaîne complète : parser → signaux --------------------------------------
const feed = `<?xml version="1.0"?><rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel><title>T</title><lastBuildDate>Fri, 07 Aug 2026 10:00:00 GMT</lastBuildDate>
<item><title>Selon le rapport, 42 % des foyers concernés</title>
<link>https://t.test/1</link><category>Économie</category><category>Social</category>
<pubDate>Fri, 07 Aug 2026 08:00:00 GMT</pubDate>
<atom:updated>Fri, 07 Aug 2026 09:30:00 GMT</atom:updated>
<description><![CDATA[<p>Le texte complet avec une <a href="https://source.test">référence externe</a> et suffisamment de matière pour dépasser le seuil de contenu mince sans difficulté.</p>]]></description>
</item></channel></rss>`;

const parsed = TP_PARSER.parseFeed(feed, 'application/rss+xml', 'https://t.test/rss');
const article = parsed.items[0];
check('catégories extraites', article.categories.join(',') === 'Économie,Social', article.categories.join(','));
check('liens sortants détectés sur le HTML brut', article.has_links === true);
check('atom:updated lu au niveau item', Number.isFinite(article.updated_ts));
check('lastBuildDate du canal non confondu', article.updated_ts !== Date.parse('Fri, 07 Aug 2026 10:00:00 GMT'));

const endToEnd = TP_SCORING.evaluateItem(article);
check('article vertueux positif', endToEnd.delta > 0, `${endToEnd.delta} — ${endToEnd.reasons.join(', ')}`);
check('motifs lisibles', endToEnd.reasons.some((r) => /sourcing/.test(r)), endToEnd.reasons.join(' | '));

console.log(fails ? `\n${fails} échec(s)` : '\nTous les tests passent.');
process.exit(fails ? 1 : 0);
