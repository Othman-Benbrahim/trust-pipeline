const fs = require('fs');
const vm = require('vm');
const base = require('path').join(__dirname, '..', 'src') + '/';

const ctx = vm.createContext({ console, Date, Math, Number, Array, Map, Set, URL, JSON });
for (const f of ['config.js', 'scoring.js']) {
  vm.runInContext(fs.readFileSync(base + f, 'utf8'), ctx, { filename: f });
}
const { TP_SCORING, TP_CONFIG } = ctx;

const DAY = 86400000;
let fails = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? ' ok ' : 'FAIL'}  ${label}${extra ? '  → ' + extra : ''}`);
  if (!cond) fails++;
};

const mk = (anchor, activeDaysAgo, now) => ({
  score_anchor: anchor,
  anchor_ts: now - activeDaysAgo * DAY,
  last_active_ts: now - activeDaysAgo * DAY,
  history: []
});

const now = Date.now();

// 1. Délai de grâce : aucune érosion sous GRACE_DAYS
check('grâce 2j → score intact', Math.abs(TP_SCORING.effectiveScore(mk(60, 1.5, now), now) - 60) < 1e-9);

// 2. Demi-vie : à grâce + 14j, la part au-dessus du plancher est divisée par 2
const halfLife = TP_CONFIG.SCORE.GRACE_DAYS + TP_CONFIG.SCORE.HALF_LIFE_DAYS;
const expected = TP_CONFIG.SCORE.FLOOR + (60 - TP_CONFIG.SCORE.FLOOR) / 2;
const got = TP_SCORING.effectiveScore(mk(60, halfLife, now), now);
check('demi-vie exacte', Math.abs(got - expected) < 1e-6, `${got.toFixed(3)} vs ${expected}`);

// 3. Idempotence : 1000 lectures ne dégradent rien (le bug de composition)
const s = mk(60, 20, now);
let last;
for (let i = 0; i < 1000; i++) last = TP_SCORING.effectiveScore(s, now);
check('1000 lectures = 1 lecture', Math.abs(last - TP_SCORING.effectiveScore(s, now)) < 1e-12, last.toFixed(4));

// 4. Plancher asymptotique : jamais sous FLOOR, jamais nul
const dead = TP_SCORING.effectiveScore(mk(90, 3650, now), now);
check('10 ans de silence > plancher', dead >= TP_CONFIG.SCORE.FLOOR && dead < TP_CONFIG.SCORE.FLOOR + 0.01, dead.toFixed(6));

// 5. Ancre sous le plancher : la décroissance ne remonte pas le score
check('ancre 2 sous plancher reste 2', TP_SCORING.effectiveScore(mk(2, 400, now), now) === 2);

// 6. Ré-ancrage : cristallise la décroissance puis applique le delta
const r = mk(60, halfLife, now);
const after = TP_SCORING.reanchor(r, +8, { now, activeTs: now, reason: 'test' });
check('reanchor = décroissance + delta', Math.abs(after - (expected + 8)) < 1e-6, after.toFixed(3));
check('ancre réécrite', r.score_anchor === after && r.anchor_ts === now);
check('historique tracé', r.history.length === 1 && r.history[0].reason === 'test');

// 7. Bornes
check('plafond 100 respecté', TP_SCORING.reanchor(mk(98, 0, now), +50, { now }) === 100);
check('plancher 0 respecté', TP_SCORING.reanchor(mk(3, 0, now), -50, { now }) === 0);

// 8. Date de publication future ignorée
const fut = mk(50, 5, now);
TP_SCORING.reanchor(fut, 1, { now, activeTs: now + 10 * DAY });
check('activeTs futur clampé à now', fut.last_active_ts <= now);

// 9. Écrêtage de salve
const flood = Array.from({ length: 60 }, () => ({ title: 'scandale incroyable', summary: '', author: '' }));
const batch = TP_SCORING.evaluateBatch(flood);
check('salve écrêtée', batch.delta === -TP_CONFIG.SCORE.MAX_DELTA_PER_SYNC && batch.clipped, `brut ${batch.raw.toFixed(1)}`);

// 10. Distinction qualitative
const good = TP_SCORING.evaluateItem({ title: "Selon une étude du CNRS", summary: 'x'.repeat(300), author: 'A. Dupont' });
const bad = TP_SCORING.evaluateItem({ title: 'Vous ne devinerez jamais la suite', summary: '', author: '' });
check('article sourcé > appât', good.delta > 0 && bad.delta < 0, `${good.delta.toFixed(2)} / ${bad.delta.toFixed(2)}`);

// 11. Classement dynamique
const ranked = TP_SCORING.rank([mk(40, 0, now), mk(90, 200, now), mk(70, 0, now)], now);
check('tri par score effectif', ranked[0].score_anchor === 70 && ranked[2].score_anchor === 90);

// 12. Projection 7 jours strictement décroissante
const p = mk(80, 10, now);
check('projection < actuel', TP_SCORING.projectedScore(p, 7, now) < TP_SCORING.effectiveScore(p, now));

console.log(fails ? `\n${fails} échec(s)` : '\nTous les tests passent.');
process.exit(fails ? 1 : 0);
