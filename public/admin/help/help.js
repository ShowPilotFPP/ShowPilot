// ShowPilot help (F1 / ? button) — v0.33.278-master.9+
//
// One small, self-contained help system shared by ShowPilot, ShowPilot Lite
// and the hosted dashboard:
//   - F1 (or the ? button) opens a panel with help for the page you're on;
//     F1 again or Esc closes it.
//   - The panel searches all the docs (titles, headings and text) as you type.
//   - /admin/help/ shows the same docs as a full page with a contents list.
// The docs are Markdown files next to this script, listed in manifest.json,
// so help works with no internet and always matches the installed version.
// Search runs in the browser: the first search loads every doc once.
//
// Use:  SPHelp.init({ base, context, hidden })
//   base     folder with manifest.json and the .md files ('/admin/help/')
//   context  () => 'settings/audio' — the page the user is on; matched
//            against each doc's "context" list (first match wins, then the
//            part before the slash)
//   hidden   (doc) => true to leave a doc out (e.g. hosted-only pages)
// Markdown supported: # ## ### headings, paragraphs, - and 1. lists, **bold**,
// *italic*, `code`, fenced ``` blocks, > notes (> **Tip:** …), | tables |,
// links. A link to help:<doc> or help:<doc>#<heading> opens that doc.
(function () {
  'use strict';

  const state = {
    base: '/admin/help/',
    context: () => '',
    hidden: () => false,
    manifest: null,
    texts: new Map(),     // doc id -> markdown
    index: null,          // [{doc, title, heading, anchor, text}]
    panel: null,
    current: null,        // { id, anchor }
    open: false,
  };

  // ---------------------------------------------------------------- utils
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const slug = (s) => String(s).toLowerCase().replace(/<[^>]+>/g, '').replace(/[`*_]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };

  async function getJson(url) {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) throw new Error(r.status);
    return r.json();
  }
  async function manifest() {
    if (!state.manifest) state.manifest = await getJson(state.base + 'manifest.json');
    return state.manifest;
  }
  const visibleDocs = (m) => Object.entries(m.docs).filter(([id, d]) => !state.hidden(Object.assign({ id }, d)));
  async function text(id) {
    if (state.texts.has(id)) return state.texts.get(id);
    const m = await manifest();
    const d = m.docs[id];
    if (!d) throw new Error('No such help page');
    const r = await fetch(state.base + d.file, { cache: 'no-cache' });
    if (!r.ok) throw new Error(r.status);
    const t = await r.text();
    // A missing page can come back as the admin's HTML fallback; don't show or index it.
    if (/^\s*</.test(t) || /text\/html/i.test(r.headers.get('content-type') || '')) throw new Error('missing');
    state.texts.set(id, t);
    return t;
  }

  // ---------------------------------------------------------------- markdown
  function inline(s) {
    let out = esc(s);
    out = out.replace(/`([^`]+)`/g, (m, c) => '<code>' + c + '</code>');
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, href) => {
      if (/^help:/.test(href)) return '<a href="#" data-help="' + esc(href.slice(5)) + '">' + label + '</a>';
      if (/^(https?:|\/)/.test(href)) return '<a href="' + href + '" target="_blank" rel="noopener">' + label + '</a>';
      return label;
    });
    return out;
  }

  function render(md) {
    const lines = md.replace(/\r/g, '').split('\n');
    const html = [];
    const toc = [];
    let i = 0;
    let title = '';
    const para = [];
    const flush = () => { if (para.length) { html.push('<p>' + inline(para.join(' ')) + '</p>'); para.length = 0; } };
    while (i < lines.length) {
      const line = lines[i];
      let m;
      if (/^```/.test(line)) {
        flush();
        const code = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
        html.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>');
        i++; continue;
      }
      if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) {
        flush();
        const level = m[1].length;
        if (level === 1) { title = m[2]; i++; continue; }
        const a = slug(m[2]);
        if (level === 2) toc.push({ title: m[2], anchor: a });
        html.push('<h' + (level + 1) + ' id="sph-' + a + '" data-anchor="' + a + '">' + inline(m[2]) + '</h' + (level + 1) + '>');
        i++; continue;
      }
      if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
        flush();
        const ordered = /^\s*\d+\./.test(line);
        const items = [];
        while (i < lines.length && (ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/).test(lines[i])) {
          let item = lines[i].replace(ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/, '');
          i++;
          while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*]|\d+\.)\s+/.test(lines[i])) item += ' ' + lines[i++].trim();
          items.push('<li>' + inline(item) + '</li>');
        }
        html.push((ordered ? '<ol>' : '<ul>') + items.join('') + (ordered ? '</ol>' : '</ul>'));
        continue;
      }
      if (/^>\s?/.test(line)) {
        flush();
        const q = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, ''));
        const body = q.join(' ');
        const kind = /^\*\*(Warning|Careful|Important)/i.test(body) ? 'warn' : 'tip';
        html.push('<div class="sph-note sph-' + kind + '">' + inline(body) + '</div>');
        continue;
      }
      if (/^\|.*\|\s*$/.test(line)) {
        flush();
        const rows = [];
        while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
        const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        const head = cells(rows[0]);
        const body = rows.slice(/^\|[\s:|-]+\|$/.test(rows[1] || '') ? 2 : 1);
        html.push('<div class="sph-table"><table><thead><tr>' + head.map((c) => '<th>' + inline(c) + '</th>').join('') +
          '</tr></thead><tbody>' + body.map((r) => '<tr>' + cells(r).map((c) => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('') +
          '</tbody></table></div>');
        continue;
      }
      if (!line.trim()) { flush(); i++; continue; }
      para.push(line.trim());
      i++;
    }
    flush();
    return { title, html: html.join('\n'), toc };
  }

  // Plain text sections for search.
  function sections(id, docTitle, md) {
    const out = [];
    let cur = { doc: id, title: docTitle, heading: '', anchor: '', text: [] };
    for (const line of md.replace(/\r/g, '').split('\n')) {
      const m = /^(#{1,3})\s+(.*)$/.exec(line);
      if (m && m[1].length === 1) continue;
      if (m && m[1].length === 2) {
        out.push(cur);
        cur = { doc: id, title: docTitle, heading: m[2], anchor: slug(m[2]), text: [] };
        continue;
      }
      cur.text.push(line.replace(/^\s*(?:[-*]|\d+\.)\s+/, '').replace(/^\s*\|?\s*-{3,}.*$/, '').replace(/[#>*`|]/g, ' ').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'));
    }
    out.push(cur);
    return out.map((s) => Object.assign(s, { text: s.text.join(' ').replace(/\s+/g, ' ').replace(/ ([,.;:])/g, '$1').trim() })).filter((s) => s.heading || s.text);
  }

  async function buildIndex() {
    if (state.index) return state.index;
    const m = await manifest();
    const docs = visibleDocs(m);
    await Promise.all(docs.map(([id]) => text(id).catch(() => '')));
    state.index = docs.flatMap(([id, d]) => sections(id, d.title, state.texts.get(id) || ''));
    return state.index;
  }

  function search(index, q) {
    const words = q.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
    if (!words.length) return [];
    const scored = [];
    for (const s of index) {
      const t = s.title.toLowerCase(), h = s.heading.toLowerCase(), b = s.text.toLowerCase();
      let score = 0;
      let all = true;
      for (const w of words) {
        const inT = t.includes(w), inH = h.includes(w), inB = b.includes(w);
        if (!inT && !inH && !inB) { all = false; break; }
        score += (inH ? 6 : 0) + (inT ? 4 : 0) + (inB ? 1 + Math.min(3, b.split(w).length - 1) * 0.3 : 0);
      }
      if (!all) continue;
      if (h.includes(q.toLowerCase())) score += 8;
      scored.push({ s, score });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, 30).map((x) => x.s);
  }

  function snippet(textStr, q) {
    const words = q.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
    const lower = textStr.toLowerCase();
    let at = -1;
    for (const w of words) { at = lower.indexOf(w); if (at >= 0) break; }
    const start = Math.max(0, at - 50);
    let s = (start > 0 ? '…' : '') + textStr.slice(start, start + 170) + (textStr.length > start + 170 ? '…' : '');
    s = esc(s);
    for (const w of words) s = s.replace(new RegExp('(' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig'), '<mark>$1</mark>');
    return s;
  }

  // ---------------------------------------------------------------- views
  async function docForContext() {
    const m = await manifest();
    const ctx = String(state.context() || '');
    const docs = visibleDocs(m);
    const find = (c) => docs.find(([, d]) => (d.context || []).includes(c));
    const hit = find(ctx) || find(ctx.split('/')[0]);
    return hit ? hit[0] : (m.home || docs[0][0]);
  }

  function bindLinks(root, onDoc) {
    root.querySelectorAll('a[data-help]').forEach((a) => a.addEventListener('click', (e) => {
      e.preventDefault();
      const [id, anchor] = a.dataset.help.split('#');
      onDoc(id, anchor);
    }));
  }

  async function showDoc(view, id, anchor, { onDoc, scroller }) {
    let md;
    try { md = await text(id); } catch (e) {
      view.innerHTML = '<p class="sph-muted">This help page couldn’t be loaded.</p>';
      return null;
    }
    const m = await manifest();
    const r = render(md);
    const d = m.docs[id] || {};
    view.innerHTML =
      '<article class="sph-doc">' +
      (d.area ? '<div class="sph-crumb">' + esc(d.area) + '</div>' : '') +
      '<h1>' + inline(r.title || d.title || '') + '</h1>' +
      (r.toc.length > 2 ? '<nav class="sph-toc">' + r.toc.map((t) => '<a href="#" data-jump="' + t.anchor + '">' + inline(t.title) + '</a>').join('') + '</nav>' : '') +
      r.html + '</article>';
    bindLinks(view, onDoc);
    view.querySelectorAll('[data-jump]').forEach((a) => a.addEventListener('click', (e) => {
      e.preventDefault();
      const h = view.querySelector('#sph-' + a.dataset.jump);
      if (h) h.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }));
    const target = anchor && view.querySelector('#sph-' + anchor);
    if (target) {
      target.classList.add('sph-flash');
      requestAnimationFrame(() => target.scrollIntoView({ block: 'start' }));
    } else if (scroller) scroller.scrollTop = 0;
    return r;
  }

  async function showContents(view, onDoc) {
    const m = await manifest();
    const shown = new Set(visibleDocs(m).map(([id]) => id));
    view.innerHTML = '<article class="sph-doc"><h1>All help</h1>' + m.sections.map((sec) => {
      const items = sec.docs.filter((id) => shown.has(id));
      if (!items.length) return '';
      return '<h3>' + esc(sec.title) + '</h3><ul class="sph-list">' +
        items.map((id) => '<li><a href="#" data-help="' + id + '">' + esc(m.docs[id].title) + '</a>' +
          (m.docs[id].summary ? '<span>' + esc(m.docs[id].summary) + '</span>' : '') + '</li>').join('') + '</ul>';
    }).join('') + '</article>';
    bindLinks(view, onDoc);
  }

  function renderResults(list, results, q, onDoc) {
    if (!results.length) {
      list.innerHTML = '<p class="sph-muted sph-pad">No matches for “' + esc(q) + '”. Try fewer or different words.</p>';
      return;
    }
    list.innerHTML = results.map((s, n) =>
      '<a href="#" class="sph-result' + (n === 0 ? ' sph-active' : '') + '" data-help="' + s.doc + (s.anchor ? '#' + s.anchor : '') + '">' +
      '<span class="sph-result-title">' + esc(s.title) + (s.heading ? ' <span class="sph-sep">›</span> ' + inline(s.heading) : '') + '</span>' +
      '<span class="sph-result-text">' + snippet(s.text, q) + '</span></a>').join('');
    bindLinks(list, onDoc);
  }

  // ---------------------------------------------------------------- panel
  const ICON_BOOK = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5v14z"/><path d="M6.5 17A2.5 2.5 0 0 0 4 19.5 2.5 2.5 0 0 0 6.5 22H20v-5"/></svg>';
  const ICON_SEARCH = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';

  function buildPanel() {
    const p = el(
      '<aside class="sph-panel" role="dialog" aria-label="Help" aria-hidden="true">' +
        '<header class="sph-head">' +
          '<div class="sph-titlebar">' +
            '<span class="sph-brand">' + ICON_BOOK + '<span>Help</span></span>' +
            '<span class="sph-head-actions">' +
              '<button type="button" class="sph-link" data-act="here">This page</button>' +
              '<button type="button" class="sph-link" data-act="all">All help</button>' +
              '<a class="sph-link" href="' + esc(state.base) + '" target="_blank" rel="noopener" title="Open the docs in a new tab">Full docs ↗</a>' +
              '<button type="button" class="sph-close" data-act="close" aria-label="Close help">×</button>' +
            '</span>' +
          '</div>' +
          '<label class="sph-search">' + ICON_SEARCH + '<input type="search" placeholder="Search all help" autocomplete="off" spellcheck="false"></label>' +
        '</header>' +
        '<div class="sph-body"><div class="sph-view"></div><div class="sph-results" hidden></div></div>' +
        '<footer class="sph-foot"><kbd>F1</kbd> help for this page · <kbd>Esc</kbd> close</footer>' +
      '</aside>');
    document.body.appendChild(p);
    const input = p.querySelector('input');
    const view = p.querySelector('.sph-view');
    const results = p.querySelector('.sph-results');
    const body = p.querySelector('.sph-body');
    const onDoc = (id, anchor) => {
      input.value = '';
      results.hidden = true; view.hidden = false;
      state.current = { id, anchor };
      showDoc(view, id, anchor, { onDoc, scroller: body });
    };
    p.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      if (b.dataset.act === 'close') close();
      if (b.dataset.act === 'here') docForContext().then((id) => onDoc(id));
      if (b.dataset.act === 'all') { input.value = ''; results.hidden = true; view.hidden = false; showContents(view, onDoc); body.scrollTop = 0; }
    });
    let timer = null;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (!q) { results.hidden = true; view.hidden = false; return; }
      timer = setTimeout(async () => {
        const idx = await buildIndex();
        renderResults(results, search(idx, q), q, onDoc);
        view.hidden = true; results.hidden = false; body.scrollTop = 0;
      }, 120);
    });
    input.addEventListener('keydown', (e) => {
      if (results.hidden) return;
      const items = [...results.querySelectorAll('.sph-result')];
      const at = items.findIndex((x) => x.classList.contains('sph-active'));
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const next = Math.max(0, Math.min(items.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)));
        items.forEach((x, n) => x.classList.toggle('sph-active', n === next));
        if (items[next]) items[next].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter' && items[at]) {
        e.preventDefault();
        items[at].click();
      }
    });
    state.panel = { el: p, input, view, results, body, onDoc };
    return state.panel;
  }

  async function openHelp(opts) {
    const p = state.panel || buildPanel();
    p.el.classList.add('sph-open');
    p.el.setAttribute('aria-hidden', 'false');
    document.documentElement.classList.add('sph-has-panel');
    state.open = true;
    const id = (opts && opts.doc) || await docForContext();
    p.onDoc(id, opts && opts.anchor);
  }

  function close() {
    if (!state.panel) return;
    state.panel.el.classList.remove('sph-open');
    state.panel.el.setAttribute('aria-hidden', 'true');
    document.documentElement.classList.remove('sph-has-panel');
    state.open = false;
  }

  function toggle() { if (state.open) close(); else openHelp(); }

  function addButton() {
    const b = el('<button type="button" class="sph-fab" title="Help (F1)" aria-label="Help">?</button>');
    b.addEventListener('click', toggle);
    document.body.appendChild(b);
  }

  function init(opts) {
    Object.assign(state, opts || {});
    if (!/\/$/.test(state.base)) state.base += '/';
    document.addEventListener('keydown', (e) => {
      if (e.key === 'F1') { e.preventDefault(); toggle(); return; }
      // Esc closes help first, without also closing a dialog underneath.
      if (e.key === 'Escape' && state.open) { e.preventDefault(); e.stopImmediatePropagation(); close(); }
    }, true);
    // Some browsers fire their own help on F1 via this event.
    window.addEventListener('help', (e) => { e.preventDefault(); });
    if (opts.button !== false) addButton();
  }

  // ---------------------------------------------------------------- full page
  async function page(opts) {
    Object.assign(state, opts || {});
    const root = document.querySelector(opts.root || '#sph-page');
    const m = await manifest();
    const shown = new Set(visibleDocs(m).map(([id]) => id));
    root.innerHTML =
      '<div class="sph-page">' +
        '<aside class="sph-side">' +
          '<a class="sph-side-brand" href="' + esc(state.base) + '">' + ICON_BOOK + '<span>' + esc(m.product || 'Help') + '</span></a>' +
          '<label class="sph-search">' + ICON_SEARCH + '<input type="search" placeholder="Search the docs" autocomplete="off" spellcheck="false" autofocus></label>' +
          '<nav class="sph-nav">' + m.sections.map((sec) => {
            const items = sec.docs.filter((id) => shown.has(id));
            if (!items.length) return '';
            return '<div class="sph-nav-group"><div class="sph-nav-title">' + esc(sec.title) + '</div>' +
              items.map((id) => '<a href="#' + id + '" data-id="' + id + '">' + esc(m.docs[id].title) + '</a>').join('') + '</div>';
          }).join('') + '</nav>' +
        '</aside>' +
        '<main class="sph-main"><div class="sph-view"></div><div class="sph-results" hidden></div></main>' +
      '</div>';
    const view = root.querySelector('.sph-view');
    const results = root.querySelector('.sph-results');
    const input = root.querySelector('input');
    const go = (id, anchor) => { location.hash = id + (anchor ? '/' + anchor : ''); };
    const fromHash = () => {
      const [id, anchor] = decodeURIComponent(location.hash.slice(1)).split('/');
      const target = id && m.docs[id] && shown.has(id) ? id : m.home;
      root.querySelectorAll('.sph-nav a').forEach((a) => a.classList.toggle('sph-current', a.dataset.id === target));
      input.value = ''; results.hidden = true; view.hidden = false;
      showDoc(view, target, anchor, { onDoc: go, scroller: document.scrollingElement }).then((r) => {
        document.title = (r && r.title ? r.title + ' — ' : '') + (m.product || 'Help');
      });
    };
    window.addEventListener('hashchange', fromHash);
    let timer = null;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (!q) { results.hidden = true; view.hidden = false; return; }
      timer = setTimeout(async () => {
        renderResults(results, search(await buildIndex(), q), q, go);
        view.hidden = true; results.hidden = false;
      }, 120);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !results.hidden) {
        const first = results.querySelector('.sph-result');
        if (first) { e.preventDefault(); first.click(); }
      }
    });
    fromHash();
  }

  window.SPHelp = { init, open: openHelp, close, toggle, page, _render: render, _search: search, _sections: sections };
})();
