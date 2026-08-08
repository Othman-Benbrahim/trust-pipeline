/**
 * popup.js — Interface de lecture et de commande.
 *
 * Le popup ne calcule aucun score et n'écrit jamais dans le stockage :
 * il envoie des messages au background et affiche ce qu'on lui renvoie.
 * Une seule source de vérité, côté event page.
 */

const api = typeof browser !== 'undefined' ? browser : chrome;

const el = {
  readout: document.getElementById('readout'),
  sync: document.getElementById('sync'),
  form: document.getElementById('add-form'),
  url: document.getElementById('add-url'),
  notice: document.getElementById('notice'),
  grant: document.getElementById('grant'),
  grantText: document.getElementById('grant-text'),
  grantBtn: document.getElementById('grant-btn'),
  export: document.getElementById('export'),
  ranking: document.getElementById('ranking'),
  empty: document.getElementById('empty'),
  stats: document.getElementById('foot-stats'),
  template: document.getElementById('row-template')
};

/** Motifs de permission en attente, rafraîchis à chaque rendu. */
let pendingOrigins = [];

/** Un flux = un domaine. On ne demande jamais plus que nécessaire. */
function originPattern(url) {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.hostname}/*`;
}

// --- Formatage --------------------------------------------------------------

function host(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function humanDelay(ms) {
  if (ms == null) return 'jamais';
  const min = Math.round(ms / 60000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `il y a ${h} h`;
  return `il y a ${Math.round(h / 24)} j`;
}

function humanSilence(days) {
  if (days < 1) return `silence ${Math.round(days * 24)} h`;
  return `silence ${days.toFixed(days < 10 ? 1 : 0)} j`;
}

function notify(message, isError = true) {
  el.notice.textContent = message;
  el.notice.hidden = !message;
  el.notice.style.color = isError ? 'var(--alert)' : 'var(--live)';
}

// --- Rendu ------------------------------------------------------------------

function renderSource(source, index) {
  const node = el.template.content.firstElementChild.cloneNode(true);
  const q = (attr) => node.querySelector(`[${attr}]`);

  node.dataset.id = source.id;
  if (source.score < 30) node.classList.add('is-faint');

  q('data-rank').textContent = String(index + 1).padStart(2, '0');
  q('data-title').textContent = source.title || host(source.url);
  q('data-host').textContent = host(source.url);
  q('data-score').textContent = source.score.toFixed(1);

  // Piste de décroissance : plein = maintenant, hachures = érosion à 7 jours.
  const now = Math.max(0, Math.min(100, source.score));
  const then = Math.max(0, Math.min(100, source.projected_7d));
  q('data-fill').style.width = `${now}%`;

  const loss = q('data-loss');
  loss.style.left = `${then}%`;
  loss.style.width = `${Math.max(0, now - then)}%`;

  q('data-track').setAttribute(
    'aria-label',
    `Score ${source.score.toFixed(1)} sur 100. Sans nouvelle publication, ${then.toFixed(1)} dans 7 jours.`
  );

  const lang = q('data-lang');
  if (source.lang) {
    lang.textContent = source.lang;
    lang.title = 'Langue détectée — les signaux sémantiques utilisent ce lexique';
    lang.hidden = false;
  }

  q('data-silence').textContent = humanSilence(source.silence_days);
  q('data-count').textContent = `${source.items_seen || 0} articles`;

  const error = q('data-error');
  if (source.needs_permission) {
    error.textContent = 'accès à autoriser';
    error.hidden = false;
  } else if (source.last_status === 'error') {
    error.textContent = source.last_error || 'échec';
    error.hidden = false;
  }

  renderLog(q('data-log'), source.history);
  return node;
}

/**
 * Le score se justifie ou ne vaut rien. Chaque mouvement enregistré porte sa
 * raison ; on l'affiche telle quelle plutôt que de demander à l'utilisateur
 * de faire confiance à un nombre.
 */
function renderLog(list, history) {
  const entries = Array.isArray(history) ? history.slice(0, 6) : [];

  if (entries.length === 0) {
    const li = document.createElement('li');
    li.className = 'log__empty';
    li.textContent = 'Aucun mouvement. Le premier passage sur un flux ne touche pas au score.';
    list.append(li);
    return;
  }

  for (const entry of entries) {
    const li = document.createElement('li');

    const delta = document.createElement('span');
    delta.className = `log__delta log__delta--${entry.delta >= 0 ? 'up' : 'down'}`;
    delta.textContent = `${entry.delta >= 0 ? '+' : ''}${Number(entry.delta).toFixed(1)}`;

    const reason = document.createElement('span');
    reason.className = 'log__reason';
    reason.textContent = entry.reason || 'sans motif enregistré';

    const when = document.createElement('span');
    when.className = 'log__when';
    when.textContent = humanDelay(Date.now() - entry.ts);

    li.append(delta, reason, when);
    list.append(li);
  }
}

function renderGrant(origins) {
  pendingOrigins = origins || [];
  const count = pendingOrigins.length;
  el.grant.hidden = count === 0;
  if (count === 0) return;

  el.grantText.textContent =
    count === 1
      ? `Trust Pipeline a besoin d’accéder à ${pendingOrigins[0].replace(/^\*?:?\/*/, '').replace('/*', '')} pour lire son flux.`
      : `Trust Pipeline a besoin d’accéder à ${count} domaines pour lire leurs flux.`;
}

function render(state) {
  const { sources, meta, items } = state;

  el.ranking.replaceChildren(...sources.map(renderSource));
  el.empty.hidden = sources.length > 0;
  renderGrant(state.missing_origins);

  el.readout.textContent = meta.syncing
    ? 'Synchronisation en cours…'
    : `Synchro ${humanDelay(meta.last_sync_ts ? Date.now() - meta.last_sync_ts : null)}`;

  el.stats.textContent = `${sources.length} sources · ${items.length} articles`;
  setBusy(Boolean(meta.syncing));
}

function setBusy(busy) {
  el.sync.disabled = busy;
  el.sync.classList.toggle('is-busy', busy);
  el.sync.textContent = busy ? 'En cours' : 'Synchroniser';
}

// --- Échanges avec le background -------------------------------------------

async function send(message) {
  const response = await api.runtime.sendMessage(message);
  if (response && response.error) throw new Error(response.error);
  return response;
}

async function refresh() {
  try {
    render(await send({ type: 'GET_STATE' }));
  } catch (error) {
    notify(`Interface déconnectée du moteur : ${error.message}`);
  }
}

// --- Interactions -----------------------------------------------------------

el.sync.addEventListener('click', async () => {
  notify('');
  setBusy(true);
  try {
    const summary = await send({ type: 'FORCE_SYNC' });
    await refresh();
    notify(
      `${summary.items_added} nouveaux articles sur ${summary.sources_checked} sources` +
        (summary.errors ? ` · ${summary.errors} en échec` : ''),
      summary.errors > 0
    );
  } catch (error) {
    notify(`Synchronisation interrompue : ${error.message}`);
    setBusy(false);
  }
});

el.grantBtn.addEventListener('click', async () => {
  if (pendingOrigins.length === 0) return;
  notify('');
  try {
    // Premier await de la fonction : le geste utilisateur est encore valide.
    // Firefox refuse permissions.request() en dehors d'une interaction directe.
    const granted = await api.permissions.request({ origins: pendingOrigins });
    if (!granted) {
      notify('Accès refusé. Les flux concernés resteront en attente.');
      return;
    }
    await send({ type: 'FORCE_SYNC' });
    await refresh();
  } catch (error) {
    notify(`Autorisation impossible : ${error.message}`);
  }
});

el.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const url = el.url.value.trim();
  if (!url) return;

  let pattern;
  try {
    pattern = originPattern(url);
  } catch {
    notify('URL invalide. Attendu : https://domaine.fr/flux.xml');
    return;
  }

  notify('');
  try {
    const granted = await api.permissions.request({ origins: [pattern] });
    if (!granted) {
      notify('Sans accès à ce domaine, le flux ne peut pas être lu.');
      return;
    }
  } catch (error) {
    notify(`Autorisation impossible : ${error.message}`);
    return;
  }

  setBusy(true);
  try {
    await send({ type: 'ADD_SOURCE', url });
    el.url.value = '';
    await refresh();
    notify('Source ajoutée et interrogée.', false);
  } catch (error) {
    notify(error.message);
    setBusy(false);
  }
});

el.ranking.addEventListener('click', async (event) => {
  const toggle = event.target.closest('[data-toggle]');
  if (toggle) {
    const log = toggle.closest('.src').querySelector('[data-log]');
    const opening = log.hidden;
    log.hidden = !opening;
    toggle.setAttribute('aria-expanded', String(opening));
    toggle.textContent = opening ? 'Masquer le détail' : 'Pourquoi ce score ?';
    return;
  }

  const button = event.target.closest('[data-action]');
  if (!button) return;

  const id = button.closest('.src').dataset.id;
  const action = button.dataset.action;

  try {
    if (action === 'remove') {
      render(await send({ type: 'REMOVE_SOURCE', id }));
    } else {
      render(await send({ type: 'VOTE', id, direction: action }));
    }
  } catch (error) {
    notify(error.message);
  }
});

/**
 * Téléchargement local, sans permission `downloads` : un Blob, une URL objet,
 * un clic simulé. Le fichier ne transite par aucun serveur.
 */
el.export.addEventListener('click', async () => {
  notify('');
  try {
    const corpus = await send({ type: 'EXPORT_CORPUS' });
    const blob = new Blob([JSON.stringify(corpus, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const stamp = new Date(corpus.exported_at).toISOString().slice(0, 10);

    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `trust-pipeline-corpus-${stamp}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);

    notify(`${corpus.items.length} articles exportés.`, false);
  } catch (error) {
    notify(`Export impossible : ${error.message}`);
  }
});

// Le background pousse l'état quand une synchro se termine pendant l'ouverture.
api.runtime.onMessage.addListener((message) => {
  if (message.type === 'SYNC_STARTED') setBusy(true);
  if (message.type === 'SYNC_DONE') refresh();
});

refresh();
