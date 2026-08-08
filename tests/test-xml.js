const fs = require('fs');
const vm = require('vm');
const base = require('path').join(__dirname, '..', 'src') + '/';

const ctx = vm.createContext({ console, Date, Math, Number, Array, Map, Set, URL, JSON, String, Object });
vm.runInContext(fs.readFileSync(base + 'xml.js', 'utf8'), ctx, { filename: 'xml.js' });
const { TP_XML } = ctx;

let fails = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? ' ok ' : 'FAIL'}  ${label}${extra ? '  → ' + extra : ''}`);
  if (!cond) fails++;
};
const throws = (label, fn, pattern) => {
  try { fn(); check(label, false, 'aucune erreur levée'); }
  catch (e) { check(label, pattern.test(e.message), e.message); }
};

// --- Structure ---------------------------------------------------------------
const d = TP_XML.parse('<rss version="2.0"><channel><title>Flux</title></channel></rss>');
check('racine identifiée', d.documentElement.localName === 'rss');
check('attribut lu', d.documentElement.getAttribute('version') === '2.0');
check('descente dans l\'arbre', d.documentElement.children[0].children[0].textContent === 'Flux');

// --- Namespaces --------------------------------------------------------------
const ns = TP_XML.parse('<rdf:RDF xmlns:dc="x"><dc:creator>A. Dupont</dc:creator></rdf:RDF>');
check('nodeName conserve le préfixe', ns.documentElement.nodeName === 'rdf:RDF');
check('localName le retire', ns.documentElement.localName === 'RDF');
check('enfant préfixé', ns.documentElement.children[0].localName === 'creator');

// --- Pièges d'attributs ------------------------------------------------------
const tricky = TP_XML.parse('<a><b t="1 > 0" u=\'guillemet " simple\' v=nu>ok</b></a>');
const b = tricky.documentElement.children[0];
check('« > » dans une valeur d\'attribut', b.getAttribute('t') === '1 > 0', b.getAttribute('t'));
check('apostrophes délimitantes', b.getAttribute('u') === 'guillemet " simple');
check('valeur non quotée', b.getAttribute('v') === 'nu');
check('texte préservé malgré tout', b.textContent === 'ok');
check('attribut absent → null', b.getAttribute('zzz') === null);
check('attribut insensible au préfixe', TP_XML.parse('<a xlink:href="u"/>').documentElement.getAttribute('href') === 'u');

// --- Auto-fermeture, commentaires, PI, DOCTYPE -------------------------------
const sc = TP_XML.parse('<f><link rel="alternate" href="/x" /><link rel="edit" href="/y"/></f>');
check('balises auto-fermantes', sc.documentElement.children.length === 2);
check('auto-fermante non empilée', sc.documentElement.children[1].getAttribute('rel') === 'edit');

const noise = TP_XML.parse(
  '<?xml version="1.0"?><!DOCTYPE rss [ <!ENTITY x "y"> ]><!-- <fake> --><r><i>v</i></r>'
);
check('prologue, DOCTYPE et commentaire ignorés', noise.documentElement.localName === 'r');
check('commentaire non interprété comme balise', noise.documentElement.children.length === 1);

// --- CDATA -------------------------------------------------------------------
const cd = TP_XML.parse('<r><d><![CDATA[<p>brut &#233; <b>gras</b></p>]]></d></r>');
check('CDATA restitué littéralement',
  cd.documentElement.children[0].textContent === '<p>brut &#233; <b>gras</b></p>',
  cd.documentElement.children[0].textContent);

// --- Entités : le passage unique --------------------------------------------
const dec = TP_XML.decodeEntities;
check('numérique décimale', dec('caf&#233;') === 'café');
check('numérique hexadécimale', dec('&#x2019;') === '\u2019');
check('nommée', dec('&laquo;&nbsp;oui&nbsp;&raquo;') === '«\u00a0oui\u00a0»'.replace(/\u00a0/g, ' '));
check('double encodage préservé', dec('&amp;#233;') === '&#233;', dec('&amp;#233;'));
check('entité inconnue laissée telle quelle', dec('&bogus;') === '&bogus;');
check('point de code hors plage ignoré', dec('&#99999999;') === '&#99999999;');
check('texte sans esperluette inchangé', dec('rien à faire') === 'rien à faire');
check('entités dans le texte d\'un noeud',
  TP_XML.parse('<t>caf&#233; &amp; th&#233;</t>').documentElement.textContent === 'café & thé');

// --- Tolérance et rejets -----------------------------------------------------
check('fermeture orpheline ignorée',
  TP_XML.parse('<r></oops><i>v</i></r>').documentElement.children.length === 1);

throws('balise non fermée rejetée', () => TP_XML.parse('<rss><channel><item>'), /jamais refermée/);
throws('balise ouvrante tronquée rejetée', () => TP_XML.parse('<rss><item attr="x"'), /tronquée/);
throws('document vide rejeté', () => TP_XML.parse('   '), /aucun élément racine/);
throws('texte nu rejeté', () => TP_XML.parse('404 Not Found'), /aucun élément racine/);

// --- Volume ------------------------------------------------------------------
const big = `<rss><channel>${'<item><title>t</title></item>'.repeat(500)}</channel></rss>`;
const t0 = Date.now();
const parsed = TP_XML.parse(big);
check('500 items parsés', parsed.documentElement.children[0].children.length === 500,
  `${Date.now() - t0} ms`);

console.log(fails ? `\n${fails} échec(s)` : '\nTous les tests passent.');
process.exit(fails ? 1 : 0);
