const fs = require('fs');
const vm = require('vm');

const base = require('path').join(__dirname, '..', 'src') + '/';


const ctx = vm.createContext({
  console, Date, Math, Number, Array, Map, Set, URL, JSON, String, Object
});
for (const f of ['config.js', 'scoring.js', 'xml.js', 'parser.js']) {
  vm.runInContext(fs.readFileSync(base + f, 'utf8'), ctx, { filename: f });
}
const { TP_PARSER } = ctx;

let fails = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? ' ok ' : 'FAIL'}  ${label}${extra ? '  → ' + extra : ''}`);
  if (!cond) fails++;
};

// --- RSS 2.0 avec namespaces dc: et content: --------------------------------
const rss = `<?xml version="1.0"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"
     xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Journal Test</title>
    <item>
      <title>Selon une étude, le climat s'emballe</title>
      <link>/article/1</link>
      <guid isPermaLink="false">urn:jt:1</guid>
      <pubDate>Wed, 05 Aug 2026 09:12:00 GMT</pubDate>
      <dc:creator>A. Dupont</dc:creator>
      <content:encoded><![CDATA[<p>Un <b>rapport</b> publi&#233; ce matin&nbsp;: les donn&#233;es sont formelles.</p>]]></content:encoded>
    </item>
    <item>
      <title>Incroyable, vous ne devinerez jamais la suite</title>
      <link>https://autre.fr/a2</link>
      <description>Court.</description>
    </item>
  </channel>
</rss>`;

const r = TP_PARSER.parseFeed(rss, 'application/rss+xml', 'https://journal.test/rss.xml');
check('RSS : titre du flux', r.title === 'Journal Test');
check('RSS : 2 articles', r.items.length === 2);
check('RSS : guid prioritaire sur le lien', r.items[0].id === 'urn:jt:1', r.items[0].id);
check('RSS : lien relatif résolu', r.items[0].link === 'https://journal.test/article/1', r.items[0].link);
check('RSS : dc:creator lu malgré le préfixe', r.items[0].author === 'A. Dupont', r.items[0].author);
check('RSS : CDATA/HTML/entités nettoyés',
  !/[<>&]/.test(r.items[0].summary) && r.items[0].summary.includes('publié'), r.items[0].summary);
check('RSS : pubDate RFC822 parsée', r.items[0].published_ts === Date.parse('Wed, 05 Aug 2026 09:12:00 GMT'));
check('RSS : lien absolu préservé', r.items[1].link === 'https://autre.fr/a2');
check('RSS : id de repli sur le lien', r.items[1].id === 'https://autre.fr/a2');

// --- Atom --------------------------------------------------------------------
const atom = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Carnet</title>
  <entry>
    <title>Note technique</title>
    <id>tag:carnet,2026:1</id>
    <link rel="edit" href="/edit/1"/>
    <link rel="alternate" href="/notes/1"/>
    <published>2026-08-01T10:00:00Z</published>
    <author><name>B. Martin</name></author>
    <summary>Un résumé suffisamment long pour ne pas être compté comme contenu mince par les règles.</summary>
  </entry>
</feed>`;

const a = TP_PARSER.parseFeed(atom, 'application/atom+xml', 'https://carnet.test/feed');
check('Atom : détecté', a.title === 'Carnet' && a.items.length === 1);
check('Atom : rel=alternate choisi, pas rel=edit', a.items[0].link === 'https://carnet.test/notes/1', a.items[0].link);
check('Atom : author>name', a.items[0].author === 'B. Martin');
check('Atom : date ISO', a.items[0].published_ts === Date.parse('2026-08-01T10:00:00Z'));

// --- RSS 1.0 / RDF (items hors du channel) -----------------------------------
const rdf = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
         xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel><title>Ancien flux</title></channel>
  <item><title>Vieux billet</title><link>https://old.test/1</link><dc:date>2026-07-20T08:00:00Z</dc:date></item>
</rdf:RDF>`;

const d = TP_PARSER.parseFeed(rdf, 'text/xml', 'https://old.test/rdf');
check('RDF : items hors channel récupérés', d.items.length === 1 && d.items[0].title === 'Vieux billet');
check('RDF : dc:date parsée', d.items[0].published_ts === Date.parse('2026-07-20T08:00:00Z'));

// --- JSON Feed ---------------------------------------------------------------
const json = JSON.stringify({
  version: 'https://jsonfeed.org/version/1.1',
  title: 'Flux JSON',
  items: [{ id: 'j1', url: 'https://json.test/1', title: 'Entrée', content_text: 'Texte.', date_published: '2026-08-03T12:00:00Z', authors: [{ name: 'C. Roy' }] }]
});
const j = TP_PARSER.parseFeed(json, 'application/json', 'https://json.test/feed.json');
check('JSON Feed : parsé', j.title === 'Flux JSON' && j.items[0].id === 'j1');
check('JSON Feed : authors[0].name', j.items[0].author === 'C. Roy');

// --- Robustesse ---------------------------------------------------------------
check('date future rejetée', TP_PARSER.toTimestamp('2099-01-01T00:00:00Z') === null);
check('date illisible rejetée', TP_PARSER.toTimestamp('bientôt') === null);
check('empreinte stable', TP_PARSER.fingerprint('abc') === TP_PARSER.fingerprint('abc'));
check('empreinte discriminante', TP_PARSER.fingerprint('abc') !== TP_PARSER.fingerprint('abd'));

try { TP_PARSER.parseFeed('<html><body>404</body></html>', 'text/html', 'https://x.test'); check('HTML rejeté', false); }
catch (e) { check('HTML rejeté proprement', /non reconnu|illisible/.test(e.message), e.message); }

try { TP_PARSER.parseFeed('<rss><channel><item>', 'text/xml', 'https://x.test'); check('XML tronqué rejeté', false); }
catch (e) { check('XML tronqué rejeté proprement', true, e.message); }

console.log(fails ? `\n${fails} échec(s)` : '\nTous les tests passent.');
process.exit(fails ? 1 : 0);
