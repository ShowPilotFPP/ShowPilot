// ShowPilot admin — Sections editor for hand-built templates (beta, v0.33.258-beta.1).
//
// Splits a code template into the page's top-level sections so they can be
// moved, hidden, duplicated, deleted, have their text edited, or have a
// block from the block library added between them. It works on the
// template's own source text (never re-serialized through the browser's
// DOM, which would rewrite things like <div {jukebox-dynamic-container}>),
// so a split followed by build() gives back the exact same string. The
// editor refuses a template when that round trip isn't exact.
//
// Model:  { prefix, sections: [{ lead, src, hidden, holder, fixed }], suffix }
//   prefix/suffix — everything kept as-is (head, styles, wrapper tags, ...)
//   lead   — whitespace/comments/text just before the section
//   src    — the section's own element(s)
//   hidden — true when stored as <template data-sp-hidden-section>…</template>
//            (inert: not shown, kept with the page so it can be shown again)
//   fixed  — scripts, styles, status toasts, empty decoration: kept in place,
//            not listed for editing
//
// Pure functions, no DOM: loaded in the admin as window.SPSections and in
// Node tests via require().
(function (root) {
  'use strict';

  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  const RAW = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'noscript']);
  const TOAST_IDS = new Set(['requestSuccessful', 'voteSuccessful', 'requestFailed', 'requestPlaying', 'queueFull', 'alreadyVoted',
    'invalidLocation', 'invalidLocationCode', 'songPlaying', 'songNextUp', 'alreadyRequested', 'messageSent', 'messageFailed', 'messageTooSoon',
    'dailyVoteLimitReached', 'sequenceUnavailable', 'requestLimitReached', 'queueLimitReached', 'sequenceAlreadyRequested', 'sequenceRequested',
    'sequenceVoted', 'voteLimitReached', 'unknownError']);
  const HIDDEN_OPEN = '<template data-sp-hidden-section>';
  const HIDDEN_CLOSE = '</template>';

  // ---------------------------------------------------------------- scanning
  // End index (exclusive) of the tag starting at i ('<' at i), honouring quotes.
  function tagEnd(s, i) {
    let q = null;
    for (let k = i + 1; k < s.length; k++) {
      const c = s[k];
      if (q) { if (c === q) q = null; continue; }
      if (c === '"' || c === "'") q = c;
      else if (c === '>') return k + 1;
    }
    return s.length;
  }
  function tagName(tag) {
    const m = /^<\/?\s*([a-zA-Z][a-zA-Z0-9-]*)/.exec(tag);
    return m ? m[1].toLowerCase() : '';
  }
  // End of the raw-text element (script/style/...) whose open tag ends at j.
  function rawEnd(s, j, name) {
    const re = new RegExp('</' + name + '\\s*>', 'ig');
    re.lastIndex = j;
    const m = re.exec(s);
    return m ? m.index + m[0].length : s.length;
  }
  // End of the element whose open tag starts at i. null when no matching
  // close tag is found (unclosed element): the caller treats the rest as one.
  function elementEnd(s, i, limit) {
    const open = s.slice(i, tagEnd(s, i));
    const name = tagName(open);
    let j = i + open.length;
    if (!name || VOID.has(name) || /\/\s*>$/.test(open)) return j;
    if (RAW.has(name)) return rawEnd(s, j, name);
    let depth = 0;
    while (j < limit) {
      const lt = s.indexOf('<', j);
      if (lt === -1 || lt >= limit) return null;
      if (s.startsWith('<!--', lt)) { const e = s.indexOf('-->', lt + 4); j = e === -1 ? limit : e + 3; continue; }
      const t = s.slice(lt, tagEnd(s, lt));
      const n = tagName(t);
      if (!n) { j = lt + 1; continue; }
      if (t[1] === '/') {
        if (n === name) { if (depth === 0) return lt + t.length; depth--; }
        j = lt + t.length;
        continue;
      }
      if (RAW.has(n)) { j = rawEnd(s, lt + t.length, n); continue; }
      if (n === name && !VOID.has(n) && !/\/\s*>$/.test(t)) depth++;
      j = lt + t.length;
    }
    return null;
  }

  // Top-level nodes in s[from, to): [{ start, end, kind: 'el'|'comment'|'text'|'other', name, open }]
  function nodes(s, from, to) {
    const out = [];
    let i = from;
    while (i < to) {
      if (s[i] !== '<') {
        const lt = s.indexOf('<', i);
        const e = lt === -1 || lt > to ? to : lt;
        out.push({ start: i, end: e, kind: 'text' });
        i = e;
        continue;
      }
      if (s.startsWith('<!--', i)) {
        const e = s.indexOf('-->', i + 4);
        const end = e === -1 || e + 3 > to ? to : e + 3;
        out.push({ start: i, end, kind: 'comment' });
        i = end;
        continue;
      }
      const te = Math.min(tagEnd(s, i), to);
      const open = s.slice(i, te);
      const name = tagName(open);
      if (!name || open[1] === '/' || open[1] === '!' || open[1] === '?') {
        out.push({ start: i, end: te, kind: 'other' });
        i = te;
        continue;
      }
      let end = elementEnd(s, i, to);
      if (end === null || end > to) end = to;
      out.push({ start: i, end, kind: 'el', name, open });
      i = end;
    }
    return out;
  }

  // ---------------------------------------------------------------- classify
  const PLACEHOLDER = /\{[A-Za-z_][A-Za-z0-9_-]*\}/;
  function visibleText(src) {
    return src.replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|textarea|title|noscript)\b[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function isFixed(node, src) {
    if (node.kind !== 'el') return true;
    if (['script', 'style', 'link', 'meta', 'noscript', 'template', 'base', 'title'].includes(node.name)) return node.name !== 'template' || !isHidden(src);
    const id = /\bid\s*=\s*["']?([^"'\s>]+)/i.exec(node.open);
    if (id && TOAST_IDS.has(id[1])) return true;
    // Pop-up status messages kept hidden until needed (<div id=… style="display:none">).
    if (id && /\bstyle\s*=\s*["'][^"']*display\s*:\s*none/i.test(node.open)) return true;
    // Empty decoration (backdrops, snow containers): no text, no placeholders, no media.
    if (!visibleText(src) && !PLACEHOLDER.test(src) && !/<(img|video|iframe|svg|picture|audio|object|input|button|select|form)\b/i.test(src)) return true;
    return false;
  }
  function isHidden(src) { return src.startsWith(HIDDEN_OPEN) && src.endsWith(HIDDEN_CLOSE); }

  // ---------------------------------------------------------------- split / build
  function regionOf(s) {
    // Content of <body>, or the whole text for fragment templates.
    const all = nodes(s, 0, s.length);
    const html = all.find((n) => n.kind === 'el' && n.name === 'html');
    let from = 0, to = s.length;
    if (html) {
      const inner = html.start + html.open.length;
      const close = s.lastIndexOf('</', html.end);
      const kids = nodes(s, inner, close > inner && tagName(s.slice(close, tagEnd(s, close))) === 'html' ? close : html.end);
      const body = kids.find((n) => n.kind === 'el' && n.name === 'body');
      if (body) {
        from = body.start + body.open.length;
        const bc = s.lastIndexOf('</', body.end);
        to = bc >= from && tagName(s.slice(bc, tagEnd(s, bc))) === 'body' ? bc : body.end;
        return { from, to };
      }
      const head = kids.find((n) => n.kind === 'el' && n.name === 'head');
      from = head ? head.end : inner;
      to = close > from ? close : html.end;
      return { from, to };
    }
    const body = all.find((n) => n.kind === 'el' && n.name === 'body');
    if (body) {
      from = body.start + body.open.length;
      const bc = s.lastIndexOf('</', body.end);
      to = bc >= from && tagName(s.slice(bc, tagEnd(s, bc))) === 'body' ? bc : body.end;
      return { from, to };
    }
    const head = all.find((n) => n.kind === 'el' && n.name === 'head');
    return { from: head ? head.end : 0, to: s.length };
  }

  function group(s, from, to) {
    const ns = nodes(s, from, to);
    const sections = [];
    let leadStart = from;
    for (const n of ns) {
      if (n.kind !== 'el') continue; // text/comments travel with the next element
      const src = s.slice(n.start, n.end);
      const hidden = n.name === 'template' && isHidden(src);
      sections.push({
        lead: s.slice(leadStart, n.start),
        src: hidden ? src.slice(HIDDEN_OPEN.length, src.length - HIDDEN_CLOSE.length) : src,
        hidden,
        fixed: !hidden && isFixed(n, src),
        _start: n.start, _end: n.end, _node: n,
      });
      leadStart = n.end;
    }
    return { sections, tail: s.slice(leadStart, to) };
  }

  // Wrapper elements worth looking inside when they hold the whole page.
  const WRAPPERS = new Set(['div', 'main', 'section', 'article', 'center', 'span']);

  function split(html) {
    const s = String(html || '');
    if (!s.trim()) return { error: 'The template is empty.' };
    if (/<!--\s*OF_MANAGED:(settings|blocks)\s*-->/.test(s)) return { error: 'This template was made with the Settings or Blocks tab. Edit it there.' };
    let { from, to } = regionOf(s);
    let g = group(s, from, to);
    // Look inside a single wrapper (e.g. <div class="wrap">…the whole page…</div>),
    // up to three levels, while it is the only editable part.
    // Look inside a wrapper that holds the whole page (e.g. <div class="app">
    // <div class="app-inner">…</div></div>), through up to five nested
    // wrappers, while it is the only part with text or show content. The
    // deepest level with at least two parts is used.
    const count = (lvl) => lvl.sections.filter((x) => !x.fixed && !x.hidden).length;
    let best = count(g) >= 2 ? { from, to, g } : null;
    for (let level = 0; level < 5; level++) {
      // The part holding the text / show content; image-only decoration
      // (a moon, a graveyard SVG) beside it doesn't count.
      const editable = g.sections.filter((x) => !x.fixed && !x.hidden && (visibleText(x.src) || PLACEHOLDER.test(x.src)));
      if (editable.length !== 1) break;
      const w = editable[0];
      if (!WRAPPERS.has(w._node.name)) break;
      const innerFrom = w._start + w._node.open.length;
      const closeAt = s.lastIndexOf('</', w._end);
      if (closeAt < innerFrom || tagName(s.slice(closeAt, tagEnd(s, closeAt))) !== w._node.name) break;
      const inner = group(s, innerFrom, closeAt);
      if (count(inner) < 1) break;
      // Everything outside the wrapper's inside becomes prefix/suffix.
      from = innerFrom; to = closeAt;
      g = inner;
      if (count(g) >= 2) best = { from, to, g };
    }
    if (count(g) < 2 && best) ({ from, to, g } = best);
    const model = {
      prefix: s.slice(0, from),
      sections: g.sections.map(({ lead, src, hidden, fixed }) => ({ lead, src, hidden, fixed })),
      suffix: g.tail + s.slice(to),
    };
    if (build(model) !== s) return { error: "This template's layout couldn't be split safely, so it can't be edited here. Use the Code tab." };
    if (model.sections.filter((x) => !x.fixed).length < 2) return { error: 'No separate sections were found in this template (it may be one single block of HTML). Use the Code tab.' };
    return model;
  }

  function build(model) {
    return model.prefix + model.sections.map((x) => x.lead + (x.hidden ? HIDDEN_OPEN + x.src + HIDDEN_CLOSE : x.src)).join('') + model.suffix;
  }

  // ---------------------------------------------------------------- labels
  function firstHeading(src) {
    const m = /<h([1-4])\b[^>]*>([\s\S]*?)<\/h\1\s*>/i.exec(src);
    if (!m) return '';
    return decode(visibleText(m[2])).slice(0, 48);
  }
  function label(src) {
    const added = /<!--\s*sp-added:\s*([^>]*?)\s*-->/.exec(src);
    if (added) return added[1];
    const has = (p) => src.indexOf(p) !== -1;
    // A fold-out panel (<details>) is named by its own heading (<summary>).
    if (tagName(src) === 'details') {
      const sm = /<summary\b[^>]*>([\s\S]*?)<\/summary\s*>/i.exec(src);
      const st = sm ? decode(visibleText(sm[1])) : '';
      if (st) return 'Fold-out: ' + (st.length > 40 ? st.slice(0, 40) + '…' : st);
    }
    if (has('{after-hours-message}')) return 'After-hours message';
    if (has('{MESSAGE_WALL}')) return 'Message wall';
    if (has('{MESSAGE_BOX}')) return 'Message box';
    if (has('{PLAYLISTS}')) {
      const v = has('{playlist-voting-dynamic-container}'), j = has('{jukebox-dynamic-container}') || has('{playlist-standard-dynamic-container}');
      return v && j ? 'Song lists (voting + jukebox)' : v ? 'Voting song list' : j ? 'Jukebox song list' : 'Song list';
    }
    if (has('{location-code-dynamic-container}') || has('{LOCATION_CODE}')) return 'Access code';
    if (has('{JUKEBOX_QUEUE}')) return 'Request queue';
    if (has('{NOW_PLAYING}') && has('{NEXT_PLAYLIST}')) return 'Now playing & up next';
    if (has('{NOW_PLAYING}')) return 'Now playing';
    if (has('{NEXT_PLAYLIST}')) return 'Up next';
    const h = firstHeading(src);
    const mode = has('{playlist-voting-dynamic-container}') ? 'Voting: ' : (has('{jukebox-dynamic-container}') || has('{playlist-standard-dynamic-container}')) ? 'Jukebox: ' : '';
    if (h) return mode + '“' + h + '”';
    const tag = tagName(src);
    const openTag = src.slice(0, tagEnd(src, 0));
    const t = decode(visibleText(src)) || '';
    if (!t && /<(a)\b/i.test(src) && /follow|social|facebook|instagram|mailto/i.test(src)) return 'Social links';
    if (!t && /<(img|picture|svg)\b/i.test(src)) {
      const alt = /\balt\s*=\s*["']([^"']+)["']/i.exec(src);
      const what = /separator|divider/i.test(src) ? 'Divider image' : /logo/i.test(src) ? 'Logo' : /header|banner/i.test(src) ? 'Header image' : /footer/i.test(src) ? 'Footer image' : 'Image';
      return what + (alt && what === 'Image' ? ' (' + alt[1].slice(0, 30) + ')' : '');
    }
    if (tag === 'footer') return 'Footer';
    if (tag === 'header') return 'Header';
    if (tag === 'nav') return 'Menu';
    const cls = /\bclass\s*=\s*["']([^"']+)["']/i.exec(openTag);
    const c = cls ? cls[1].split(/\s+/)[0] : '';
    if (t) return mode + (t.length > 40 ? t.slice(0, 40) + '…' : t);
    if (/footer/i.test(c)) return 'Footer';
    if (/header|hero|title|banner/i.test(c)) return 'Header';
    const id = /\bid\s*=\s*["']?([^"'\s>]+)/i.exec(openTag);
    const nm = (id ? id[1] : c).replace(/[-_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
    if (nm) return nm.charAt(0).toUpperCase() + nm.slice(1).toLowerCase();
    return 'Section (' + (tag || 'html') + ')';
  }

  // ---------------------------------------------------------------- text runs
  const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘',
    rdquo: '”', ldquo: '“', hellip: '…', copy: '©', reg: '®', trade: '™', bull: '•', middot: '·', times: '×', deg: '°', hearts: '♥', star: '☆',
    eacute: 'é', egrave: 'è', ecirc: 'ê', aacute: 'á', agrave: 'à', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', ccedil: 'ç',
    auml: 'ä', ouml: 'ö', uuml: 'ü', szlig: 'ß', Eacute: 'É', Ntilde: 'Ñ', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü' };
  // null when the text holds an entity we don't know (then it is edited raw).
  function decode(raw) {
    let bad = false;
    const out = String(raw).replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e) => {
      if (e[0] === '#') {
        const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        try { return String.fromCodePoint(n); } catch (_) { bad = true; return m; }
      }
      const v = NAMED[e] !== undefined ? NAMED[e] : NAMED[e.toLowerCase()];
      if (v === undefined) { bad = true; return m; }
      return v;
    });
    return bad ? null : out;
  }
  function encode(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/ /g, '&nbsp;');
  }

  // Editable text in a section: [{ start, end, tag, text, raw }] (start/end
  // index into src, around the trimmed text). Text containing a {PLACEHOLDER}
  // is left out (it changes at show time).
  function textRuns(src) {
    const runs = [];
    const stack = [];
    let i = 0;
    while (i < src.length && runs.length < 60) {
      if (src[i] === '<') {
        if (src.startsWith('<!--', i)) { const e = src.indexOf('-->', i + 4); i = e === -1 ? src.length : e + 3; continue; }
        const te = tagEnd(src, i);
        const t = src.slice(i, te);
        const n = tagName(t);
        if (n && t[1] !== '/' && RAW.has(n)) { i = rawEnd(src, te, n); continue; }
        if (n && t[1] !== '/' && !VOID.has(n) && !/\/\s*>$/.test(t)) stack.push(n);
        else if (n && t[1] === '/') { const k = stack.lastIndexOf(n); if (k !== -1) stack.length = k; }
        i = te;
        continue;
      }
      const lt = src.indexOf('<', i);
      const end = lt === -1 ? src.length : lt;
      const raw = src.slice(i, end);
      const trimmed = raw.trim();
      if (trimmed && !PLACEHOLDER.test(trimmed)) {
        const s0 = i + raw.indexOf(trimmed);
        const d = decode(trimmed);
        runs.push({ start: s0, end: s0 + trimmed.length, tag: stack[stack.length - 1] || '', text: d === null ? trimmed : d, raw: trimmed, isRaw: d === null });
      }
      i = end;
    }
    return runs;
  }
  // Replace run k's text. Unchanged text keeps its original source.
  function setText(src, run, newText) {
    if (newText === run.text) return src;
    const v = run.isRaw ? newText : encode(newText);
    return src.slice(0, run.start) + v + src.slice(run.end);
  }

  const api = { split, build, label, textRuns, setText, decode, encode, visibleText, HIDDEN_OPEN, HIDDEN_CLOSE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SPSections = api;
})(typeof window !== 'undefined' ? window : globalThis);
