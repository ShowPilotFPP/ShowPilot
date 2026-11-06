// ============================================================
// ShowPilot admin — list editors for block settings (v0.33.268+)
// ============================================================
// Some block settings are lists: the FAQ's questions and answers, the
// Social Links block's links. Instead of "one per line" text, these get a
// small editor with a row per item (add / move / remove).
//
//   SPBlockEditors.mount(el, propType, value, onChange)
//
// propType.type:
//   'rows'        — generic rows; propType.fields = [{ key, label, long }]
//   'socialLinks' — platform dropdown (or your own name), link, and logo
//                   picker; uses window.SPSocialIcons
// value is the current list (older text values are converted); onChange gets
// the new list after every edit. Typing doesn't redraw the editor, so the
// cursor stays put; adding, moving, removing and picking do.
// ============================================================
(function (root) {
  'use strict';

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // FAQ text from older pages: "Question | Answer" per line.
  function rowsFromValue(value, fields) {
    if (Array.isArray(value)) return value.map((r) => ({ ...r }));
    const first = fields[0].key, second = fields[1] ? fields[1].key : null;
    return String(value || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const i = l.indexOf('|');
      const row = {};
      row[first] = i === -1 ? l : l.slice(0, i).trim();
      if (second) row[second] = i === -1 ? '' : l.slice(i + 1).trim();
      return row;
    });
  }

  function icons() { return (root.SPSocialIcons && root.SPSocialIcons.PLATFORMS) || []; }
  function iconById(id) { return (root.SPSocialIcons && root.SPSocialIcons.get(id)) || null; }

  function iconSvg(p, size) {
    if (!p) return '<span class="spbe-noicon" style="width:' + size + 'px;height:' + size + 'px;">–</span>';
    return '<span class="spbe-ico" style="width:' + size + 'px;height:' + size + 'px;background:' + esc(p.color) + ';">' +
      '<svg viewBox="0 0 24 24" width="' + Math.round(size * 0.55) + '" height="' + Math.round(size * 0.55) + '" aria-hidden="true"><path fill="#fff" d="' + esc(p.path) + '"/></svg></span>';
  }

  // Older Social Links blocks kept facebook / instagram / youtube as their
  // own settings. Start the list from those so nothing is lost.
  function linksFromValue(value, legacy) {
    if (Array.isArray(value) && value.length) return value.map((r) => ({ ...r }));
    const out = [];
    for (const id of ['facebook', 'instagram', 'youtube']) {
      if (legacy && legacy[id]) out.push({ platform: id, name: '', url: legacy[id], icon: id });
    }
    return out;
  }

  function mount(el, propType, value, onChange, legacy) {
    const kind = propType && propType.type;
    const fields = (propType && propType.fields) || [];
    let list = kind === 'socialLinks' ? linksFromValue(value, legacy) : rowsFromValue(value, fields);
    let pickerAt = -1;   // which link's logo picker is open
    const emit = () => onChange(list.map((r) => ({ ...r })));

    function move(i, d) {
      const j = i + d;
      if (j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
      pickerAt = -1; draw(); emit();
    }
    function remove(i) { list.splice(i, 1); pickerAt = -1; draw(); emit(); }

    function controls(i) {
      return '<span class="spbe-ctl">' +
        '<button type="button" class="secondary" data-act="up" data-i="' + i + '" title="Move up"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
        '<button type="button" class="secondary" data-act="down" data-i="' + i + '" title="Move down"' + (i === list.length - 1 ? ' disabled' : '') + '>↓</button>' +
        '<button type="button" class="secondary spbe-del" data-act="del" data-i="' + i + '" title="Remove">✕</button></span>';
    }

    function drawRows() {
      let h = '';
      list.forEach((row, i) => {
        h += '<div class="spbe-row"><div class="spbe-row-head"><span class="spbe-num">' + (i + 1) + '</span>' + controls(i) + '</div>';
        for (const f of fields) {
          h += '<label class="spbe-lbl">' + esc(f.label) + '</label>';
          h += f.long
            ? '<textarea rows="2" data-i="' + i + '" data-f="' + esc(f.key) + '">' + esc(row[f.key] || '') + '</textarea>'
            : '<input type="text" data-i="' + i + '" data-f="' + esc(f.key) + '" value="' + esc(row[f.key] || '') + '">';
        }
        h += '</div>';
      });
      if (!list.length) h += '<p class="spbe-empty">Nothing here yet.</p>';
      h += '<button type="button" class="secondary spbe-add" data-act="add">＋ ' + esc(propType.addLabel || 'Add') + '</button>';
      return h;
    }

    function platformOptions(sel) {
      const all = icons();
      const brand = all.filter((p) => !p.generic), plain = all.filter((p) => p.generic);
      const opt = (p) => '<option value="' + esc(p.id) + '"' + (p.id === sel ? ' selected' : '') + '>' + esc(p.name) + '</option>';
      return '<optgroup label="Social, music and payments">' + brand.map(opt).join('') + '</optgroup>' +
        '<optgroup label="Other">' + plain.map(opt).join('') +
        '<option value="custom"' + (sel === 'custom' ? ' selected' : '') + '>Something else (type its name)</option></optgroup>';
    }

    function drawLinks() {
      let h = '';
      list.forEach((l, i) => {
        const plat = iconById(l.platform);
        const icon = l.icon === 'none' ? null : iconById(l.icon || l.platform);
        const isCustom = l.platform === 'custom' || !plat;
        h += '<div class="spbe-row spbe-link">' +
          '<div class="spbe-row-head">' +
            '<button type="button" class="spbe-iconbtn" data-act="pick" data-i="' + i + '" title="Choose the logo">' + iconSvg(icon, 34) + '<small>Logo ▾</small></button>' +
            '<select data-i="' + i + '" data-f="platform">' + platformOptions(isCustom ? 'custom' : l.platform) + '</select>' +
            controls(i) +
          '</div>' +
          (isCustom
            ? '<label class="spbe-lbl">Name</label><input type="text" data-i="' + i + '" data-f="name" placeholder="e.g. Our blog" value="' + esc(l.name || '') + '">'
            : '<label class="spbe-lbl">Name <small>(optional, shown with "Logos and names")</small></label><input type="text" data-i="' + i + '" data-f="name" placeholder="' + esc(plat.name) + '" value="' + esc(l.name || '') + '">') +
          '<label class="spbe-lbl">' + (l.platform === 'email' ? 'Email address' : l.platform === 'phone' ? 'Phone number' : 'Link') + '</label>' +
          '<input type="text" data-i="' + i + '" data-f="url" placeholder="' + esc(plat ? plat.placeholder : 'https://…') + '" value="' + esc(l.url || '') + '">';
        if (pickerAt === i) {
          h += '<div class="spbe-picker">' + icons().map((p) =>
            '<button type="button" data-act="seticon" data-i="' + i + '" data-icon="' + esc(p.id) + '" title="' + esc(p.name) + '"' + ((l.icon || l.platform) === p.id ? ' class="on"' : '') + '>' + iconSvg(p, 30) + '</button>'
          ).join('') +
            '<button type="button" data-act="seticon" data-i="' + i + '" data-icon="none" title="No logo (name only)"' + (l.icon === 'none' ? ' class="on"' : '') + '>' + iconSvg(null, 30) + '</button></div>';
        }
        h += '</div>';
      });
      if (!list.length) h += '<p class="spbe-empty">No links yet.</p>';
      h += '<button type="button" class="secondary spbe-add" data-act="add">＋ Add a link</button>';
      return h;
    }

    function draw() {
      el.innerHTML = '<div class="spbe">' + (kind === 'socialLinks' ? drawLinks() : drawRows()) + '</div>';
    }

    el.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b || !el.contains(b)) return;
      e.preventDefault(); e.stopPropagation();
      const i = Number(b.dataset.i);
      const act = b.dataset.act;
      if (act === 'up') move(i, -1);
      else if (act === 'down') move(i, 1);
      else if (act === 'del') remove(i);
      else if (act === 'add') {
        if (kind === 'socialLinks') {
          const used = new Set(list.map((l) => l.platform));
          const next = icons().find((p) => !p.generic && !used.has(p.id)) || icons()[0];
          list.push({ platform: next.id, name: '', url: '', icon: next.id });
          pickerAt = -1;
        } else {
          const row = {}; for (const f of fields) row[f.key] = '';
          list.push(row);
        }
        draw(); emit();
        const rows = el.querySelectorAll('.spbe-row');
        const inputs = rows.length ? rows[rows.length - 1].querySelectorAll('input[type=text], textarea') : [];
        const focus = kind === 'socialLinks' ? inputs[inputs.length - 1] : inputs[0];
        if (focus) focus.focus();
      } else if (act === 'pick') { pickerAt = pickerAt === i ? -1 : i; draw(); }
      else if (act === 'seticon') { list[i].icon = b.dataset.icon; pickerAt = -1; draw(); emit(); }
    });

    el.addEventListener('input', (e) => {
      const t = e.target;
      if (!t.dataset || t.dataset.f == null || !el.contains(t)) return;
      const i = Number(t.dataset.i), f = t.dataset.f;
      if (!list[i] || f === 'platform') return;
      list[i][f] = t.value;
      emit();
    });

    el.addEventListener('change', (e) => {
      const t = e.target;
      if (!t.dataset || t.dataset.f !== 'platform' || !el.contains(t)) return;
      const i = Number(t.dataset.i);
      const l = list[i];
      const prevIcon = l.icon || l.platform;
      // A logo that followed the old platform follows the new one too.
      if (prevIcon === l.platform || !l.icon) l.icon = t.value === 'custom' ? 'link' : t.value;
      l.platform = t.value;
      pickerAt = -1; draw(); emit();
    });

    draw();
  }

  root.SPBlockEditors = { mount };
})(window);
