/**
 * xml.js — Parseur XML minimal, tolérant, en JavaScript pur.
 *
 * POURQUOI CE FICHIER EXISTE
 * --------------------------
 * La version précédente s'appuyait sur DOMParser, disponible uniquement parce
 * que le background Firefox MV3 est une event page (un vrai document caché).
 * Un service worker Chrome MV3 n'a pas de DOM : le portage était bloqué.
 *
 * Ce parseur produit un arbre minimal exposant exactement ce dont parser.js a
 * besoin — `children`, `localName`, `textContent`, `getAttribute` — donc la
 * logique de lecture des flux reste inchangée, et le code tourne désormais
 * partout : event page, service worker, worker, Node.
 *
 * Portée volontairement limitée aux flux de syndication : éléments, attributs,
 * texte, CDATA, commentaires, instructions de traitement, DOCTYPE. Pas de
 * résolution d'entités personnalisées, pas de validation de namespaces.
 */

const TP_XML = (() => {
  /** Entités nommées courantes dans les flux francophones et anglophones. */
  const NAMED = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
    nbsp: ' ', laquo: '«', raquo: '»', hellip: '…', mdash: '—', ndash: '–',
    rsquo: '\u2019', lsquo: '\u2018', ldquo: '\u201C', rdquo: '\u201D',
    eacute: 'é', egrave: 'è', ecirc: 'ê', agrave: 'à', acirc: 'â',
    ccedil: 'ç', ugrave: 'ù', ucirc: 'û', icirc: 'î', iuml: 'ï', ouml: 'ö',
    euro: '€', deg: '°', copy: '©', reg: '®', trade: '™', middot: '·'
  };

  /**
   * Décodage en UN SEUL passage.
   *
   * L'ordre de décodage est le piège classique : traiter `&amp;` avant les
   * entités numériques transforme « &amp;#233; » en « é » fantôme. Un passage
   * unique règle le problème par construction — le texte produit par une
   * substitution n'est jamais réexaminé.
   */
  function decodeEntities(str) {
    const text = String(str == null ? '' : str);
    if (text.indexOf('&') === -1) return text;

    return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, body) => {
      if (body[0] === '#') {
        const hex = body[1] === 'x' || body[1] === 'X';
        const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
        if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      const named = NAMED[body.toLowerCase()];
      return named === undefined ? match : named;
    });
  }

  function makeNode(rawName) {
    const colon = rawName.indexOf(':');
    const node = {
      nodeName: rawName,
      localName: colon === -1 ? rawName : rawName.slice(colon + 1),
      prefix: colon === -1 ? '' : rawName.slice(0, colon),
      attrs: Object.create(null),
      children: [],
      /** Contenu ordonné : chaînes de texte et noeuds enfants mêlés. */
      content: [],

      /** Insensible au préfixe de namespace : `href` trouve aussi `xlink:href`. */
      getAttribute(name) {
        if (name in this.attrs) return this.attrs[name];
        const wanted = name.toLowerCase();
        for (const key of Object.keys(this.attrs)) {
          const low = key.toLowerCase();
          if (low === wanted || low.endsWith(`:${wanted}`)) return this.attrs[key];
        }
        return null;
      }
    };

    Object.defineProperty(node, 'textContent', {
      get() {
        return node.content
          .map((part) => (typeof part === 'string' ? part : part.textContent))
          .join('');
      }
    });

    return node;
  }

  /** Fin de balise, en ignorant les `>` situés dans une valeur d'attribut. */
  function findTagEnd(xml, from) {
    let quote = null;
    for (let i = from; i < xml.length; i++) {
      const c = xml[i];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '>') {
        return i;
      }
    }
    return -1;
  }

  /** Saute `<!DOCTYPE …>` y compris un sous-ensemble interne `[ … ]`. */
  function skipDeclaration(xml, from) {
    let depth = 0;
    for (let i = from; i < xml.length; i++) {
      const c = xml[i];
      if (c === '[') depth++;
      else if (c === ']') depth--;
      else if (c === '>' && depth <= 0) return i + 1;
    }
    return xml.length;
  }

  const ATTR_RE = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

  function parseTag(body) {
    const name = /^([^\s/>]+)/.exec(body);
    const node = makeNode(name ? name[1] : '');
    ATTR_RE.lastIndex = 0;
    let attr;
    while ((attr = ATTR_RE.exec(body)) !== null) {
      node.attrs[attr[1]] = decodeEntities(attr[3] ?? attr[4] ?? attr[5] ?? '');
    }
    return node;
  }

  function addText(parent, raw, decode) {
    if (!raw) return;
    parent.content.push(decode ? decodeEntities(raw) : raw);
  }

  /** Referme jusqu'à la balise nommée. Une fermeture orpheline est ignorée. */
  function closeTag(stack, name) {
    for (let i = stack.length - 1; i > 0; i--) {
      if (stack[i].nodeName === name || stack[i].localName === name) {
        stack.length = i;
        return true;
      }
    }
    return false;
  }

  /**
   * @returns {{documentElement: object, children: Array}}
   * @throws  Error si le document est tronqué ou sans élément racine
   */
  function parse(xml) {
    const source = String(xml == null ? '' : xml);
    const doc = makeNode('#document');
    const stack = [doc];
    let i = 0;

    while (i < source.length) {
      const lt = source.indexOf('<', i);
      if (lt === -1) {
        addText(stack[stack.length - 1], source.slice(i), true);
        break;
      }
      if (lt > i) addText(stack[stack.length - 1], source.slice(i, lt), true);

      if (source.startsWith('<!--', lt)) {
        const end = source.indexOf('-->', lt + 4);
        i = end === -1 ? source.length : end + 3;
        continue;
      }

      if (source.startsWith('<![CDATA[', lt)) {
        const end = source.indexOf(']]>', lt + 9);
        // CDATA : contenu littéral, aucune entité à décoder.
        addText(stack[stack.length - 1], source.slice(lt + 9, end === -1 ? source.length : end), false);
        i = end === -1 ? source.length : end + 3;
        continue;
      }

      if (source.startsWith('<?', lt)) {
        const end = source.indexOf('?>', lt + 2);
        i = end === -1 ? source.length : end + 2;
        continue;
      }

      if (source.startsWith('<!', lt)) {
        i = skipDeclaration(source, lt + 2);
        continue;
      }

      if (source.startsWith('</', lt)) {
        const gt = source.indexOf('>', lt);
        if (gt === -1) throw new Error('XML illisible : balise fermante tronquée');
        closeTag(stack, source.slice(lt + 2, gt).trim());
        i = gt + 1;
        continue;
      }

      const gt = findTagEnd(source, lt + 1);
      if (gt === -1) throw new Error('XML illisible : balise ouvrante tronquée');

      const inner = source.slice(lt + 1, gt);
      const selfClosing = inner.endsWith('/');
      const node = parseTag(selfClosing ? inner.slice(0, -1) : inner);
      if (!node.nodeName) throw new Error('XML illisible : balise sans nom');

      const parent = stack[stack.length - 1];
      parent.children.push(node);
      parent.content.push(node);
      if (!selfClosing) stack.push(node);
      i = gt + 1;
    }

    if (stack.length !== 1) {
      throw new Error(`XML illisible : <${stack[stack.length - 1].nodeName}> jamais refermée`);
    }

    doc.documentElement = doc.children[0] || null;
    if (!doc.documentElement) throw new Error('XML illisible : aucun élément racine');
    return doc;
  }

  return { parse, decodeEntities };
})();

globalThis.TP_XML = TP_XML;
