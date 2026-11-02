// ============================================================
// ShowPilot admin — Tools → Announcements (window.SPAnnouncer)
// ============================================================
// Renders into #spAnnouncerRoot. Talks to /api/admin/tools/announcer.
// Long work (speaking, loading songs, mixing) runs as server jobs that this
// page polls. User text goes in via textContent / .value only.
// ============================================================
(function () {
  'use strict';

  const API = '/api/admin/tools/announcer';
  const ENGINES = [
    { id: 'kokoro', label: 'Free voices (on this server)' },
    { id: 'openai', label: 'OpenAI' },
    { id: 'elevenlabs', label: 'ElevenLabs' },
    { id: 'upload', label: 'My own recording' },
  ];
  const SNIPPETS = [
    ['Tune in', 'Welcome to the show! Tune your radio to [your station] FM to hear the music, and enjoy.'],
    ['Headlights', 'Please turn off your headlights so everyone can enjoy the lights.'],
    ['Donations', 'If you are enjoying the show, donations for our local food bank are welcome at the box by the driveway. Thank you!'],
    ['Starting soon', 'The show starts in just a few minutes. Find a spot, tune in, and get ready!'],
    ['Thanks', 'Thanks for stopping by! Please drive safely, and happy holidays.'],
  ];

  let root = null;
  let st = null;           // /status
  let engine = 'kokoro';
  let text = '';
  let voice = null;        // { id, duration, text, engine }
  let mode = 'clip';
  let song = null;
  let fppFiles = null;
  let fppErr = null;
  let songPick = '';
  let elevenVoices = null;
  let clipOut = null, previewOut = null, introOut = null;
  let busy = '';
  let err = '';
  let installTimer = null;
  const clip = { name: '', leadIn: 0.5, tail: 1, target: -14 };
  const intro = { start: 1, duck: 12, boost: 0 };

  // ---------- helpers ----------
  function h(tag, attrs, kids) {
    const e = document.createElement(tag);
    if (attrs) for (const k of Object.keys(attrs)) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'style') e.style.cssText = v;
      else if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'value') e.value = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v === true) e.setAttribute(k, '');
      else e.setAttribute(k, v);
    }
    (Array.isArray(kids) ? kids : (kids == null ? [] : [kids])).forEach(c => {
      if (c == null || c === false) return;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return e;
  }
  const muted = (t, extra) => h('div', { class: 'muted', style: 'font-size:0.8rem;margin-top:0.3rem;' + (extra || ''), text: t });
  const sec = (s) => (s == null ? '—' : (Math.round(s * 10) / 10).toFixed(1) + ' s');

  async function call(path, opts) {
    opts = opts || {};
    const headers = Object.assign({}, opts.headers || {});
    let body = opts.body;
    if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.json); }
    const res = await fetch(API + path, { credentials: 'include', method: opts.method || (body ? 'POST' : 'GET'), headers, body });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) throw new Error((data && data.error) || ('Request failed (' + res.status + ')'));
    return data;
  }

  async function runJob(startPromise) {
    const { job } = await startPromise;
    for (;;) {
      const j = await call('/jobs/' + job);
      if (j.status === 'done') return j.result;
      if (j.status === 'error') throw new Error(j.error || 'Failed');
      busy = j.status === 'queued' ? 'Waiting for another job…' : (j.step || 'Working…');
      paintBusy();
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  async function act(label, fn) {
    err = '';
    busy = label;
    render();
    try { await fn(); } catch (e) { err = e.message || String(e); }
    busy = '';
    render();
  }

  function paintBusy() {
    const b = root && root.querySelector('#spaBusy');
    if (b) b.textContent = busy;
  }

  function engineOpts() {
    const s = st.settings;
    if (engine === 'kokoro') return s.kokoro;
    if (engine === 'openai') return s.openai;
    if (engine === 'elevenlabs') return s.elevenlabs;
    return {};
  }

  async function saveSettings() {
    try { const r = await call('/settings', { json: Object.assign({ engine: engine === 'upload' ? st.settings.engine : engine }, { kokoro: st.settings.kokoro, openai: st.settings.openai, elevenlabs: st.settings.elevenlabs }) }); st.settings = r.settings; } catch (_) {}
  }

  function defaultClipName() {
    const words = (voice && voice.text ? voice.text : 'Announcement').replace(/[^A-Za-z0-9 ]+/g, ' ').trim().split(/\s+/).slice(0, 5).join(' ');
    return (words || 'Announcement') + '.mp3';
  }

  // ---------- actions ----------
  async function generate() {
    await act('Starting…', async () => {
      await saveSettings();
      voice = await runJob(call('/voices', { json: { engine, text, opts: engineOpts() } }));
      clipOut = previewOut = introOut = null;
      clip.name = defaultClipName();
      st.recent = (await call('/status')).recent;
    });
  }

  async function uploadVoice(file) {
    await act('Uploading…', async () => {
      voice = await runJob(call('/voices/upload?name=' + encodeURIComponent(file.name), { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' } }));
      voice.text = file.name.replace(/\.[^.]+$/, '');
      clipOut = previewOut = introOut = null;
      clip.name = defaultClipName();
    });
  }

  function watchInstall() {
    clearTimeout(installTimer);
    installTimer = setTimeout(async () => {
      try { st.kokoro = (await call('/kokoro/status')).kokoro; } catch (_) {}
      if (!root || !root.isConnected) return;
      if (st.kokoro.install.running) {
        const p = root.querySelector('#spaInstall');
        if (p) p.textContent = installText();
        watchInstall();
      } else render();
    }, 2000);
  }
  function installText() {
    const i = st.kokoro.install;
    if (i.stage === 'engine') return 'Installing the voice engine (about 60 MB)…';
    if (i.stage === 'model') return 'Downloading voices: ' + Math.round(i.bytes / 1e6) + ' of ' + Math.round((i.total || 1) / 1e6) + ' MB…';
    return 'Working…';
  }

  async function loadSong(name) {
    await act('Loading song…', async () => {
      song = await runJob(call('/songs/fpp', { json: { name } }));
      previewOut = introOut = null;
    });
  }
  async function uploadSong(file) {
    await act('Uploading song…', async () => {
      song = await runJob(call('/songs/upload?name=' + encodeURIComponent(file.name), { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' } }));
      previewOut = introOut = null;
    });
  }

  function confirmFpp(msg) {
    let t = msg;
    if (st.showActive) t += '\n\nYour show is playing right now — replacing a file while it plays can cause a glitch.';
    return window.confirm(t);
  }

  // ---------- render ----------
  function render() {
    if (!root) return;
    root.textContent = '';
    const card = h('div', { class: 'card' });
    root.appendChild(card);
    card.appendChild(h('h2', { text: 'Announcements' }));
    card.appendChild(h('p', { class: 'muted' },
      'Make spoken announcements without recording yourself: a clip of its own ("Tune your radio", donations, "show starts soon") to drop into a playlist, ' +
      'or a voice-over on a song\'s intro with the music turned down underneath. Songs keep their exact length, so sequences stay in sync. ' +
      'Beta — please report anything odd.'));
    if (!st) { card.appendChild(muted('Loading…')); return; }
    if (st.demo) { card.appendChild(muted('Announcements are turned off in the demo.')); return; }
    if (!st.ffmpegOk) { card.appendChild(h('p', { class: 'err', text: 'ffmpeg is needed for this tool — see Tools → Audio Normalizer for how to install it.' })); return; }

    renderVoice(card);
    if (voice) renderUse();
    const status = h('div', { style: 'margin-top:0.75rem;' });
    status.appendChild(h('div', { id: 'spaBusy', class: 'muted', text: busy }));
    if (err) status.appendChild(h('div', { class: 'err', text: err }));
    root.appendChild(status);
  }

  function renderVoice(card) {
    card.appendChild(h('h3', { style: 'margin:1rem 0 0.5rem;', text: '1. The voice' }));
    card.appendChild(h('div', { class: 'row', style: 'gap:0.5rem;flex-wrap:wrap;' },
      ENGINES.map(e => h('button', { class: engine === e.id ? '' : 'secondary', text: e.label, onclick: () => { engine = e.id; err = ''; render(); } }))));
    const box = h('div', { style: 'margin-top:0.75rem;' });
    card.appendChild(box);
    if (engine === 'kokoro') renderKokoro(box);
    if (engine === 'openai') renderOpenAI(box);
    if (engine === 'elevenlabs') renderEleven(box);
    if (engine === 'upload') {
      box.appendChild(h('input', { type: 'file', accept: '.mp3,.m4a,.aac,.wav,.flac,.ogg,audio/*', onchange: (e) => { const f = e.target.files && e.target.files[0]; if (f) uploadVoice(f); } }));
      box.appendChild(muted('A recording from a friend, a voice actor or another app. It\'s level-matched automatically.'));
    } else if (engineReady()) {
      renderScript(box);
    }
    if (voice) {
      card.appendChild(h('div', { style: 'margin-top:0.75rem;padding:0.6rem;border:1px solid var(--border, rgba(127,127,127,0.3));border-radius:8px;' }, [
        h('div', { style: 'font-weight:600;', text: 'Voice ready — ' + sec(voice.duration) }),
        h('audio', { controls: true, preload: 'auto', src: API + '/voices/' + voice.id + '/audio', style: 'width:100%;margin-top:0.4rem;' }),
        muted(voice.engine || ''),
      ]));
    }
  }

  function engineReady() {
    if (engine === 'kokoro') return st.kokoro.ready;
    if (engine === 'openai') return !!st.keys.openai;
    if (engine === 'elevenlabs') return !!st.keys.elevenlabs;
    return true;
  }

  function renderKokoro(box) {
    const k = st.kokoro;
    if (!k.ready) {
      box.appendChild(h('p', { style: 'margin:0;' }, 'Natural-sounding voices that run right here — no account, no internet once installed (Kokoro, open source).'));
      if (k.install.running) {
        box.appendChild(h('div', { id: 'spaInstall', style: 'margin-top:0.5rem;font-weight:600;', text: installText() }));
        watchInstall();
        return;
      }
      const sel = h('select', { id: 'spaVariant' }, k.variants.map(v => h('option', { value: v.id, text: v.label })));
      sel.value = 'best';
      box.appendChild(h('div', { class: 'row', style: 'gap:0.5rem;margin-top:0.5rem;align-items:center;flex-wrap:wrap;' }, [
        sel,
        h('button', { text: 'Install free voices', onclick: async () => {
          try { st.kokoro = (await call('/kokoro/install', { json: { variant: sel.value } })).kokoro; } catch (e) { err = e.message; }
          render();
        } }),
      ]));
      box.appendChild(muted('"Best quality" sounds a little smoother; "Standard" is smaller and quicker. Both have the same voices.'));
      if (k.install.error) box.appendChild(h('div', { class: 'err', text: k.install.error }));
      return;
    }
    const o = st.settings.kokoro;
    const sel = h('select', { onchange: (e) => { o.voice = e.target.value; } });
    const groups = {};
    st.catalog.kokoroVoices.forEach(v => {
      if (!groups[v.group]) { groups[v.group] = h('optgroup', { label: v.group }); sel.appendChild(groups[v.group]); }
      groups[v.group].appendChild(h('option', { value: v.id, text: v.label }));
    });
    sel.value = o.voice;
    box.appendChild(h('div', { class: 'grid-2' }, [
      h('div', null, [h('label', { text: 'Voice' }), sel, muted('★ = best for announcements. Try "Santa" for Christmas.')]),
      speedField(o),
    ]));
    box.appendChild(h('div', { class: 'muted', style: 'font-size:0.8rem;margin-top:0.4rem;' }, [
      'Installed: ' + (k.model ? k.model.label.replace(/ \(.*/, '') : '') + '. ',
      h('a', { href: '#', text: 'Remove free voices', onclick: async (e) => {
        e.preventDefault();
        if (!window.confirm('Remove the free voice engine and model from this server?')) return;
        try { st.kokoro = (await call('/kokoro/remove', { method: 'POST' })).kokoro; } catch (x) { err = x.message; }
        render();
      } }),
    ]));
  }

  function speedField(o) {
    const out = h('span', { text: Number(o.speed || 1).toFixed(2) + '×' });
    return h('div', null, [
      h('label', null, ['Speed ', out]),
      h('input', { type: 'range', min: '0.7', max: '1.3', step: '0.05', value: String(o.speed || 1), style: 'width:100%;',
        oninput: (e) => { o.speed = Number(e.target.value); out.textContent = o.speed.toFixed(2) + '×'; } }),
    ]);
  }

  function keyField(provider, help) {
    const saved = st.keys[provider];
    const input = h('input', { type: 'password', placeholder: saved ? 'Saved (' + saved + ') — paste to replace' : 'Paste your API key', autocomplete: 'off', style: 'flex:1;min-width:14rem;' });
    const row = h('div', { class: 'row', style: 'gap:0.5rem;align-items:center;flex-wrap:wrap;' }, [
      input,
      h('button', { class: 'secondary', text: 'Save key', onclick: async () => {
        try { st.keys = (await call('/keys', { json: { provider, key: input.value } })).keys; elevenVoices = null; } catch (e) { err = e.message; }
        render();
      } }),
      saved ? h('button', { class: 'secondary', text: 'Remove', onclick: async () => {
        try { st.keys = (await call('/keys', { json: { provider, key: '' } })).keys; } catch (e) { err = e.message; }
        render();
      } }) : null,
    ]);
    return h('div', null, [h('label', { text: 'API key' }), row, muted(help + ' Stored only on this server, never shown again, not included in backups.')]);
  }

  function renderOpenAI(box) {
    box.appendChild(keyField('openai', 'From platform.openai.com → API keys. A whole season of announcements typically costs a few cents.'));
    if (!st.keys.openai) return;
    const o = st.settings.openai;
    const model = h('select', { onchange: (e) => { o.model = e.target.value; render(); } }, st.catalog.openaiModels.map(m => h('option', { value: m.id, text: m.label })));
    model.value = o.model;
    const vsel = h('select', { onchange: (e) => { o.voice = e.target.value; } }, st.catalog.openaiVoices.map(v => h('option', { value: v, text: v[0].toUpperCase() + v.slice(1) })));
    vsel.value = o.voice;
    box.appendChild(h('div', { class: 'grid-2', style: 'margin-top:0.75rem;' }, [
      h('div', null, [h('label', { text: 'Model' }), model]),
      h('div', null, [h('label', { text: 'Voice' }), vsel]),
    ]));
    if (o.model === 'gpt-4o-mini-tts') {
      box.appendChild(h('div', { style: 'margin-top:0.5rem;' }, [
        h('label', { text: 'How it should sound' }),
        h('textarea', { rows: '2', style: 'width:100%;', value: o.instructions || '', placeholder: 'e.g. Excited holiday radio DJ, warm and upbeat', oninput: (e) => { o.instructions = e.target.value; } }),
      ]));
    }
    box.appendChild(h('div', { style: 'margin-top:0.5rem;max-width:20rem;' }, speedField(o)));
  }

  function renderEleven(box) {
    box.appendChild(keyField('elevenlabs', 'From elevenlabs.io → your profile → API keys. The free plan covers a handful of announcements.'));
    if (!st.keys.elevenlabs) return;
    const o = st.settings.elevenlabs;
    const model = h('select', { onchange: (e) => { o.model = e.target.value; } }, st.catalog.elevenModels.map(m => h('option', { value: m.id, text: m.label })));
    model.value = o.model;
    let vfield;
    if (!elevenVoices) {
      vfield = h('div', null, [
        h('label', { text: 'Voice' }),
        h('button', { class: 'secondary', text: o.voiceName ? ('Using ' + o.voiceName + ' — load my voices') : 'Load my voices', onclick: () => act('Loading your ElevenLabs voices…', async () => {
          elevenVoices = (await call('/elevenlabs/voices')).voices;
        }) }),
      ]);
    } else {
      const sel = h('select', { onchange: (e) => { o.voice = e.target.value; const v = elevenVoices.find(x => x.id === o.voice); o.voiceName = v ? v.name : ''; } },
        [h('option', { value: '', text: 'Pick a voice…' })].concat(elevenVoices.map(v => h('option', { value: v.id, text: v.name + (v.description ? ' — ' + v.description : '') }))));
      sel.value = o.voice || '';
      vfield = h('div', null, [h('label', { text: 'Voice' }), sel, muted('Add more voices (including character voices) in the ElevenLabs Voice Library, then reload.')]);
    }
    box.appendChild(h('div', { class: 'grid-2', style: 'margin-top:0.75rem;' }, [h('div', null, [h('label', { text: 'Model' }), model]), vfield]));
  }

  function renderScript(box) {
    const ta = h('textarea', { rows: '3', style: 'width:100%;', value: text, placeholder: 'What should the voice say?', oninput: (e) => { text = e.target.value; } });
    box.appendChild(h('div', { style: 'margin-top:0.75rem;' }, [h('label', { text: 'Script' }), ta]));
    box.appendChild(h('div', { class: 'row', style: 'gap:0.35rem;flex-wrap:wrap;margin-top:0.35rem;' },
      [h('span', { class: 'muted', style: 'font-size:0.8rem;align-self:center;', text: 'Start from:' })].concat(
        SNIPPETS.map(([label, t]) => h('button', { class: 'secondary', style: 'padding:0.2rem 0.6rem;font-size:0.8rem;', text: label, onclick: () => { text = t; ta.value = t; } })))));
    if (st.recent && st.recent.length) {
      const rs = h('select', { onchange: (e) => { if (e.target.value !== '') { text = st.recent[Number(e.target.value)].text; ta.value = text; } } },
        [h('option', { value: '', text: 'Recent scripts…' })].concat(st.recent.map((r, i) => h('option', { value: String(i), text: r.text.slice(0, 80) }))));
      box.appendChild(h('div', { style: 'margin-top:0.35rem;' }, rs));
    }
    box.appendChild(muted('Replace anything in [brackets] with your own details. Tip: if a word comes out wrong, spell it how it sounds (e.g. "eighty-eight point one").'));
    box.appendChild(h('div', { style: 'margin-top:0.5rem;' }, h('button', { text: voice ? 'Generate again' : 'Generate voice', disabled: !!busy, onclick: generate })));
  }

  function renderUse() {
    const card = h('div', { class: 'card' });
    root.appendChild(card);
    card.appendChild(h('h3', { style: 'margin:0 0 0.5rem;', text: '2. Use it' }));
    card.appendChild(h('div', { class: 'row', style: 'gap:0.5rem;flex-wrap:wrap;' }, [
      h('button', { class: mode === 'clip' ? '' : 'secondary', text: 'Save as its own clip', onclick: () => { mode = 'clip'; render(); } }),
      h('button', { class: mode === 'intro' ? '' : 'secondary', text: 'Talk over a song\'s intro', onclick: () => { mode = 'intro'; render(); } }),
    ]));
    const box = h('div', { style: 'margin-top:0.75rem;' });
    card.appendChild(box);
    if (mode === 'clip') renderClip(box); else renderIntro(box);
  }

  function num(o, key, label, attrs, help) {
    return h('div', null, [
      h('label', { text: label }),
      h('input', Object.assign({ type: 'number', value: String(o[key]), style: 'width:7rem;', oninput: (e) => { o[key] = Number(e.target.value); } }, attrs)),
      help ? muted(help) : null,
    ]);
  }

  function renderClip(box) {
    if (!clip.name) clip.name = defaultClipName();
    box.appendChild(h('div', null, [
      h('label', { text: 'File name' }),
      h('input', { type: 'text', value: clip.name, style: 'width:100%;max-width:28rem;', oninput: (e) => { clip.name = e.target.value; } }),
    ]));
    box.appendChild(h('div', { class: 'grid-2', style: 'margin-top:0.5rem;' }, [
      num(clip, 'leadIn', 'Silence before (s)', { min: '0', max: '10', step: '0.5' }),
      num(clip, 'tail', 'Silence after (s)', { min: '0', max: '30', step: '0.5' }),
    ]));
    box.appendChild(h('div', { style: 'margin-top:0.5rem;' }, num(clip, 'target', 'Loudness (LUFS)', { min: '-30', max: '-5', step: '0.5' }, 'Same as your normalized songs (-14 by default), so the clip isn\'t louder or quieter than the music.')));
    box.appendChild(h('div', { style: 'margin-top:0.75rem;' }, h('button', { disabled: !!busy, text: 'Make clip', onclick: () => act('Building…', async () => {
      if (!/\.mp3$/i.test(clip.name)) clip.name = clip.name.replace(/\.[^.]*$/, '') + '.mp3';
      clipOut = await runJob(call('/render/clip', { json: { voiceId: voice.id, name: clip.name, leadIn: clip.leadIn, tail: clip.tail, targetLufs: clip.target } }));
    }) })));
    if (clipOut) {
      box.appendChild(outputBox(clipOut, [
        st.fppHost ? h('button', { class: 'secondary', text: clipOut.sent ? 'Sent ✓ — send again' : 'Send to FPP', onclick: () => act('Sending…', async () => {
          if (!confirmFpp('Save "' + clipOut.name + '" in FPP\'s music folder? (A file with the same name would be replaced.)')) return;
          clipOut = (await call('/outputs/' + clipOut.id + '/send', { json: {} })).output;
        }) }) : null,
      ], 'Add it to a playlist in FPP as a media-only entry (no sequence needed).'));
    }
  }

  function renderIntro(box) {
    // Song picker
    if (!song) {
      if (st.fppHost) {
        if (fppFiles === null && !fppErr) {
          box.appendChild(muted('Loading FPP\'s music folder…'));
          call('/fpp-files').then(r => { fppFiles = r.files; render(); }).catch(e => { fppErr = e.message; render(); });
        } else if (fppErr) {
          box.appendChild(h('div', { class: 'err', text: fppErr }));
        } else {
          const sel = h('select', { style: 'flex:1;min-width:14rem;', onchange: (e) => { songPick = e.target.value; } },
            [h('option', { value: '', text: 'Pick a song on FPP…' })].concat(fppFiles.map(f => h('option', { value: f.name, text: f.name }))));
          sel.value = songPick;
          box.appendChild(h('div', { class: 'row', style: 'gap:0.5rem;align-items:center;flex-wrap:wrap;' }, [
            sel, h('button', { disabled: !!busy, text: 'Load', onclick: () => { if (songPick) loadSong(songPick); } }),
          ]));
        }
      }
      box.appendChild(h('div', { style: 'margin-top:0.5rem;' }, [
        h('span', { class: 'muted', style: 'font-size:0.85rem;', text: st.fppHost ? 'Or upload one: ' : 'Upload the song: ' }),
        h('input', { type: 'file', accept: '.mp3,.m4a,.aac,.wav,.flac,.ogg,audio/*', onchange: (e) => { const f = e.target.files && e.target.files[0]; if (f) uploadSong(f); } }),
      ]));
      return;
    }
    box.appendChild(h('div', { class: 'row', style: 'gap:0.75rem;align-items:center;flex-wrap:wrap;' }, [
      h('strong', { style: 'overflow-wrap:anywhere;', text: song.name }),
      h('span', { class: 'muted', text: sec(song.duration) + ' · ' + song.loudness + ' LUFS' }),
      h('button', { class: 'secondary', text: 'Change song', onclick: () => { song = null; previewOut = introOut = null; render(); } }),
    ]));
    box.appendChild(h('div', { class: 'grid-2', style: 'margin-top:0.5rem;' }, [
      num(intro, 'start', 'Voice starts at (s)', { min: '0', max: '600', step: '0.5' }),
      num(intro, 'duck', 'Turn the music down by (dB)', { min: '0', max: '30', step: '1' }, '12 is a good start; more if the song is busy.'),
    ]));
    box.appendChild(h('div', { style: 'margin-top:0.5rem;' }, num(intro, 'boost', 'Voice level (dB, relative to the song)', { min: '-10', max: '10', step: '1' })));
    const params = () => ({ voiceId: voice.id, songId: song.id, start: intro.start, duckDb: intro.duck, voiceBoost: intro.boost });
    box.appendChild(h('div', { class: 'row', style: 'gap:0.5rem;margin-top:0.75rem;flex-wrap:wrap;' }, [
      h('button', { class: 'secondary', disabled: !!busy, text: 'Preview', onclick: () => act('Previewing…', async () => {
        previewOut = await runJob(call('/render/intro', { json: Object.assign(params(), { preview: true }) }));
      }) }),
      h('button', { disabled: !!busy, text: 'Make the full song', onclick: () => act('Mixing…', async () => {
        introOut = await runJob(call('/render/intro', { json: params() }));
      }) }),
    ]));
    if (previewOut) {
      box.appendChild(h('div', { style: 'margin-top:0.5rem;' }, [
        h('div', { class: 'muted', style: 'font-size:0.85rem;', text: 'Preview (just the part around the voice):' }),
        h('audio', { controls: true, src: API + '/outputs/' + previewOut.id + '?play=1', style: 'width:100%;' }),
      ]));
    }
    if (introOut) {
      const same = introOut.lengthDiffMs === 0;
      const lengthNote = same ? 'Same length as the original ✓ — the sequence stays in sync.'
        : '⚠ Length differs by ' + introOut.lengthDiffMs + ' ms — don\'t use it with the sequence.';
      const newName = { v: song.name.replace(/(\.[^.]+)$/, ' (intro)$1') };
      const extra = [];
      if (st.fppHost && !song.name.includes('/')) {
        extra.push(h('button', { class: 'secondary', text: introOut.sent === song.name ? 'Replaced ✓' : 'Replace the song on FPP', onclick: () => act('Sending…', async () => {
          if (!confirmFpp('Replace "' + song.name + '" on FPP with this version? Its sequence keeps working because the name and length stay the same. You can put the original back afterwards from here.')) return;
          introOut = (await call('/outputs/' + introOut.id + '/send', { json: { name: song.name } })).output;
        }) }));
        if (introOut.sent === song.name && song.source === 'fpp') {
          extra.push(h('button', { class: 'secondary', text: 'Put the original back', onclick: () => act('Restoring…', async () => {
            if (!confirmFpp('Put the original "' + song.name + '" back on FPP?')) return;
            await call('/songs/' + song.id + '/restore', { method: 'POST' });
            introOut.sent = null;
          }) }));
        }
        const nameIn = h('input', { type: 'text', value: newName.v, style: 'min-width:14rem;', oninput: (e) => { newName.v = e.target.value; } });
        extra.push(h('span', { class: 'row', style: 'gap:0.35rem;align-items:center;display:inline-flex;' }, [
          nameIn,
          h('button', { class: 'secondary', text: 'Save as new file', onclick: () => act('Sending…', async () => {
            introOut = (await call('/outputs/' + introOut.id + '/send', { json: { name: newName.v } })).output;
          }) }),
        ]));
      }
      box.appendChild(outputBox(introOut, extra, lengthNote + ' Saving it under a new name keeps the original; point the sequence at the new file in xLights/FPP to use it.'));
    }
  }

  function outputBox(o, extraButtons, note) {
    const playable = /\.mp3$/i.test(o.name);
    return h('div', { style: 'margin-top:0.75rem;padding:0.6rem;border:1px solid var(--border, rgba(127,127,127,0.3));border-radius:8px;' }, [
      h('div', { style: 'font-weight:600;overflow-wrap:anywhere;', text: o.name + ' — ' + sec(o.duration) + (o.loudness != null ? ' · ' + o.loudness + ' LUFS' : '') }),
      playable ? h('audio', { controls: true, preload: 'none', src: API + '/outputs/' + o.id + '?play=1', style: 'width:100%;margin-top:0.4rem;' }) : null,
      h('div', { class: 'row', style: 'gap:0.5rem;margin-top:0.5rem;flex-wrap:wrap;align-items:center;' },
        [h('button', { class: 'secondary', text: 'Download', onclick: () => {
          const a = h('a', { href: API + '/outputs/' + o.id, download: o.name });
          document.body.appendChild(a); a.click(); a.remove();
        } })].concat(extraButtons || [])),
      o.sent ? muted('Saved on FPP as "' + o.sent + '".') : null,
      note ? muted(note) : null,
    ]);
  }

  // ---------- entry ----------
  async function open() {
    root = document.getElementById('spAnnouncerRoot');
    if (!root) return;
    if (!st) render();
    try {
      st = await call('/status');
      if (!voice && st.settings && st.settings.engine) engine = st.settings.engine;
      if (engine === 'kokoro' && !st.kokoro.ready && st.keys.openai) engine = 'openai';
    } catch (e) { err = e.message; }
    render();
  }

  window.SPAnnouncer = { open };
})();
