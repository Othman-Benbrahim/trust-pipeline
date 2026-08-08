const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'popup/popup.html'), 'utf8');

const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
const win = dom.window;

const errors = [];
win.addEventListener('error', (e) => errors.push(String(e.error || e.message)));

// --- API browser simulée ----------------------------------------------------
const sent = [];
let STATE_MISSING = ['https://b.test/*'];
win.browser = {
  runtime: {
    sendMessage: async (msg) => {
      sent.push(msg);
      if (msg.type === 'GET_STATE') {
        return {
          now: Date.now(),
          meta: { last_sync_ts: Date.now() - 300000, syncing: false },
          items: [{ id: 'a' }, { id: 'b' }],
          missing_origins: STATE_MISSING,
          sources: [
            { id: 's1', url: 'https://a.test/rss', title: 'Alpha', score: 72.4, projected_7d: 61.2, silence_days: 3.2, items_seen: 12, last_status: 'ok', needs_permission: false },
            { id: 's2', url: 'https://b.test/rss', title: 'Beta', score: 22.1, projected_7d: 18.4, silence_days: 41, items_seen: 3, last_status: 'error', last_error: 'HTTP 404',
              history: [{ ts: Date.now() - 7200000, from: 27.1, to: 22.1, delta: -5, reason: 'appât « choc » ×2' }] }
          ]
        };
      }
      return {};
    },
    onMessage: { addListener: () => {} }
  },
  permissions: { contains: async () => true, request: async () => true }
};

// --- Exécution de popup.js --------------------------------------------------
try {
  win.eval(fs.readFileSync(path.join(ROOT, 'popup/popup.js'), 'utf8'));
} catch (e) {
  errors.push(`popup.js a levé au chargement : ${e.message}`);
}

setTimeout(() => {
  const doc = win.document;
  const rows = doc.querySelectorAll('.src');
  let fails = 0;
  const check = (label, cond, extra = '') => {
    console.log(`${cond ? ' ok ' : 'FAIL'}  ${label}${extra ? '  → ' + extra : ''}`);
    if (!cond) fails++;
  };

  check('aucune erreur au chargement', errors.length === 0, errors.join(' | '));
  check('GET_STATE envoyé', sent.some((m) => m.type === 'GET_STATE'));
  check('2 lignes rendues', rows.length === 2, String(rows.length));

  if (rows.length === 2) {
    check('rang formaté', rows[0].querySelector('[data-rank]').textContent === '01');
    check('titre rendu', rows[0].querySelector('[data-title]').textContent === 'Alpha');
    check('score rendu', rows[0].querySelector('[data-score]').textContent === '72.4');
    check('piste remplie', rows[0].querySelector('[data-fill]').style.width === '72.4%',
      rows[0].querySelector('[data-fill]').style.width);
    check('zone de perte positionnée', rows[0].querySelector('[data-loss]').style.left === '61.2%');
    check('score faible marqué', rows[1].classList.contains('is-faint'));
    check('erreur de flux affichée', rows[1].querySelector('[data-error]').hidden === false);
  }

  check('bannière d’autorisation affichée', doc.getElementById('grant').hidden === false);
  check('domaine nommé dans la bannière', /b\.test/.test(doc.getElementById('grant-text').textContent),
    doc.getElementById('grant-text').textContent);
  check('pied de page rempli', /2 sources/.test(doc.getElementById('foot-stats').textContent));
  check('état vide masqué', doc.getElementById('empty').hidden === true);

  // Journal de score : le « pourquoi » doit être lisible, pas seulement stocké.
  const log = rows[1].querySelector('[data-log]');
  check('journal masqué par défaut', log.hidden === true);
  check('motif du mouvement rendu', /appât/.test(log.textContent), log.textContent.trim());
  check('delta signé', /-5\.0/.test(log.textContent));
  check('journal vide expliqué', /premier passage/.test(rows[0].querySelector('[data-log]').textContent));

  rows[1].querySelector('[data-toggle]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  check('journal dépliable', log.hidden === false);

  check('légende de la barre présente', /érosion/.test(doc.querySelector('.legend').textContent));

  // Régression : `display: flex` écrasait [hidden] et laissait la bannière visible.
  STATE_MISSING = [];
  win.eval('refresh()');
  setTimeout(() => {
    const grant = doc.getElementById('grant');
    check('bannière masquée sans permission manquante', grant.hidden === true);
    const styled = win.getComputedStyle(grant).display;
    check('[hidden] non écrasé par display:flex', styled === 'none', styled);

    console.log(fails ? `\n${fails} échec(s)` : '\nPopup rendu sans erreur.');
    process.exit(fails ? 1 : 0);
  }, 80);
  return;
}, 120);
