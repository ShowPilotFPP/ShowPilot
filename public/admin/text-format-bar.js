// ============================================================
// ShowPilot admin — formatting buttons for block text (v0.33.278-master.1+)
// ============================================================
// A small row of buttons (bold, italic, underline, strike, color, link)
// above a block's text box. Select some words and click: they're wrapped in
// the matching code ([b]…[/b] and so on), which the viewer page shows as
// formatted text. With nothing selected, the code is put in at the cursor.
//
//   SPFormatBar.html()            — the buttons; put right before the
//                                   <input>/<textarea> inside one wrapper
//   SPFormatBar.wantsBar(key)     — false for links, images and the like
//
// After wrapping, an "input" event is fired on the box so whatever saves
// it (oninput handlers, the list editors) picks the change up.
// ============================================================
(function (root) {
  'use strict';

  const BTN = 'type="button" class="secondary sp-fmt-btn" tabindex="-1"';
  function html() {
    return '<div class="sp-fmt-bar" role="toolbar" aria-label="Text formatting">' +
      '<button ' + BTN + ' data-spfmt="b" title="Bold: [b]text[/b]"><b>B</b></button>' +
      '<button ' + BTN + ' data-spfmt="i" title="Italic: [i]text[/i]"><i>I</i></button>' +
      '<button ' + BTN + ' data-spfmt="u" title="Underline: [u]text[/u]"><u>U</u></button>' +
      '<button ' + BTN + ' data-spfmt="s" title="Strikethrough: [s]text[/s]"><s>S</s></button>' +
      '<label class="secondary sp-fmt-btn sp-fmt-color" title="Color: [color=#ff0000]text[/color]">A<input type="color" data-spfmt-color value="#e53935" tabindex="-1"></label>' +
      '<button ' + BTN + ' data-spfmt="url" title="Link: [url=https://…]text[/url]">🔗</button>' +
      '</div>';
  }

  // Links, pictures, colors and such don't get buttons.
  function wantsBar(key) {
    return !/(url|link|href|image|img|src|icon|email|phone|address|color|colour|font|class|id)$/i.test(String(key || ''));
  }

  function boxFor(el) {
    const bar = el.closest('.sp-fmt-bar');
    if (!bar) return null;
    let n = bar.nextElementSibling;
    while (n && !/^(INPUT|TEXTAREA)$/.test(n.tagName)) n = n.nextElementSibling;
    return n;
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
  }, true);
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (!t.matches || !t.matches('[data-spfmt-color]')) return;
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

  root.SPFormatBar = { html, wantsBar };
})(window);
