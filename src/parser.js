/**
 * parser.js — Normalisation RSS 2.0 / RSS 1.0 (RDF) / Atom / JSON Feed
 * vers une forme unique d'article.
 *
 * Aucune dépendance au DOM : le XML est traité par TP_XML (src/xml.js), un
 * parseur JS pur. Le module fonctionne donc aussi bien dans une event page
 * Firefox que dans un service worker Chrome ou sous Node.
 */

const TP_PARSER = (() => {
  /** Enfants directs dont le nom local correspond (ignore les préfixes de namespace). */
  function kids(el, local) {
    if (!el) return [];
    const target = local.toLowerCase();
    return Array.from(el.children).filter((c) => {
      const name = (c.localName || c.nodeName || '').toLowerCase();
      return name === target || name.endsWith(`:${target}`);
    });
  }

  function text(el, ...locals) {
    for (const local of locals) {
      const found = kids(el, local)[0];
      const value = found && found.textContent ? found.textContent.trim() : '';
      if (value) return value;
    }
    return '';
  }

  /**
   * Nettoie le HTML des descriptions et coupe à une longueur raisonnable.
   * Le décodage d'entités est délégué à TP_XML, en un seul passage.
   */
  function plain(html, max = 400) {
    const stripped = TP_XML.decodeEntities(
      String(html || '')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
    )
      .replace(/\s+/g, ' ')
      .trim();
    return stripped.length > max ? `${stripped.slice(0, max)}…` : stripped;
  }

  /** Date → epoch ms, ou null. Rejette les dates futures aberrantes. */
  function toTimestamp(raw) {
    if (!raw) return null;
    const ts = Date.parse(String(raw).trim());
    if (!Number.isFinite(ts)) return null;
    if (ts > Date.now() + 86400000) return null;
    return ts;
  }

  /** Empreinte stable quand le flux ne fournit ni guid ni lien. */
  function fingerprint(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return `fp_${(h >>> 0).toString(36)}`;
  }

  function absolute(href, base) {
    if (!href) return '';
    try {
      return new URL(href, base).href;
    } catch {
      return href;
    }
  }

  /** Le résumé contient-il des liens sortants ? Testé sur le HTML brut. */
  function hasLinks(rawHtml) {
    return /<a\s[^>]*href\s*=/i.test(String(rawHtml || ''));
  }

  function normalize(raw, feedUrl) {
    const link = absolute(raw.link, feedUrl);
    const id = raw.id || link || fingerprint(`${raw.title}|${raw.published_ts || ''}`);
    return {
      id,
      title: raw.title || '(sans titre)',
      link,
      summary: raw.summary || '',
      author: raw.author || '',
      published_ts: raw.published_ts || null,
      updated_ts: raw.updated_ts || null,
      categories: Array.isArray(raw.categories) ? raw.categories.filter(Boolean).slice(0, 8) : [],
      has_links: Boolean(raw.has_links)
    };
  }

  // --- RSS 2.0 et RSS 1.0 / RDF ------------------------------------------

  function parseRss(doc, feedUrl) {
    const root = doc.documentElement;
    const channel = kids(root, 'channel')[0] || root;
    // RSS 1.0 place les <item> au niveau du RDF, pas dans le <channel>.
    const nodes = kids(channel, 'item').concat(
      channel === root ? [] : kids(root, 'item')
    );

    const items = nodes.map((node) => {
      const rawSummary = text(node, 'description', 'encoded', 'summary');
      return normalize(
        {
          title: text(node, 'title'),
          link: text(node, 'link') || (kids(node, 'guid')[0]?.textContent || '').trim(),
          summary: plain(rawSummary),
          author: text(node, 'author', 'creator'),
          published_ts: toTimestamp(text(node, 'pubDate', 'date', 'published')),
          // atom:updated ou dc:modified au niveau de l'ITEM. Surtout pas
          // <lastBuildDate>, qui décrit le canal entier.
          updated_ts: toTimestamp(text(node, 'updated', 'modified')),
          categories: kids(node, 'category').map((c) => (c.textContent || '').trim()),
          has_links: hasLinks(rawSummary),
          id: text(node, 'guid') || null
        },
        feedUrl
      );
    });

    return { title: text(channel, 'title'), items };
  }

  // --- Atom ---------------------------------------------------------------

  function atomLink(entry, feedUrl) {
    const links = kids(entry, 'link');
    const alt =
      links.find((l) => l.getAttribute('rel') === 'alternate') ||
      links.find((l) => !l.getAttribute('rel')) ||
      links[0];
    return absolute(alt ? alt.getAttribute('href') : '', feedUrl);
  }

  function parseAtom(doc, feedUrl) {
    const root = doc.documentElement;
    const items = kids(root, 'entry').map((entry) => {
      const authorNode = kids(entry, 'author')[0];
      const rawSummary = text(entry, 'summary', 'content');
      const published = toTimestamp(text(entry, 'published'));
      const updated = toTimestamp(text(entry, 'updated'));
      return normalize(
        {
          title: text(entry, 'title'),
          link: atomLink(entry, feedUrl),
          summary: plain(rawSummary),
          author: authorNode ? text(authorNode, 'name') : '',
          published_ts: published || updated,
          updated_ts: published ? updated : null,
          // En Atom, la catégorie vit dans l'attribut `term`, pas dans le texte.
          categories: kids(entry, 'category')
            .map((c) => c.getAttribute('term') || (c.textContent || '').trim()),
          has_links: hasLinks(rawSummary),
          id: text(entry, 'id') || null
        },
        feedUrl
      );
    });

    return { title: text(root, 'title'), items };
  }

  // --- JSON Feed ----------------------------------------------------------

  function parseJsonFeed(payload, feedUrl) {
    const list = Array.isArray(payload.items) ? payload.items : [];
    const items = list.map((entry) =>
      normalize(
        {
          title: entry.title || '',
          link: entry.url || entry.external_url || '',
          summary: plain(entry.summary || entry.content_text || entry.content_html || ''),
          author:
            (entry.author && entry.author.name) ||
            (Array.isArray(entry.authors) && entry.authors[0] && entry.authors[0].name) ||
            '',
          published_ts: toTimestamp(entry.date_published || entry.date_modified),
          updated_ts: entry.date_published ? toTimestamp(entry.date_modified) : null,
          categories: Array.isArray(entry.tags) ? entry.tags : [],
          has_links: hasLinks(entry.content_html),
          id: entry.id ? String(entry.id) : null
        },
        feedUrl
      )
    );

    return { title: payload.title || '', items };
  }

  // --- Point d'entrée -----------------------------------------------------

  /**
   * @returns {{title: string, items: Array}}
   * @throws  si le contenu n'est ni du XML de flux, ni du JSON Feed
   */
  function parseFeed(body, contentType, feedUrl) {
    const looksJson =
      /json/i.test(contentType || '') || /^\s*\{/.test(body.slice(0, 200));

    if (looksJson) {
      return parseJsonFeed(JSON.parse(body), feedUrl);
    }

    const doc = TP_XML.parse(body); // lève une erreur explicite si mal formé

    const rootName = (doc.documentElement.localName || '').toLowerCase();
    if (rootName === 'feed') return parseAtom(doc, feedUrl);
    if (rootName === 'rss' || rootName === 'rdf') return parseRss(doc, feedUrl);

    throw new Error(`Format de flux non reconnu : <${rootName}>`);
  }

  return { parseFeed, plain, toTimestamp, fingerprint };
})();

globalThis.TP_PARSER = TP_PARSER;
