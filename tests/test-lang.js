const fs = require('fs');
const vm = require('vm');
const base = require('path').join(__dirname, '..', 'src') + '/';

const ctx = vm.createContext({ console, Date, Math, Number, Array, Map, Set, URL, JSON, String, Object, Boolean });
for (const f of ['config.js', 'scoring.js']) {
  vm.runInContext(fs.readFileSync(base + f, 'utf8'), ctx, { filename: f });
}
const { TP_SCORING, TP_CONFIG } = ctx;

let fails = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? ' ok ' : 'FAIL'}  ${label}${extra ? '  → ' + extra : ''}`);
  if (!cond) fails++;
};

const FR_LONG = 'Le conseil a examiné les propositions qui sont dans le rapport pour les communes concernées par cette réforme des services.';
const EN_LONG = 'The council said that the proposals in the report will be reviewed after officials have examined the data from this survey.';
const item = (o) => ({ title: '', summary: '', author: '', categories: [], ...o });
const evalItem = (o) => TP_SCORING.evaluateItem(item(o));

// --- Détection ---------------------------------------------------------------
check('français détecté', TP_SCORING.detectLang(FR_LONG).lang === 'fr' && TP_SCORING.detectLang(FR_LONG).confident);
check('anglais détecté', TP_SCORING.detectLang(EN_LONG).lang === 'en' && TP_SCORING.detectLang(EN_LONG).confident);
check('titre court non tranché', TP_SCORING.detectLang('Budget 2027').confident === false);
check('texte vide non tranché', TP_SCORING.detectLang('').confident === false);

// --- Résolution de langue : détection → source → défaut ----------------------
check('langue de la source en filet', evalItem({ title: 'Budget update', lang: 'en' }).lang === 'en');
check('défaut quand rien ne tranche', evalItem({ title: 'Budget 2027' }).lang === TP_CONFIG.LANG.FALLBACK);
check('détection prime sur la source',
  evalItem({ title: EN_LONG, lang: 'fr' }).lang === 'en',
  'un article anglais dans un flux déclaré fr est évalué en anglais');

// --- Lexiques anglais --------------------------------------------------------
check('sourcing en', evalItem({ title: 'According to the report, the figures were revised', summary: EN_LONG }).fired.includes('sourcing'));
check('bait en', evalItem({ title: "You won't believe what the mayor did", summary: EN_LONG }).fired.includes('bait'));
check('dogmatic en', evalItem({ title: 'The truth about the vaccines they censored', summary: EN_LONG }).fired.includes('dogmatic'));
check('emotional en', evalItem({ title: 'Pundit destroys rival in appalling exchange', summary: EN_LONG }).fired.includes('emotional'));

// --- Étanchéité : pas de contamination croisée -------------------------------
check('« choc » inerte en anglais',
  !evalItem({ title: 'Supply chain choc points examined', summary: EN_LONG, lang: 'en' }).fired.includes('bait'));
check('« slams » inerte en français',
  !evalItem({ title: 'Le conseil examine les slams du festival', summary: FR_LONG, lang: 'fr' }).fired.includes('emotional'));
check('article fr toujours scoré fr',
  evalItem({ title: 'Selon une étude, les chiffres progressent', summary: FR_LONG }).fired.includes('sourcing'));

// --- Symétrie des signaux non lexicaux ---------------------------------------
const frCaps = evalItem({ title: 'UN TITRE ENTIEREMENT CRIE PAR LA REDACTION', summary: FR_LONG });
const enCaps = evalItem({ title: 'A HEADLINE ENTIRELY SHOUTED BY THE NEWSROOM', summary: EN_LONG });
check('caps identique dans les deux langues', frCaps.fired.includes('caps') === enCaps.fired.includes('caps'));
// Régression trouvée par le replay : les mots anglais font 4-5 lettres, donc le
// retrait des sigles les effaçait tous et il ne restait rien à mesurer.
check('titre anglais tout en capitales détecté',
  evalItem({ title: 'SHOCKING TRUTH ABOUT WHAT THEY DO NOT WANT YOU TO KNOW', summary: EN_LONG }).fired.includes('caps'));
check('sigles anglais toujours épargnés',
  !evalItem({ title: 'The BBC and the NHS reported new figures this morning', summary: EN_LONG }).fired.includes('caps'));
check('dogmatique en, forme non contractée',
  evalItem({ title: 'The report they do not want you to know about', summary: EN_LONG }).fired.includes('dogmatic'));

// --- Équité de bout en bout --------------------------------------------------
const frGood = evalItem({ title: 'Selon une étude, 42 % des foyers concernés « dès 2027 »', summary: FR_LONG, author: 'A. Dupont' });
const enGood = evalItem({ title: 'According to a study, 42% of households affected "by 2027"', summary: EN_LONG, author: 'J. Smith' });
check('article vertueux : delta identique fr/en',
  Math.abs(frGood.delta - enGood.delta) < 0.001,
  `fr ${frGood.delta} / en ${enGood.delta}`);

const frBad = evalItem({ title: 'Choc : vous ne devinerez jamais la vérité sur ce scandale honteux', summary: 'Court.' });
const enBad = evalItem({ title: "Shocking: you won't believe the truth about this disgraceful outrage", summary: 'Short.' });
check('article toxique : delta identique fr/en',
  Math.abs(frBad.delta - enBad.delta) < 0.001,
  `fr ${frBad.delta} / en ${enBad.delta}`);

// --- Cohérence des lexiques --------------------------------------------------
const langs = Object.keys(TP_CONFIG.LEXICON);
check('mêmes catégories dans chaque langue',
  langs.every((l) => ['sourcing', 'bait', 'dogmatic', 'emotional'].every((c) => Array.isArray(TP_CONFIG.LEXICON[l][c]) && TP_CONFIG.LEXICON[l][c].length >= 8)),
  langs.join(', '));
check('stopwords fr/en disjoints', (() => {
  const fr = new Set(TP_CONFIG.LANG.STOPWORDS.fr);
  return !TP_CONFIG.LANG.STOPWORDS.en.some((w) => fr.has(w));
})());
check('lexiques en minuscules', langs.every((l) =>
  Object.values(TP_CONFIG.LEXICON[l]).every((list) => list.every((e) => e === e.toLowerCase()))));

console.log(fails ? `\n${fails} échec(s)` : '\nTous les tests passent.');
process.exit(fails ? 1 : 0);
