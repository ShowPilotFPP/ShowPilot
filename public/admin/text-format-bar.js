// ============================================================
// ShowPilot admin — formatting buttons for block text (v0.33.278-master.1+)
// ============================================================
// A small row of buttons (bold, italic, underline, strike, color, link)
// that sits above whichever block text box you're typing in, and moves
// when you click into another one (one row, not one per box). Select some words and click: they're wrapped in
// the matching code ([b]…[/b] and so on), which the viewer page shows as
// formatted text. With nothing selected, the code is put in at the cursor.
//
//   SPFormatBar.html()            — a marker; put right before an
//                                   <input>/<textarea> that may be formatted
//   SPFormatBar.wantsBar(key)     — false for links, images and the like
//
// After wrapping, an "input" event is fired on the box so whatever saves
// it (oninput handlers, the list editors) picks the change up.
// ============================================================
(function (root) {
  'use strict';

  const BTN = 'type="button" class="secondary sp-fmt-btn" tabindex="-1"';
  function barHtml() {
    return '<button ' + BTN + ' data-spfmt="b" title="Bold: [b]text[/b]"><b>B</b></button>' +
      '<button ' + BTN + ' data-spfmt="i" title="Italic: [i]text[/i]"><i>I</i></button>' +
      '<button ' + BTN + ' data-spfmt="u" title="Underline: [u]text[/u]"><u>U</u></button>' +
      '<button ' + BTN + ' data-spfmt="s" title="Strikethrough: [s]text[/s]"><s>S</s></button>' +
      '<label class="secondary sp-fmt-btn sp-fmt-color" title="Color: [color=#ff0000]text[/color]">A<input type="color" data-spfmt-color value="#e53935" tabindex="-1"></label>' +
      '<button ' + BTN + ' data-spfmt="url" title="Link: [url=https://…]text[/url]">🔗</button>';
  }
  function html() { return '<span class="sp-fmt-anchor" hidden></span>'; }

  // The one row of buttons, moved to the box being typed in.
  let bar = null, current = null, picking = false;
  function getBar() {
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'sp-fmt-bar';
      bar.setAttribute('role', 'toolbar');
      bar.setAttribute('aria-label', 'Text formatting');
      bar.innerHTML = barHtml();
    }
    return bar;
  }
  function isFormattable(el) {
    if (!el || !/^(INPUT|TEXTAREA)$/.test(el.tagName)) return false;
    if (el.tagName === 'INPUT' && el.type !== 'text') return false;
    let p = el.previousElementSibling;
    if (p && p.classList.contains('sp-fmt-bar')) p = p.previousElementSibling;
    return !!(p && p.classList.contains('sp-fmt-anchor'));
  }
  function showFor(box) {
    const b = getBar();
    current = box;
    if (b.nextElementSibling !== box) box.parentNode.insertBefore(b, box);
    b.hidden = false;
  }
  function hide() {
    if (bar) { bar.hidden = true; if (bar.parentNode) bar.parentNode.removeChild(bar); }
    current = null;
  }
  document.addEventListener('focusin', (e) => {
    const t = e.target;
    if (bar && bar.contains(t)) return;
    picking = false;
    if (isFormattable(t)) showFor(t);
    else if (current) hide();
  });
  // Leaving the box (and not for the buttons or the color picker) hides it.
  document.addEventListener('focusout', () => {
    setTimeout(() => {
      if (!current) return;
      const a = document.activeElement;
      // Still choosing a color: keep the buttons. A picker closed without a
      // choice doesn't count.
      if (picking && a && a.matches && a.matches('[data-spfmt-color]')) return;
      picking = false;
      if (a === current || (bar && bar.contains(a))) return;
      if (!document.contains(current) || !isFormattable(a)) hide();
    }, 120);
  });

  // Links, pictures, colors, dates and raw HTML don't get buttons.
  function wantsBar(key) {
    return !/(url|link|href|image|img|src|icon|email|phone|address|color|colour|font|class|id|html|css|from|until|date|time)$/i.test(String(key || ''));
  }

  function boxFor(el) {
    return (bar && bar.contains(el) && current && document.contains(current)) ? current : null;
  }

  function wrap(box, open, close) {
    const a = box.selectionStart == null ? box.value.length : box.selectionStart;
    const z = box.selectionEnd == null ? a : box.selectionEnd;
    const sel = box.value.slice(a, z);
    box.value = box.value.slice(0, a) + open + sel + close + box.value.slice(z);
    box.focus();
    // Keep the words selected (or put the cursor between empty codes).
    box.setSelectionRange(a + open.length, a + open.length + sel.length);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // Keep the text box's selection when a button is pressed.
  document.addEventListener('mousedown', (e) => {
    if (e.target.closest && e.target.closest('.sp-fmt-bar button')) e.preventDefault();
  });
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-spfmt]');
    if (!b) return;
    const box = boxFor(b);
    if (!box) return;
    e.preventDefault(); e.stopPropagation();
    const code = b.dataset.spfmt;
    if (code === 'url') {
      const sel = box.value.slice(box.selectionStart || 0, box.selectionEnd || 0);
      let href = /^https?:\/\//i.test(sel) ? sel : (root.prompt('Link address (starts with https://)', 'https://') || '');
      href = href.trim();
      if (!href || href === 'https://') return;
      if (!/^(https?:\/\/|mailto:)/i.test(href)) href = 'https://' + href.replace(/^\/+/, '');
      if (sel === href) wrap(box, '[url]', '[/url]');
      else wrap(box, '[url=' + href + ']', '[/url]');
      return;
    }
    wrap(box, '[' + code + ']', '[/' + code + ']');
  }, true);
  // Remember the selection before the color picker takes focus.
  let colorSel = null;
  document.addEventListener('pointerdown', (e) => {
    const c = e.target.closest && e.target.closest('.sp-fmt-color');
    if (!c) return;
    const box = boxFor(c);
    colorSel = box ? { box, a: box.selectionStart, z: box.selectionEnd } : null;
    picking = true;
  }, true);
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (!t.matches || !t.matches('[data-spfmt-color]')) return;
    picking = false;
    const box = (colorSel && colorSel.box) || boxFor(t);
    if (!box) return;
    if (colorSel && colorSel.box === box) box.setSelectionRange(colorSel.a, colorSel.z);
    colorSel = null;
    wrap(box, '[color=' + t.value + ']', '[/color]');
  }, true);
  // The color picker's own "input" events aren't text edits.
  document.addEventListener('input', (e) => {
    if (e.target.matches && e.target.matches('[data-spfmt-color]')) e.stopPropagation();
  }, true);

  // The codes as real HTML, for text that goes straight into a page's own
  // code (the Sections tab's text boxes on hand-built pages, v0.33.278-master.5).
  // Same rules as formatText() in lib/visual-designer.js; the input is
  // already-escaped text, so only these exact codes become tags.
  const TAGS = { b: 'strong', i: 'em', u: 'u', s: 's' };
  function safeHref(v) {
    const raw = String(v).replace(/&(lt|gt|quot|#39);/g, (m, e) => ({ lt: '<', gt: '>', quot: '"', '#39': "'" }[e])).replace(/&amp;/g, '&').trim();
    if (!/^(https?:\/\/|mailto:)[^\s"'<>]+$/i.test(raw)) return '';
    return raw.replace(/&/g, '&amp;');
  }
  function codesToHtml(escaped) {
    let out = String(escaped || '');
    if (out.indexOf('[') === -1) return out;
    const A = (h, inner) => '<a href="' + h + '" target="_blank" rel="noopener">' + inner + '</a>';
    for (let pass = 0; pass < 8; pass++) {
      const before = out;
      out = out.replace(/\[(b|i|u|s)\]([\s\S]*?)\[\/\1\]/gi, (m, t, inner) => { const g = TAGS[t.toLowerCase()]; return '<' + g + '>' + inner + '</' + g + '>'; });
      out = out.replace(/\[color=(#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20})\]([\s\S]*?)\[\/color\]/gi, (m, c, inner) => '<span style="color:' + c + '">' + inner + '</span>');
      out = out.replace(/\[url=([^\]\s]{1,500})\]([\s\S]*?)\[\/url\]/gi, (m, href, inner) => { const h = safeHref(href); return h ? A(h, inner) : inner; });
      out = out.replace(/\[url\]([^\[\s]{1,500})\[\/url\]/gi, (m, href) => { const h = safeHref(href); return h ? A(h, href) : href; });
      if (out === before) break;
    }
    return out;
  }

  root.SPFormatBar = { html, wantsBar, codesToHtml };
})(window);
