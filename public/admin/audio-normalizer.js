// ============================================================
// ShowPilot admin — Tools → Audio Normalizer (window.SPNormalizer)
// ============================================================
// Renders into #spNormalizerRoot. Talks to /api/admin/tools/normalize.
// Identical file in ShowPilot and Lite (the server reports the edition).
// Everything user-supplied (file names) goes in via textContent.
// ============================================================
(function () {
  'use strict';

  const API = '/api/admin/tools/normalize';
  const STORE_KEY = 'sp_norm_batch';
  const TERMINAL = { done: 1, skipped: 1, error: 1 };
  const STATUS_LABEL = {
    uploading: 'Uploading…', queued: 'Waiting', fetching: 'Getting from FPP…',
    measuring: 'Measuring…', encoding: 'Fixing…', verifying: 'Checking…',
    done: 'Fixed', skipped: 'Already right', error: 'Failed',
  };

  let root = null;
  let status = null;
  // The connected show player's name, as the server reports it:
  // 'FPP' or 'ShowPilot Player'.
  const T = () => (status && status.target) || 'FPP';
  const isPlayer = () => !!(status && status.targetKind === 'player');
  let batch = null;
  let fppFiles = null;
  let fppError = null;
  let pollTimer = null;
  let busyMsg = '';
  let source = 'fpp';
  let filterText = '';
  const picked = new Set();
  let localFiles = [];
  // Setup choices live here so re-rendering (e.g. ticking a song) keeps them.
  const opts = { target: '-14', custom: '-14', peak: '-1.5', limiter: true };

  // ---------- helpers ----------
  function h(tag, attrs, kids) {
    const e = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'style') e.style.cssText = v;
        else if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
        else if (v === true) e.setAttribute(k, '');
        else e.setAttribute(k, v);
      }
    }
    (Array.isArray(kids) ? kids : (kids == null ? [] : [kids])).forEach(c => {
      if (c == null || c === false) return;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return e;
  }

  async function call(path, opts) {
    opts = opts || {};
    const headers = Object.assign({}, opts.headers || {});
    if (opts.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.json);
    }
    const res = await fetch(API + path, { credentials: 'include', method: opts.method || 'GET', headers, body: opts.body });
    let data = null;
    try { data = await res.json(); } catch (_) { /* no body */ }
    if (!res.ok) throw new Error((data && data.error) || ('Request failed (' + res.status + ')'));
    return data;
  }

  const fmt1 = (n) => (n == null ? '—' : (Math.round(n * 10) / 10).toFixed(1));
  const signed = (n) => (n > 0 ? '+' : '') + fmt1(n);
  function mb(bytes) { return bytes ? (bytes / 1048576).toFixed(1) + ' MB' : ''; }
  function download(url) {
    const a = h('a', { href: url, download: '' });
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // ---------- data ----------
  async function loadStatus() {
    try { status = await call('/status'); } catch (e) { status = { error: e.message }; }
  }

  async function loadFppFiles() {
    fppError = null;
    try {
      const r = await call('/fpp-files');
      fppFiles = r.files || [];
    } catch (e) {
      fppFiles = [];
      fppError = e.message;
    }
  }

  async function resumeBatch() {
    let id = null;
    try { id = sessionStorage.getItem(STORE_KEY); } catch (_) {}
    if (!id) return;
    try { batch = await call('/batches/' + encodeURIComponent(id)); } catch (_) { batch = null; forget(); }
  }

  function remember() { try { sessionStorage.setItem(STORE_KEY, batch.id); } catch (_) {} }
  function forget() { try { sessionStorage.removeItem(STORE_KEY); } catch (_) {} }

  function running() {
    return !!(batch && batch.items.some(i => !TERMINAL[i.status]));
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    if (!running() || !root || !root.isConnected) return;
    pollTimer = setTimeout(async () => {
      try { batch = await call('/batches/' + encodeURIComponent(batch.id)); }
      catch (e) { busyMsg = e.message; }
      render();
      schedulePoll();
    }, 1500);
  }

  // ---------- actions ----------
  function readSettings() {
    return {
      targetLufs: Number(opts.target === 'custom' ? opts.custom : opts.target),
      truePeak: Number(opts.peak),
      allowLimiter: !!opts.limiter,
    };
  }

  async function startBatch() {
    const settings = readSettings();
    const names = source === 'fpp' ? Array.from(picked) : [];
    const files = source === 'local' ? localFiles.slice() : [];
    if (!names.length && !files.length) { busyMsg = 'Pick at least one song.'; return render(); }
    busyMsg = 'Starting…';
    render();
    try {
      batch = await call('/batches', { method: 'POST', json: settings });
      remember();
      if (names.length) {
        const r = await call('/batches/' + batch.id + '/fpp', { method: 'POST', json: { names } });
        batch = r.batch;
        if (r.rejected && r.rejected.length) busyMsg = 'Skipped ' + r.rejected.length + ' file(s) with unsupported names.';
        else busyMsg = '';
        render();
        schedulePoll();
      }
      for (let n = 0; n < files.length; n++) {
        const f = files[n];
        busyMsg = 'Uploading ' + (n + 1) + ' of ' + files.length + ': ' + f.name;
        render();
        try {
          await call('/batches/' + batch.id + '/upload?name=' + encodeURIComponent(f.name), {
            method: 'POST', body: f, headers: { 'Content-Type': 'application/octet-stream' },
          });
        } catch (e) {
          busyMsg = f.name + ': ' + e.message;
        }
        batch = await call('/batches/' + batch.id);
        render();
        schedulePoll();
      }
      if (files.length) busyMsg = '';
      picked.clear();
      localFiles = [];
    } catch (e) {
      busyMsg = e.message;
    }
    render();
    schedulePoll();
  }

  async function sendItem(item, original) {
    try {
      await call('/batches/' + batch.id + '/items/' + item.id + '/send', { method: 'POST', json: { original: !!original } });
    } catch (e) {
      busyMsg = item.name + ': ' + e.message;
    }
    batch = await call('/batches/' + batch.id).catch(() => batch);
  }

  function confirmSend(count, original) {
    let text = original
      ? 'Put the ORIGINAL version back on ' + T() + ', replacing the file with the same name?'
      : 'Replace ' + count + ' song file(s) in ' + T() + '\'s music folder with the fixed versions (same names)?\n\nDownload the originals first if you want your own backup.';
    if (status && status.showActive) text += '\n\nYour show is playing right now. Replacing a song while it plays can cause a glitch — it\'s safest to do this with the show stopped.';
    return window.confirm(text);
  }

  async function sendAll() {
    const items = batch.items.filter(i => i.status === 'done' && i.canSend && i.sent !== 'normalized');
    if (!items.length) return;
    if (!confirmSend(items.length, false)) return;
    for (let n = 0; n < items.length; n++) {
      busyMsg = 'Sending ' + (n + 1) + ' of ' + items.length + ' to ' + T() + '…';
      render();
      await sendItem(items[n], false);
    }
    busyMsg = 'Done sending. ' + afterSendHint();
    render();
  }

  function afterSendHint() {
    if (status && status.edition === 'main') return phoneHint();
    return '';
  }

  function phoneHint() {
    return isPlayer()
      ? 'Phone listeners get the new versions after you press Sync on the Player\'s ShowPilot page.'
      : 'ShowPilot picks up the new versions for phone listeners the next time the plugin syncs.';
  }

  async function startOver() {
    if (running() && !window.confirm('Songs are still being processed. Stop and start over?')) return;
    if (batch) await call('/batches/' + batch.id, { method: 'DELETE' }).catch(() => {});
    batch = null;
    busyMsg = '';
    forget();
    render();
  }

  // ---------- rendering ----------
  function render() {
    if (!root) return;
    root.textContent = '';
    const card = h('div', { class: 'card' });
    root.appendChild(card);
    card.appendChild(h('h2', { text: 'Audio Normalizer' }));
    card.appendChild(h('p', { class: 'muted' }, [
      'Makes every song equally loud. It measures how loud each song actually sounds (LUFS, the standard used by ' +
      'Spotify, YouTube and broadcasters) and turns each one up or down by a fixed amount — the mix itself isn\'t changed. ' +
      'Peak-level normalizers and gain tags (MP3Gain / ReplayGain) don\'t do this, and ' + T() + ' ignores gain tags. ' +
      'The fixed files keep their names, length and tags, so you can put them straight back on ' + T() + '.',
    ]));

    if (!status) { card.appendChild(h('p', { class: 'muted', text: 'Loading…' })); return; }
    if (status.error) { card.appendChild(h('p', { class: 'err', text: status.error })); return; }
    if (status.demo) {
      card.appendChild(h('p', { class: 'muted', text: 'The audio normalizer is turned off in the demo.' }));
      return;
    }
    const t = status.tools || {};
    if (!t.ok) {
      const missing = [];
      if (!t.ffmpeg) missing.push('ffmpeg');
      if (!t.ffprobe) missing.push('ffprobe');
      if (t.ffmpeg && !t.loudnorm) missing.push('the loudnorm filter');
      if (t.ffmpeg && t.encoders && !t.encoders['.mp3']) missing.push('the MP3 encoder (libmp3lame)');
      card.appendChild(h('div', { style: 'padding:0.75rem;border:1px solid var(--status-danger, #c33);border-radius:8px;' }, [
        h('strong', { text: 'ffmpeg is needed for this tool. ' }),
        'Missing: ' + missing.join(', ') + '. ',
        t.hint || '',
      ]));
      return;
    }
    if (status.edition === 'lite') {
      card.appendChild(h('p', { class: 'muted', style: 'font-size:0.85rem;' },
        'This runs on your FPP, one song at a time at low priority. Expect up to a minute or so per song on a Pi — best done while the show isn\'t running.'));
    }

    if (batch) renderBatch(card);
    else renderSetup(card);

    if (busyMsg) card.appendChild(h('p', { class: 'muted', style: 'margin-top:0.75rem;', text: busyMsg }));
  }

  function renderSetup(card) {
    const grid = h('div', { class: 'grid-2', style: 'margin-top:0.5rem;' });
    const targetSel = h('select', { id: 'spnTarget', onchange: () => {
      opts.target = targetSel.value;
      root.querySelector('#spnTargetCustomWrap').style.display = targetSel.value === 'custom' ? '' : 'none';
    } }, [
      h('option', { value: '-14', text: '-14 LUFS — standard (recommended)' }),
      h('option', { value: '-16', text: '-16 LUFS — a little quieter, fewer songs need limiting' }),
      h('option', { value: '-11', text: '-11 LUFS — loud' }),
      h('option', { value: 'custom', text: 'Custom…' }),
    ]);
    targetSel.value = opts.target;
    grid.appendChild(h('div', null, [
      h('label', { for: 'spnTarget', text: 'Target loudness' }),
      targetSel,
      h('div', { id: 'spnTargetCustomWrap', style: (opts.target === 'custom' ? '' : 'display:none;') + 'margin-top:0.4rem;' }, [
        h('input', { id: 'spnTargetCustom', type: 'number', step: '0.5', min: '-30', max: '-5', value: opts.custom, style: 'width:7rem;', oninput: (e) => { opts.custom = e.target.value; } }),
        ' LUFS',
      ]),
      h('div', { class: 'muted', style: 'font-size:0.8rem;margin-top:0.3rem;' },
        'Most commercial songs are mastered around -8 to -11 LUFS, so the show will usually get a bit quieter overall — raise your ' + (isPlayer() ? 'amplifier' : 'FPP') + ' or transmitter level once afterwards.'),
    ]));
    grid.appendChild(h('div', null, [
      h('label', { for: 'spnPeak', text: 'Peak ceiling (dBTP)' }),
      h('input', { id: 'spnPeak', type: 'number', step: '0.5', min: '-9', max: '0', value: opts.peak, style: 'width:7rem;', oninput: (e) => { opts.peak = e.target.value; } }),
      h('div', { class: 'muted', style: 'font-size:0.8rem;margin-top:0.3rem;' },
        'No song will peak above this. -1.5 leaves room for MP3 encoding so nothing clips.'),
    ]));
    card.appendChild(grid);
    card.appendChild(h('label', { style: 'display:flex;gap:0.5rem;align-items:flex-start;margin-top:0.75rem;font-weight:normal;' }, [
      h('input', { id: 'spnLimiter', type: 'checkbox', checked: opts.limiter, style: 'margin-top:0.2rem;', onchange: (e) => { opts.limiter = e.target.checked; } }),
      h('span', null, [
        'Let quiet songs reach the target with a gentle limiter',
        h('div', { class: 'muted', style: 'font-size:0.8rem;' },
          'Some quiet songs have sharp peaks, so turning them up would pass the ceiling. On: a limiter tames just those peaks and the song matches the others. Off: the song is turned up only as far as its peaks allow and may end up a little quieter.'),
      ]),
    ]));

    // Source picker
    const tabs = h('div', { class: 'row', style: 'gap:0.5rem;margin-top:1rem;' }, [
      h('button', { class: source === 'fpp' ? '' : 'secondary', onclick: () => { source = 'fpp'; render(); }, text: 'Songs on ' + T() }),
      h('button', { class: source === 'local' ? '' : 'secondary', onclick: () => { source = 'local'; render(); }, text: 'Files from this computer' }),
    ]);
    card.appendChild(tabs);
    const box = h('div', { style: 'margin-top:0.75rem;' });
    card.appendChild(box);
    if (source === 'fpp') renderFppPicker(box);
    else renderLocalPicker(box);

    card.appendChild(h('div', { class: 'row', style: 'margin-top:1rem;gap:0.5rem;' }, [
      h('button', { id: 'spnGo', onclick: startBatch }),
    ]));
    updatePickUi();
  }

  // Ticking a song only updates these bits in place. (It used to rebuild
  // the whole card, which reset the list's scroll position and made the
  // list jump under the pointer.)
  function updatePickUi() {
    if (!root) return;
    const count = source === 'fpp' ? picked.size : localFiles.length;
    const go = root.querySelector('#spnGo');
    if (go) {
      go.disabled = count === 0;
      go.textContent = count ? ('Normalize ' + count + ' song' + (count === 1 ? '' : 's')) : 'Normalize';
    }
    const cnt = root.querySelector('#spnPickCount');
    if (cnt && fppFiles) cnt.textContent = picked.size + ' of ' + fppFiles.length + ' selected';
    const all = root.querySelector('#spnPickAll');
    if (all) {
      const shown = shownFiles();
      const on = shown.filter(f => picked.has(f.name)).length;
      all.checked = shown.length > 0 && on === shown.length;
      all.indeterminate = on > 0 && on < shown.length;
    }
  }

  function shownFiles() {
    const q = filterText.toLowerCase();
    return (fppFiles || []).filter(f => !q || f.name.toLowerCase().includes(q));
  }

  function renderFppPicker(box) {
    if (!status.fppHost) {
      box.appendChild(h('p', { class: 'muted', text: 'ShowPilot doesn\'t know your show player\'s address yet — once the ShowPilot plugin (FPP) or ShowPilot Player connects, your songs appear here. You can still use "Files from this computer".' }));
      return;
    }
    if (fppFiles === null) {
      box.appendChild(h('p', { class: 'muted', text: 'Loading ' + T() + '\'s music folder…' }));
      loadFppFiles().then(render);
      return;
    }
    if (fppError) {
      box.appendChild(h('p', { class: 'err', text: fppError }));
      box.appendChild(h('button', { class: 'secondary', onclick: () => { fppFiles = null; render(); }, text: 'Try again' }));
      return;
    }
    if (!fppFiles.length) {
      box.appendChild(h('p', { class: 'muted', text: 'No audio files found in ' + T() + '\'s music folder.' }));
      return;
    }
    const filter = h('input', { type: 'search', placeholder: 'Filter songs…', value: filterText, style: 'flex:1;min-width:10rem;', oninput: (e) => {
      filterText = e.target.value;
      fillRows();
    } });
    box.appendChild(h('div', { class: 'row', style: 'gap:0.5rem;align-items:center;flex-wrap:wrap;' }, [
      filter,
      h('button', { class: 'secondary', onclick: () => { picked.clear(); fillRows(); }, text: 'Clear' }),
      h('button', { class: 'secondary', onclick: () => { fppFiles = null; render(); }, text: 'Refresh' }),
    ]));
    const frame = h('div', { style: 'margin-top:0.5rem;border:1px solid var(--border, rgba(127,127,127,0.3));border-radius:8px;user-select:none;-webkit-user-select:none;' });
    const allBox = h('input', { id: 'spnPickAll', type: 'checkbox', onchange: (e) => {
      shownFiles().forEach(f => { if (e.target.checked) picked.add(f.name); else picked.delete(f.name); });
      fillRows();
    } });
    const allLabel = h('span', { style: 'flex:1;font-weight:600;' }, 'Select all');
    frame.appendChild(h('label', { style: 'display:flex;gap:0.5rem;align-items:center;padding:0.4rem 0.5rem;border-bottom:1px solid var(--border, rgba(127,127,127,0.3));font-weight:normal;cursor:pointer;' }, [
      allBox, allLabel,
      h('span', { id: 'spnPickCount', class: 'muted', style: 'font-size:0.8rem;white-space:nowrap;' }),
    ]));
    const list = h('div', { style: 'max-height:320px;overflow:auto;padding:0.25rem 0.5rem;' });
    frame.appendChild(list);
    box.appendChild(frame);

    function fillRows() {
      const top = list.scrollTop;
      list.textContent = '';
      const shown = shownFiles();
      allLabel.textContent = filterText ? 'Select all shown (' + shown.length + ')' : 'Select all';
      if (!shown.length) list.appendChild(h('div', { class: 'muted', style: 'padding:0.4rem 0;', text: 'No songs match.' }));
      shown.forEach(f => {
        list.appendChild(h('label', { style: 'display:flex;gap:0.5rem;align-items:center;padding:0.25rem 0;font-weight:normal;cursor:pointer;' }, [
          h('input', { type: 'checkbox', checked: picked.has(f.name), onchange: (e) => {
            if (e.target.checked) picked.add(f.name); else picked.delete(f.name);
            updatePickUi();
          } }),
          h('span', { style: 'flex:1;overflow-wrap:anywhere;', text: f.name }),
          h('span', { class: 'muted', style: 'font-size:0.8rem;white-space:nowrap;', text: mb(f.size) }),
        ]));
      });
      list.scrollTop = top;
      updatePickUi();
    }
    fillRows();
  }

  function renderLocalPicker(box) {
    const input = h('input', { type: 'file', multiple: true, accept: '.mp3,.m4a,.aac,.wav,.flac,.ogg,audio/*', onchange: (e) => {
      localFiles = Array.from(e.target.files || []);
      render();
    } });
    box.appendChild(input);
    if (localFiles.length) {
      box.appendChild(h('div', { class: 'muted', style: 'font-size:0.85rem;margin-top:0.4rem;', text: localFiles.length + ' file(s): ' + localFiles.map(f => f.name).join(', ') }));
    }
    box.appendChild(h('div', { class: 'muted', style: 'font-size:0.8rem;margin-top:0.3rem;', text: 'MP3, M4A, AAC, WAV, FLAC or OGG. Each fixed file comes back in the same format with the same name.' }));
  }

  function changeText(i) {
    if (i.action == null) return '—';
    if (i.action === 'none') return 'none';
    let s = signed(i.gainDb) + ' dB';
    if (i.action === 'limiter') s += ' (limiter)';
    if (i.action === 'peak-limited') s += ' (peak-limited)';
    return s;
  }

  function renderBatch(card) {
    const o = batch.opts;
    card.appendChild(h('p', { class: 'muted', style: 'font-size:0.85rem;', text:
      'Target ' + fmt1(o.targetLufs) + ' LUFS, peaks ≤ ' + fmt1(o.truePeak) + ' dBTP, limiter ' + (o.allowLimiter ? 'on' : 'off') + '.' }));

    const done = batch.items.filter(i => i.status === 'done');
    const skipped = batch.items.filter(i => i.status === 'skipped').length;
    const failed = batch.items.filter(i => i.status === 'error').length;
    const left = batch.items.filter(i => !TERMINAL[i.status]).length;
    card.appendChild(h('p', { style: 'font-weight:600;', text:
      done.length + ' fixed · ' + skipped + ' already right · ' + failed + ' failed' + (left ? ' · ' + left + ' to go' : '') }));

    const wrap = h('div', { style: 'overflow-x:auto;' });
    const table = h('table', { style: 'width:100%;font-size:0.85rem;' });
    table.appendChild(h('thead', null, h('tr', null, [
      h('th', { style: 'text-align:left;', text: 'Song' }),
      h('th', { style: 'text-align:right;white-space:nowrap;', text: 'Before' }),
      h('th', { style: 'text-align:right;white-space:nowrap;', text: 'Change' }),
      h('th', { style: 'text-align:right;white-space:nowrap;', text: 'After' }),
      h('th', { style: 'text-align:left;white-space:nowrap;', text: 'Length' }),
      h('th', { style: 'text-align:left;', text: 'Status' }),
      h('th', null),
    ])));
    const tbody = h('tbody');
    batch.items.forEach(i => {
      const before = i.before ? (fmt1(i.before.i) + ' LUFS / ' + fmt1(i.before.tp)) : '—';
      const after = i.after ? (fmt1(i.after.i) + ' LUFS / ' + fmt1(i.after.tp)) : '—';
      let length = '—';
      if (i.durationDelta != null) {
        const ms = Math.round(i.durationDelta * 1000);
        length = i.durationWarning ? ('⚠ ' + (ms > 0 ? '+' : '') + ms + ' ms') : 'same';
      }
      let st = (STATUS_LABEL[i.status] || i.status).replace('FPP', T());
      if (i.status === 'queued' && i.queuePosition) st += ' (#' + i.queuePosition + ')';
      const stEl = h('span', { text: st });
      if (i.status === 'error') stEl.title = i.error || '';
      const stCell = h('td', null, [stEl]);
      if (i.status === 'error' && i.error) stCell.appendChild(h('div', { class: 'muted', style: 'font-size:0.75rem;', text: i.error }));
      if (i.sent) stCell.appendChild(h('div', { class: 'muted', style: 'font-size:0.75rem;', text: i.sent === 'original' ? 'Original restored on ' + T() : 'Sent to ' + T() + ' ✓' }));
      if (i.sendError) stCell.appendChild(h('div', { class: 'err', style: 'font-size:0.75rem;', text: i.sendError }));
      if (i.after && i.status === 'done') {
        const off = i.after.i - batch.opts.targetLufs;
        if (Math.abs(off) > 1) {
          stCell.appendChild(h('div', { class: 'muted', style: 'font-size:0.75rem;', text:
            (off < 0 ? Math.abs(off).toFixed(1) + ' LU below' : off.toFixed(1) + ' LU above') + ' the target — ' +
            (i.action === 'peak-limited' ? 'its peaks don\'t leave room (turn the limiter on to go further).' : 'getting closer would squash it audibly.') }));
        }
      }
      if (i.durationWarning) stCell.appendChild(h('div', { class: 'muted', style: 'font-size:0.75rem;', text: 'Length changed — check it against the sequence before using it.' }));

      const actions = h('td', { style: 'white-space:nowrap;text-align:right;' });
      if (i.status === 'done') {
        actions.appendChild(h('button', { class: 'secondary', title: 'Download the fixed file', onclick: () => download(API + '/batches/' + batch.id + '/items/' + i.id + '/file'), text: 'Download' }));
        if (status.fppHost && i.canSend) {
          actions.appendChild(h('button', { class: 'secondary', style: 'margin-left:0.25rem;', title: 'Replace the file on ' + T() + ' with the fixed version',
            onclick: async () => { if (!confirmSend(1, false)) return; busyMsg = 'Sending ' + i.name + '…'; render(); await sendItem(i, false); busyMsg = ''; render(); },
            text: i.sent === 'normalized' ? 'Send again' : 'Send to ' + T() }));
          if (i.sent === 'normalized') {
            actions.appendChild(h('button', { class: 'secondary', style: 'margin-left:0.25rem;', title: 'Put the original file back on ' + T(),
              onclick: async () => { if (!confirmSend(1, true)) return; busyMsg = 'Restoring ' + i.name + '…'; render(); await sendItem(i, true); busyMsg = ''; render(); },
              text: 'Restore original' }));
          }
        }
      }
      const nameCell = h('td', { style: 'overflow-wrap:anywhere;' }, [i.name]);
      if (i.source === 'upload') nameCell.appendChild(h('span', { class: 'muted', style: 'font-size:0.75rem;', text: ' (uploaded)' }));
      tbody.appendChild(h('tr', null, [
        nameCell,
        h('td', { style: 'text-align:right;white-space:nowrap;', text: before }),
        h('td', { style: 'text-align:right;white-space:nowrap;', text: changeText(i) }),
        h('td', { style: 'text-align:right;white-space:nowrap;', text: after }),
        h('td', { style: 'white-space:nowrap;', text: length }),
        stCell,
        actions,
      ]));
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    card.appendChild(wrap);
    card.appendChild(h('div', { class: 'muted', style: 'font-size:0.8rem;margin-top:0.4rem;' },
      'Before/After show loudness and true peak (dBTP). "Already right" songs were within 0.5 LU of the target and are left untouched — no need to replace them.'));

    const sendable = done.filter(i => i.canSend && i.sent !== 'normalized').length;
    const bar = h('div', { class: 'row', style: 'gap:0.5rem;margin-top:1rem;flex-wrap:wrap;' });
    bar.appendChild(h('button', { disabled: !done.length, onclick: () => download(API + '/batches/' + batch.id + '/zip'), text: 'Download fixed files (.zip)' }));
    bar.appendChild(h('button', { class: 'secondary', disabled: !done.length, onclick: () => download(API + '/batches/' + batch.id + '/zip?original=1'), text: 'Download originals (.zip)' }));
    if (status.fppHost) {
      bar.appendChild(h('button', { class: 'secondary', disabled: !sendable || running(), onclick: sendAll, text: 'Send all fixed to ' + T() + (sendable ? ' (' + sendable + ')' : '') }));
    }
    bar.appendChild(h('button', { class: 'secondary', style: 'margin-left:auto;', onclick: startOver, text: 'Start over' }));
    card.appendChild(bar);

    const notes = [];
    notes.push(isPlayer()
      ? 'To do it by hand: download the fixed files and upload them on the Player\'s Files page, replacing the old ones (same names, so your sequences and playlists keep working).'
      : 'To do it by hand: download the fixed files and upload them in FPP\'s File Manager → Audio, replacing the old ones (same names, so your sequences and playlists keep working).');
    if (status.edition === 'main') notes.push(phoneHint());
    notes.push('Files are kept here for 3 hours after you last open this page.');
    if (status.showActive) notes.push('Your show is playing: wait until it stops before sending files to ' + T() + '.');
    notes.forEach(n => card.appendChild(h('div', { class: 'muted', style: 'font-size:0.8rem;margin-top:0.4rem;', text: n })));
  }

  // ---------- entry ----------
  async function open() {
    root = document.getElementById('spNormalizerRoot');
    if (!root) return;
    if (!status) render();
    await loadStatus();
    if (!batch) await resumeBatch();
    render();
    schedulePoll();
  }

  window.SPNormalizer = { open };
})();
