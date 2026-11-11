// ============================================================
// Visual Designer Renderer
//
// Two source-of-truth modes feed HTML output:
//   - Settings mode: a form-filled object (showName, colors, fonts, etc.)
//                    is poured into a managed template.
//   - Blocks mode:   an ordered array of {type, props} blocks; each block
//                    type knows how to render itself.
//
// Both produce HTML that contains a marker comment so the designer can
// detect whether a template was generated (and therefore safe to round-trip
// back into the form) or hand-coded.
// ============================================================

const MANAGED_MARKER_SETTINGS = '<!-- OF_MANAGED:settings -->';
const MANAGED_MARKER_BLOCKS = '<!-- OF_MANAGED:blocks -->';

// ============================================================
// SETTINGS MODE — form-based template
// ============================================================

// Default values for the settings form. The form fills these in and the
// resulting object goes through renderSettingsTemplate().
const DEFAULT_SETTINGS = {
  showName: 'My Christmas Show',
  subtitle: 'Welcome to our 2025 Light Show',
  introText: 'Tune your radio to 98.9 FM to listen along, or use the Listen on Phone button at the bottom.',
  fmFrequency: '98.9 FM',
  showHoursLine1: 'Daily 7:00 PM – 9:00 PM',
  showHoursLine2: 'Christmas Eve & Day: 5:00 PM – 11:00 PM',

  // Colors
  bgGradientStart: '#0a0e27',
  bgGradientEnd: '#1a1f3a',
  primaryColor: '#dc2626',     // accent / hero / primary CTA
  textColor: '#ffffff',
  mutedColor: '#cbd5e1',

  // Fonts
  fontFamily: '"Inter", "Helvetica Neue", Arial, sans-serif',
  titleFontFamily: 'inherit',

  // Background image (optional — if set, overlays gradient)
  bgImageUrl: '',

  // Social links (optional — empty strings hide the link)
  socialFacebook: '',
  socialInstagram: '',
  socialYouTube: '',
};

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function escapeAttr(s) { return escapeHtml(s); }

// ---- Text formatting (v0.33.278-master.1+) -------------------------------
// Forum-style codes in block text, so owners can style a few words without
// HTML: [b]bold[/b] [i]italic[/i] [u]underline[/u] [s]strike[/s]
// [color=red]…[/color] (a color name or #hex) and [url=https://…]text[/url]
// (or [url]https://…[/url]). The text is escaped first, so only these exact
// codes become HTML; anything else, including [listen] in the timing tip or
// a code that isn't closed, stays as typed.
const FORMAT_TAGS = { b: 'strong', i: 'em', u: 'u', s: 's' };
function safeLinkHref(escaped) {
  const raw = String(escaped).replace(/&(lt|gt|quot|#39);/g, (m, e) => ({ lt: '<', gt: '>', quot: '"', '#39': "'" }[e])).replace(/&amp;/g, '&').trim();
  if (!/^(https?:\/\/|mailto:)[^\s"'<>]+$/i.test(raw)) return '';
  return escapeAttr(raw);
}
// opts.noLinks: for text that's already inside a button link (Donate,
// Directions); a [url] there keeps just its words.
function formatText(s, opts) {
  const noLinks = !!(opts && opts.noLinks);
  let out = escapeHtml(s);
  if (out.indexOf('[') === -1) return out;
  for (let pass = 0; pass < 8; pass++) {
    const before = out;
    out = out.replace(/\[(b|i|u|s)\]([\s\S]*?)\[\/\1\]/gi, (m, t, inner) => {
      const tag = FORMAT_TAGS[t.toLowerCase()];
      return '<' + tag + '>' + inner + '</' + tag + '>';
    });
    out = out.replace(/\[color=(#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20})\]([\s\S]*?)\[\/color\]/gi,
      (m, c, inner) => '<span style="color:' + c + '">' + inner + '</span>');
    out = out.replace(/\[url=([^\]\s]{1,500})\]([\s\S]*?)\[\/url\]/gi, (m, href, inner) => {
      const h = noLinks ? '' : safeLinkHref(href);
      return h ? '<a href="' + h + '" target="_blank" rel="noopener" style="color:inherit;text-decoration:underline;">' + inner + '</a>' : inner;
    });
    out = out.replace(/\[url\]([^\[\s]{1,500})\[\/url\]/gi, (m, href) => {
      const h = noLinks ? '' : safeLinkHref(href);
      return h ? '<a href="' + h + '" target="_blank" rel="noopener" style="color:inherit;text-decoration:underline;">' + href + '</a>' : href;
    });
    if (out === before) break;
  }
  return out;
}

// ---- List props (v0.33.268+) --------------------------------------------
const SOCIAL = require('../public/admin/social-icons.js');

// A list setting as rows of { key: text }: either the list itself, or the
// older text form (one item per line, fields separated by "|").
function listRows(value, keys) {
  if (Array.isArray(value)) {
    return value.map(r => Object.fromEntries(keys.map(k => [k, String((r && r[k]) || '').trim()])));
  }
  return String(value || '').split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const parts = l.split('|');
    return Object.fromEntries(keys.map((k, i) => [k, String(i === keys.length - 1 ? parts.slice(i).join('|') : (parts[i] || '')).trim()]));
  });
}

// FAQ items: a list of { q, a }, or the older text form ("Question | Answer"
// per line).
function faqRows(items) {
  if (Array.isArray(items)) {
    return items.map(r => ({ q: String((r && r.q) || '').trim(), a: String((r && r.a) || '').trim() })).filter(r => r.q);
  }
  return String(items || '').split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const i = l.indexOf('|');
    return i === -1 ? { q: l, a: '' } : { q: l.slice(0, i).trim(), a: l.slice(i + 1).trim() };
  }).filter(r => r.q);
}

// Turn what the owner typed into a safe link: emails become mailto:, phone
// numbers tel:, bare addresses https://. Anything else (javascript: etc.)
// is dropped.
function socialHref(platform, raw) {
  const v = String(raw || '').trim();
  if (!v) return '';
  if (/^(https?:|mailto:|tel:|sms:)/i.test(v)) return v;
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return '';
  if (platform === 'email' || /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(v)) return 'mailto:' + v;
  if (platform === 'phone' || /^[+()\d][\d\s().-]{5,}$/.test(v)) return 'tel:' + v.replace(/[^\d+]/g, '');
  return 'https://' + v.replace(/^\/+/, '');
}

// The block's links, newest form first: links = [{ platform, name, url, icon }].
// Pre-0.33.268 blocks had facebook / instagram / youtube text props.
function socialLinkList(p) {
  let list = Array.isArray(p.links) ? p.links : [];
  if (!list.length) {
    list = [['facebook', p.facebook], ['instagram', p.instagram], ['youtube', p.youtube]]
      .filter(([, u]) => u).map(([id, url]) => ({ platform: id, url, icon: id }));
  }
  return list.map((l) => {
    const plat = SOCIAL.get(l && l.platform);
    const name = String((l && l.name) || (plat ? plat.name : '') || 'Link').trim();
    const icon = l && l.icon === 'none' ? '' : String((l && l.icon) || (plat ? plat.id : 'link'));
    return { name, icon, href: socialHref(l && l.platform, l && l.url) };
  }).filter(l => l.href);
}

// Cover art for the Now Playing / Up Next blocks (v0.33.249+). The
// placeholder emits an <img> (hidden while there's no cover); the small
// style block sizes it. Repeating the style in two blocks is harmless.
function coverArtHtml(placeholder, px) {
  return `<style>.sp-cover-art-${px} img { width: ${px}px; height: ${px}px; object-fit: cover; border-radius: 12px; box-shadow: 0 6px 24px rgba(0,0,0,0.45); }</style>
  <div class="sp-cover-art sp-cover-art-${px}" style="text-align:center; margin: 0.75rem 0 0.25rem;">${placeholder}</div>`;
}

function renderSettingsTemplate(settings) {
  const s = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  const showName = escapeHtml(s.showName);
  const subtitle = escapeHtml(s.subtitle);
  const introText = escapeHtml(s.introText);
  const fmFreq = escapeHtml(s.fmFrequency);
  const hours1 = escapeHtml(s.showHoursLine1);
  const hours2 = escapeHtml(s.showHoursLine2);

  const socialBits = [];
  if (s.socialFacebook) socialBits.push(`<a href="${escapeAttr(s.socialFacebook)}" target="_blank" rel="noopener">Facebook</a>`);
  if (s.socialInstagram) socialBits.push(`<a href="${escapeAttr(s.socialInstagram)}" target="_blank" rel="noopener">Instagram</a>`);
  if (s.socialYouTube) socialBits.push(`<a href="${escapeAttr(s.socialYouTube)}" target="_blank" rel="noopener">YouTube</a>`);

  const bgLayer = s.bgImageUrl
    ? `background-image: url('${escapeAttr(s.bgImageUrl)}'), linear-gradient(180deg, ${escapeAttr(s.bgGradientStart)}, ${escapeAttr(s.bgGradientEnd)});
       background-size: cover; background-position: center; background-attachment: fixed;`
    : `background: linear-gradient(180deg, ${escapeAttr(s.bgGradientStart)}, ${escapeAttr(s.bgGradientEnd)}); background-attachment: fixed;`;

  return `${MANAGED_MARKER_SETTINGS}
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    ${bgLayer}
    color: ${escapeAttr(s.textColor)};
    font-family: ${s.fontFamily};
    min-height: 100vh;
    padding-bottom: 110px;
    overflow-x: hidden;
  }
  .of-page-wrap { max-width: 720px; margin: 0 auto; padding: 1.25rem; }
  .of-hero { text-align: center; padding: 2rem 1rem 1rem; }
  .of-hero-title {
    font-family: ${s.titleFontFamily === 'inherit' ? s.fontFamily : s.titleFontFamily};
    font-size: clamp(36px, 9vw, 56px);
    font-weight: 800;
    color: ${escapeAttr(s.primaryColor)};
    margin: 0;
    line-height: 1.1;
    text-shadow: 0 2px 12px rgba(0,0,0,0.4);
  }
  .of-hero-subtitle {
    font-size: clamp(18px, 4vw, 24px);
    margin: 0.5rem 0 0;
    opacity: 0.92;
  }
  .of-intro {
    font-size: clamp(15px, 4vw, 18px);
    line-height: 1.5;
    margin: 1rem auto;
    max-width: 560px;
    color: ${escapeAttr(s.mutedColor)};
  }
  .of-section-title {
    font-family: ${s.titleFontFamily === 'inherit' ? s.fontFamily : s.titleFontFamily};
    color: ${escapeAttr(s.primaryColor)};
    text-align: center;
    font-size: clamp(24px, 6vw, 32px);
    margin: 1.5rem 0 0.5rem;
  }
  .of-card {
    background: rgba(0,0,0,0.35);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 10px;
    padding: 1rem;
    margin: 0.75rem 0;
  }
  .of-now-playing {
    text-align: center;
    font-size: clamp(20px, 5vw, 26px);
    font-weight: 700;
    text-shadow: 0 0 8px rgba(255,255,255,0.2);
    margin: 0.5rem 0;
  }
  /* Artist under Now Playing / Up Next (v0.33.249+); empty when none. */
  .of-artist {
    text-align: center;
    font-size: clamp(14px, 3.8vw, 17px);
    opacity: 0.8;
    margin: -0.25rem 0 0.5rem;
  }
  .of-divider {
    height: 3px;
    background: linear-gradient(90deg, transparent, ${escapeAttr(s.primaryColor)} 20%, ${escapeAttr(s.primaryColor)} 80%, transparent);
    border-radius: 2px;
    margin: 1.25rem auto;
    width: 90%;
  }
  /* Song list cards */
  #playlists_container, .rtable {
    display: flex; flex-direction: column; gap: 8px;
    margin: 1rem auto; width: 100%;
  }
  .rtable { flex-direction: row; flex-wrap: wrap; gap: 8px 0; align-items: stretch; }
  .cell-vote-playlist, .jukebox-list {
    display: flex; align-items: center; gap: 12px;
    padding: 10px 14px; min-height: 64px;
    background: rgba(0,0,0,0.4);
    border: 2px solid rgba(255,255,255,0.1);
    border-radius: 10px;
    color: ${escapeAttr(s.textColor)};
    font-size: clamp(15px, 4vw, 18px);
    text-align: left;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s, transform 0.1s;
    line-height: 1.25;
  }
  .cell-vote-playlist { width: calc(100% - 80px); border-radius: 10px 0 0 10px; }
  .cell-vote-playlist:hover, .cell-vote-playlist:active,
  .jukebox-list:hover, .jukebox-list:active {
    background: ${escapeAttr(s.primaryColor)}40;
    border-color: ${escapeAttr(s.primaryColor)};
  }
  .cell-vote-playlist:active, .jukebox-list:active { transform: scale(0.98); }
  .cell-vote {
    display: flex; align-items: center; justify-content: center;
    width: 80px; min-height: 64px;
    background: ${escapeAttr(s.primaryColor)};
    border-radius: 0 10px 10px 0;
    color: ${escapeAttr(s.textColor)};
    font-weight: 700;
    font-size: clamp(18px, 5vw, 22px);
  }
  .sequence-image {
    width: 48px; height: 48px; border-radius: 6px; object-fit: cover; flex-shrink: 0;
    background: rgba(0,0,0,0.3);
  }
  .cell-vote-playlist-artist, .jukebox-list-artist {
    display: block; width: 100%;
    color: ${escapeAttr(s.mutedColor)}; opacity: 0.85;
    font-size: 0.82em; margin-top: 2px;
  }
  /* Status toasts (v0.32.12+).
     These eight IDs are flipped to display:block by rf-compat.js when
     a corresponding event fires (vote, request, error, etc.). Without
     position:fixed they were rendered as block-level elements at the
     bottom of the document — invisible to most users on a phone.
     Floating them at the top center matches the bundled themed
     templates. The existing inner-class styling (background colors)
     still applies to the .innerRequestSuccessful / .failed_Info_Box
     children. */
  #requestSuccessful, #voteSuccessful, #requestFailed, #requestPlaying,
  #queueFull, #alreadyVoted, #invalidLocation, #invalidLocationCode,
  #songPlaying, #songNextUp, #songCooldown, #alreadyRequested {
    position: fixed; top: 18px; left: 50%; transform: translateX(-50%);
    z-index: 10000; max-width: min(480px, calc(100vw - 32px));
    width: max-content; cursor: pointer;
    box-shadow: 0 6px 22px rgba(0,0,0,0.4);
    border-radius: 8px;
    animation: ofToastDrop 0.3s ease-out;
  }
  @keyframes ofToastDrop {
    from { transform: translate(-50%, -16px); opacity: 0; }
    to   { transform: translate(-50%, 0); opacity: 1; }
  }
  /* The inner styled boxes provide the colored background; reset their
     margin since the outer div now handles positioning. */
  #requestSuccessful .innerRequestSuccessful,
  #voteSuccessful .innerRequestSuccessful,
  #requestFailed .failed_Info_Box,
  #requestPlaying .failed_Info_Box,
  #queueFull .failed_Info_Box,
  #alreadyVoted .failed_Info_Box,
  #invalidLocation .failed_Info_Box,
  #invalidLocationCode .failed_Info_Box,
  #songPlaying .failed_Info_Box, #songNextUp .failed_Info_Box,
  #songCooldown .failed_Info_Box, #alreadyRequested .failed_Info_Box {
    margin: 0; max-width: none;
  }
  /* Status messages */
  .innerRequestSuccessful, .failed_Info_Box {
    margin: 1rem auto; max-width: 600px; padding: 0.85rem 1rem;
    border-radius: 8px; text-align: center; font-weight: 600;
  }
  .innerRequestSuccessful { background: #16a34a; color: #fff; }
  .failed_Info_Box { background: #ea580c; color: #fff; }
  /* Social */
  .of-social { text-align: center; margin: 1.5rem 0; }
  .of-social a {
    color: ${escapeAttr(s.primaryColor)}; text-decoration: none;
    margin: 0 0.5rem; font-weight: 600;
  }
  .of-social a:hover { text-decoration: underline; }
  @media (max-width: 480px) {
    .of-page-wrap { padding: 0.75rem; }
    body { padding-bottom: 120px; }
    .cell-vote-playlist { width: calc(100% - 60px); padding: 8px 10px; min-height: 56px; gap: 8px; }
    .cell-vote { width: 60px; min-height: 56px; }
    .sequence-image { width: 40px; height: 40px; }
  }
</style>
<meta name="viewport" content="width=device-width, initial-scale=1.0">

<div class="of-page-wrap">
  <div class="of-hero">
    <h1 class="of-hero-title">${showName}</h1>
    <p class="of-hero-subtitle">${subtitle}</p>
  </div>

  <p class="of-intro">${introText}</p>

  <div class="of-divider"></div>

  <!-- After-hours block — shown only when outside scheduled hours -->
  <div {after-hours-message}>
    <div class="of-section-title">Show Hours</div>
    <div class="of-card" style="text-align: center; font-size: clamp(16px, 4.5vw, 20px); line-height: 1.6;">
      ${hours1}<br />
      ${hours2}
    </div>
  </div>

  <!-- Now Playing — always visible (v0.32.8+).
       Used to be inside {jukebox-dynamic-container}; moved out so voting
       mode shows it too. Up Next moves with it. The Queue list stays
       jukebox-only since there's no "queue" concept in voting. -->
  <div>
    <div class="of-section-title">Now Playing</div>
    <div class="of-now-playing">{NOW_PLAYING}</div>
    <div class="of-artist">{NOW_PLAYING_ARTIST}</div>
    <div class="of-divider"></div>
    <div class="of-section-title">Up Next</div>
    <div class="of-now-playing" style="font-weight: 500; font-size: clamp(16px, 4.5vw, 20px);">{NEXT_PLAYLIST}</div>
    <div class="of-artist">{NEXT_PLAYLIST_ARTIST}</div>
  </div>

  <!-- Jukebox queue list — jukebox-only (voting mode has no queue) -->
  <div {jukebox-dynamic-container}>
    <div class="of-section-title">Queue ({QUEUE_SIZE})</div>
    <div class="of-card">{JUKEBOX_QUEUE}</div>
    <div class="of-divider"></div>
  </div>

  <!-- Voting instructions -->
  <div data-showpilot-pick-only {playlist-voting-dynamic-container}>
    <div class="of-section-title">Vote For Your Favorite</div>
    <p class="of-intro">Tap any song to vote — the winner plays next!</p>
  </div>

  <!-- Jukebox instructions -->
  <div data-showpilot-pick-only {jukebox-dynamic-container}>
    <div class="of-section-title">Pick Your Favorite</div>
    <p class="of-intro">Up to {QUEUE_DEPTH} songs in the queue. Tap to add yours.</p>
  </div>

  <!-- Location code (only if enabled) -->
  <div {location-code-dynamic-container}>
    <p class="of-intro" style="color: ${escapeAttr(s.primaryColor)};">Enter the code below to submit a request:</p>
    <div style="text-align: center;">{LOCATION_CODE}</div>
  </div>

  <!-- Voting list -->
  <div {playlist-voting-dynamic-container}>
    <div class="rtable">{PLAYLISTS}</div>
  </div>

  <!-- Jukebox list -->
  <div {jukebox-dynamic-container}>
    <div id="playlists_container">{PLAYLISTS}</div>
  </div>

  ${socialBits.length ? `<div class="of-social">${socialBits.join(' · ')}</div>` : ''}

  <!-- Status messages — DON'T DELETE -->
  <div id="requestSuccessful" style="display:none"><div class="innerRequestSuccessful">Successfully Added!</div></div>
  <div id="voteSuccessful" style="display:none"><div class="innerRequestSuccessful">You've Successfully Voted! 🗳️</div></div>
  <div id="requestFailed" style="display:none"><div class="failed_Info_Box">An unexpected error has occurred.</div></div>
  <div id="requestPlaying" style="display:none"><div class="failed_Info_Box">SONG ALREADY REQUESTED</div></div>
  <div id="queueFull" style="display:none"><div class="failed_Info_Box">QUEUE FULL — max {QUEUE_DEPTH}</div></div>
  <div id="invalidLocation" style="display:none"><div class="failed_Info_Box">INVALID LOCATION</div></div>
  <div id="alreadyVoted" style="display:none"><div class="failed_Info_Box">ALREADY VOTED — wait for the next round.</div></div>
  <div id="invalidLocationCode" style="display:none"><div class="failed_Info_Box">INVALID CODE</div></div>
  <div id="songPlaying" style="display:none"><div class="failed_Info_Box">SONG IS CURRENTLY PLAYING</div></div>
  <div id="songNextUp" style="display:none"><div class="failed_Info_Box">SONG IS ALREADY NEXT UP</div></div>
  <div id="songCooldown" style="display:none"><div class="failed_Info_Box">JUST PLAYED — back <span data-showpilot-cooldown-text>soon</span></div></div>
  <div id="alreadyRequested" style="display:none"><div class="failed_Info_Box">YOU ALREADY HAVE A REQUEST IN — wait for it to play</div></div>
</div>
`;
}

// ============================================================
// BLOCKS MODE — drag-and-drop section assembly
// ============================================================

// Each block type has:
//   - label: human name shown in the picker
//   - description: short blurb
//   - defaultProps: object of editable values
//   - render(props): returns HTML string
//
// Block HTML can include placeholders like {NOW_PLAYING}, etc. — those are
// resolved by the regular template renderer downstream.

const BLOCK_TYPES = {
  hero: {
    label: 'Hero',
    once: true,
    description: 'Big page title with optional subtitle',
    defaultProps: {
      title: 'My Christmas Show',
      subtitle: 'Welcome!',
      titleColor: '#dc2626',
    },
    render(p) {
      return `
<div style="text-align:center; padding: 2rem 1rem 1rem;">
  <h1 style="font-size: clamp(36px, 9vw, 56px); font-weight: 800;
             color: ${escapeAttr(p.titleColor)}; margin: 0; line-height: 1.1;
             text-shadow: 0 2px 12px rgba(0,0,0,0.4);">${formatText(p.title)}</h1>
  ${p.subtitle ? `<p style="font-size: clamp(18px, 4vw, 24px); margin: 0.5rem 0 0; opacity: 0.92;">${formatText(p.subtitle)}</p>` : ''}
</div>`;
    },
  },

  text: {
    label: 'Text Block',
    description: 'A paragraph of text — instructions, FM frequency, etc.',
    defaultProps: { content: 'Tune your radio to 98.9 FM!', color: '#ffffff', size: 'medium' },
    // Prop type hints (v0.32.10+). Used by the admin block editor to render
    // the right control for each prop. The render() function below only
    // knows how to handle three size values, so a free-text input was the
    // wrong control — users could type anything and silently get the
    // medium fallback. A dropdown matches the actual valid set.
    // Other props don't need explicit types; the editor's auto-inference
    // (color string → color picker, boolean → checkbox, long string →
    // textarea, else → text input) handles them correctly.
    propTypes: {
      size: {
        type: 'enum',
        options: [
          { value: 'small',  label: 'Small' },
          { value: 'medium', label: 'Medium' },
          { value: 'large',  label: 'Large' },
        ],
      },
    },
    render(p) {
      const sizes = { small: '14px', medium: 'clamp(15px, 4vw, 18px)', large: 'clamp(18px, 5vw, 22px)' };
      return `<p style="text-align:center; max-width: 560px; margin: 1rem auto;
                       font-size: ${sizes[p.size] || sizes.medium};
                       color: ${escapeAttr(p.color)}; line-height: 1.5;">${formatText(p.content)}</p>`;
    },
  },

  divider: {
    label: 'Divider',
    description: 'Horizontal accent line',
    defaultProps: { color: '#dc2626' },
    render(p) {
      return `<div style="height: 3px; background: linear-gradient(90deg, transparent, ${escapeAttr(p.color)} 20%, ${escapeAttr(p.color)} 80%, transparent); border-radius: 2px; margin: 1.25rem auto; width: 90%;"></div>`;
    },
  },

  audioSyncHelp: {
    label: 'Audio Sync Help',
    once: true,
    detect: 'data-showpilot-sync-help',
    description: 'Collapsible tip for listeners whose phone audio is out of sync with the lights. Only appears when Listen on Phone and its timing button are on. In the text, [listen] and [timing] show those buttons\' icons; **double asterisks** make bold.',
    defaultProps: {
      title: 'Music out of sync with the lights?',
      body: 'Listening on your phone, especially through car Bluetooth? Tap the [listen] **Listen on Phone** button at the bottom, then tap [timing] next to the Play button, and tap **Music is late** until the music matches the lights. Watching the singing faces to match up lyrics is the best reference, or better yet, play the show on another phone\u2019s speaker and adjust until your car audio matches it. This offset is saved on your phone until you reset it.',
      accentColor: '#00a8a8',
      startExpanded: false,
    },
    // Rendered hidden: rf-compat.js reveals [data-showpilot-sync-help] only
    // when the listener timing button exists (audio on + timing enabled), and
    // copies the live Listen on Phone button's icon into [data-sp-listen-icon].
    // No script lives in the block itself (v0.33.221+; idea and text from a
    // community contributor).
    render(p) {
      const accent = /^#[0-9a-fA-F]{6}$/.test(p.accentColor || '') ? p.accentColor : '#00a8a8';
      const sliders = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/></svg>';
      const phones = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/></svg>';
      const listenIcon = '<span data-sp-listen-icon aria-hidden="true" style="display:inline-flex;align-items:center;justify-content:center;width:1.8em;height:1.8em;border-radius:50%;overflow:hidden;vertical-align:middle;line-height:1;margin:0 2px;background:#dc2626;color:#fff;border:1px solid rgba(255,255,255,.4)">' + phones + '</span>';
      const timingIcon = '<span aria-hidden="true" style="display:inline-flex;align-items:center;justify-content:center;width:1.9em;height:1.9em;border-radius:50%;vertical-align:middle;margin:0 2px;border:1px solid ' + accent + ';color:' + accent + '">' + sliders + '</span>';
      let body = formatText(p.body || '');
      body = body.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\[listen\]/gi, listenIcon).replace(/\[timing\]/gi, timingIcon);
      const chev = '<svg class="sp-sh-chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
      return `
<style>.sp-sync-help summary{list-style:none}.sp-sync-help summary::-webkit-details-marker{display:none}.sp-sync-help .sp-sh-chev{flex:0 0 auto;transition:transform .15s}.sp-sync-help[open] .sp-sh-chev{transform:rotate(90deg)}@media (prefers-reduced-motion:reduce){.sp-sync-help .sp-sh-chev{transition:none}}</style>
<details class="sp-sync-help" data-showpilot-sync-help hidden${p.startExpanded ? ' open' : ''}
         style="max-width:560px;width:calc(100% - 32px);box-sizing:border-box;margin:1rem auto;border:1px solid ${accent}73;border-radius:12px;background:${accent}14;color:#fff;font-size:15px;line-height:1.5;text-align:left">
  <summary style="display:flex;align-items:center;gap:8px;min-height:48px;padding:0 14px;cursor:pointer;font-weight:700;color:${accent}">${chev}<span>${formatText(p.title || '')}</span></summary>
  <div style="padding:0 16px 14px">${body}</div>
</details>`;
    },
  },

  showHours: {
    label: 'Show Hours',
    once: true,
    description: 'Hours of operation — always, or only while Viewer Control is Off',
    defaultProps: {
      title: 'Show Hours',
      line1: 'Daily 7:00 PM – 9:00 PM',
      line2: 'Halloween Night: 6:00 PM – 10:00 PM',
      titleColor: '#dc2626',
      showWhen: 'viewerControlOff',
    },
    // showWhen: 'viewerControlOff' keeps the {after-hours-message} gate (the
    // renderer hides it unless viewer_control_mode is OFF); 'always' drops
    // the gate so the hours are on the page all the time. Blocks saved before
    // this option existed have no showWhen and get the default, i.e. the
    // original behaviour.
    propTypes: {
      showWhen: {
        type: 'enum',
        options: [
          { value: 'viewerControlOff', label: 'Only when Viewer Control is Off' },
          { value: 'always',           label: 'Always' },
        ],
      },
    },
    render(p) {
      const gate = p.showWhen === 'always' ? '' : ' {after-hours-message}';
      return `
<div${gate}>
  <h2 style="text-align:center; color: ${escapeAttr(p.titleColor)}; font-size: clamp(24px, 6vw, 32px); margin: 1.5rem 0 0.5rem;">${formatText(p.title)}</h2>
  <div style="background: rgba(0,0,0,0.35); border: 1px solid rgba(255,255,255,0.1);
              border-radius: 10px; padding: 1rem; max-width: 560px; margin: 0.75rem auto;
              text-align: center; font-size: clamp(16px, 4.5vw, 20px); line-height: 1.6;">
    ${formatText(p.line1)}<br />
    ${formatText(p.line2)}
  </div>
</div>`;
    },
  },

  nowPlaying: {
    label: 'Now Playing',
    description: 'Currently playing song (visible in all modes)',
    // showCoverArt (v0.33.249+): the song's cover above its name. Off for
    // blocks saved before it existed, so their pages don't change.
    // showArtist (v0.33.249+): the song's artist under its name (nothing
    // shows when the song has no artist).
    // showTimer / showProgress (v0.33.265): time left, and a progress bar.
    defaultProps: { titleColor: '#dc2626', showCoverArt: false, showArtist: true, showTimer: false, showProgress: false },
    once: true,
    detect: '\\{NOW_PLAYING\\}',
    render(p) {
      // v0.32.8+: this block is no longer wrapped in {jukebox-dynamic-container}.
      // It's always visible — the server returns the current song regardless
      // of mode, so showing it in voting/off mode is correct.
      return `
<div>
  <h2 style="text-align:center; color: ${escapeAttr(p.titleColor)}; font-size: clamp(24px, 6vw, 32px); margin: 1.5rem 0 0.5rem;">Now Playing</h2>
  ${p.showCoverArt ? coverArtHtml('{NOW_PLAYING_IMAGE}', 140) : ''}
  <div style="text-align:center; font-size: clamp(20px, 5vw, 26px); font-weight: 700; margin: 0.5rem 0;">{NOW_PLAYING}</div>
  ${p.showArtist ? '<div style="text-align:center; font-size: clamp(14px, 3.8vw, 17px); opacity: 0.8; margin: -0.25rem 0 0.5rem;">{NOW_PLAYING_ARTIST}</div>' : ''}
  ${p.showProgress ? '<div style="max-width:360px; margin: 0.5rem auto 0; padding: 0 1rem;">{NOW_PLAYING_PROGRESS}</div>' : ''}
  ${p.showTimer && !p.showProgress ? '<div style="text-align:center; font-size: clamp(15px, 4vw, 18px); opacity: 0.85; font-variant-numeric: tabular-nums;">{NOW_PLAYING_TIMER} left</div>' : ''}
</div>`;
    },
  },

  nextUp: {
    label: 'Up Next',
    once: true,
    detect: '\\{NEXT_PLAYLIST\\}',
    description: 'Next song (queue head in jukebox, vote leader in voting)',
    defaultProps: { titleColor: '#dc2626', showCoverArt: false, showArtist: true },
    render(p) {
      // v0.32.8+: standalone block for the upcoming song. Always visible.
      // The server computes nextScheduled the right way per mode (queue
      // head in JUKEBOX, current vote leader in VOTING, schedule otherwise),
      // so a single placeholder works for everything. The existing 'queue'
      // block still has a showNext flag that does the same thing inside the
      // jukebox-only queue — that's left alone for backward compatibility,
      // but new templates should prefer this standalone block.
      return `
<div>
  <h2 style="text-align:center; color: ${escapeAttr(p.titleColor)}; font-size: clamp(24px, 6vw, 32px); margin: 1.5rem 0 0.5rem;">Up Next</h2>
  ${p.showCoverArt ? coverArtHtml('{NEXT_PLAYLIST_IMAGE}', 100) : ''}
  <div style="text-align:center; font-size: clamp(16px, 4.5vw, 20px); margin: 0.5rem 0;">{NEXT_PLAYLIST}</div>
  ${p.showArtist ? '<div style="text-align:center; font-size: clamp(13px, 3.5vw, 15px); opacity: 0.8; margin: -0.25rem 0 0.5rem;">{NEXT_PLAYLIST_ARTIST}</div>' : ''}
</div>`;
    },
  },

  queue: {
    label: 'Queue',
    once: true,
    detect: '\\{JUKEBOX_QUEUE\\}',
    description: 'Current jukebox queue (jukebox mode only)',
    defaultProps: { titleColor: '#dc2626', showCount: true, showNext: true },
    render(p) {
      return `
<div {jukebox-dynamic-container}>
  ${p.showNext ? `
    <h2 style="text-align:center; color: ${escapeAttr(p.titleColor)}; font-size: clamp(24px, 6vw, 32px); margin: 1.5rem 0 0.5rem;">Up Next</h2>
    <div style="text-align:center; font-size: clamp(16px, 4.5vw, 20px); margin: 0.5rem 0;">{NEXT_PLAYLIST}</div>` : ''}
  ${p.showCount ? `
    <h2 style="text-align:center; color: ${escapeAttr(p.titleColor)}; font-size: clamp(24px, 6vw, 32px); margin: 1.5rem 0 0.5rem;">Queue ({QUEUE_SIZE})</h2>` : ''}
  <div style="background: rgba(0,0,0,0.35); border-radius: 10px; padding: 1rem; max-width: 560px; margin: 0.5rem auto; text-align: center;">{JUKEBOX_QUEUE}</div>
</div>`;
    },
  },

  votingInstructions: {
    label: 'Voting Instructions',
    once: true,
    description: 'Voting mode header + brief how-to',
    defaultProps: { titleColor: '#dc2626', text: 'Tap any song to vote — the winner plays next!' },
    render(p) {
      return `
<div data-showpilot-pick-only {playlist-voting-dynamic-container}>
  <h2 style="text-align:center; color: ${escapeAttr(p.titleColor)}; font-size: clamp(24px, 6vw, 32px); margin: 1.5rem 0 0.5rem;">Vote For Your Favorite</h2>
  <p style="text-align:center; max-width: 560px; margin: 0.5rem auto 1rem; font-size: clamp(15px, 4vw, 18px);">${formatText(p.text)}</p>
</div>`;
    },
  },

  jukeboxInstructions: {
    label: 'Jukebox Instructions',
    once: true,
    description: 'Jukebox mode header + brief how-to',
    defaultProps: { titleColor: '#dc2626', text: 'Up to {QUEUE_DEPTH} songs in the queue. Tap to add yours.' },
    render(p) {
      return `
<div data-showpilot-pick-only {jukebox-dynamic-container}>
  <h2 style="text-align:center; color: ${escapeAttr(p.titleColor)}; font-size: clamp(24px, 6vw, 32px); margin: 1.5rem 0 0.5rem;">Pick Your Favorite</h2>
  <p style="text-align:center; max-width: 560px; margin: 0.5rem auto 1rem; font-size: clamp(15px, 4vw, 18px);">${formatText(p.text)}</p>
</div>`;
    },
  },

  songList: {
    label: 'Song List',
    once: true,
    detect: '\\{PLAYLISTS\\}',
    description: 'The list of sequences (auto-renders for current mode)',
    defaultProps: {},
    render() {
      return `
<div {playlist-voting-dynamic-container}><div class="rtable">{PLAYLISTS}</div></div>
<div {jukebox-dynamic-container}><div id="playlists_container">{PLAYLISTS}</div></div>`;
    },
  },

  locationCode: {
    label: 'Location Code',
    once: true,
    detect: '\\{LOCATION_CODE\\}',
    description: 'Code-entry field (only shown if location code is enabled)',
    defaultProps: { promptText: 'Enter the code on our sign:', promptColor: '#dc2626' },
    render(p) {
      return `
<div {location-code-dynamic-container}>
  <p style="text-align:center; max-width: 560px; margin: 1rem auto;
            font-size: clamp(15px, 4vw, 18px); color: ${escapeAttr(p.promptColor)};">${formatText(p.promptText)}</p>
  <div style="text-align:center;">{LOCATION_CODE}</div>
</div>`;
    },
  },

  socialLinks: {
    label: 'Social Links',
    description: 'Buttons with logos linking to your social pages, website, email and more.',
    defaultProps: {
      links: [],
      show: 'icons',          // 'icons' | 'icons-names' | 'names'
      iconStyle: 'brand',     // 'brand' | 'white' | 'black' | 'custom'
      color: '#dc2626',       // custom logo color, and the color of names
      iconSize: 44,
    },
    // facebook / instagram / youtube / linkColor are the pre-0.33.268 props;
    // render() turns them into links, so the editor hides them.
    propTypes: {
      links: { type: 'socialLinks', label: 'Links' },
      show: { type: 'enum', label: 'Show', options: [
        { value: 'icons', label: 'Logos only' },
        { value: 'icons-names', label: 'Logos and names' },
        { value: 'names', label: 'Names only' },
      ] },
      color: { type: 'color', label: 'Color (names, and logos set to My color)' },
      iconStyle: { type: 'enum', label: 'Logo style', options: [
        { value: 'brand', label: 'Brand colors' },
        { value: 'white', label: 'White' },
        { value: 'black', label: 'Black' },
        { value: 'custom', label: 'My color (below)' },
      ] },
      iconSize: { type: 'number', label: 'Logo size (pixels)', min: 24, max: 96, step: 2 },
      facebook: { type: 'hidden' }, instagram: { type: 'hidden' }, youtube: { type: 'hidden' }, linkColor: { type: 'hidden' },
    },
    render(p) {
      const links = socialLinkList(p);
      if (!links.length) return '<!-- (no social links yet: add some in this block\'s settings) -->';
      const size = Math.max(24, Math.min(96, Number(p.iconSize) || 44));
      const glyph = Math.round(size * 0.52);
      const color = /^#[0-9a-fA-F]{6}$/.test(p.color || '') ? p.color : '#dc2626';
      const showIcon = p.show !== 'names';
      const showName = p.show === 'names' || p.show === 'icons-names';
      const items = links.map((l) => {
        const icon = showIcon && l.icon ? SOCIAL.get(l.icon) : null;
        let bg, fg;
        if (p.iconStyle === 'white') { bg = '#ffffff'; fg = '#111111'; }
        else if (p.iconStyle === 'black') { bg = '#111111'; fg = '#ffffff'; }
        else if (p.iconStyle === 'custom') { bg = color; fg = '#ffffff'; }
        else { bg = icon ? icon.color : color; fg = '#ffffff'; }
        // Every spacing property is set inline so a template's own rules
        // (e.g. "a svg { margin-right: 6px }") can't push the logo off
        // centre in its circle (v0.33.271).
        // Logos that are already a circle (Facebook, Pinterest…) are drawn
        // full size as themselves, with a backing disc so their cut-outs
        // (Facebook's "f") show solid, instead of a circle inside a circle.
        let badgeFg = '#ffffff', badgeBack = '#ffffff';
        if (icon && icon.badge) {
          if (p.iconStyle === 'white') { badgeFg = '#ffffff'; badgeBack = '#111111'; }
          else if (p.iconStyle === 'black') { badgeFg = '#111111'; badgeBack = '#ffffff'; }
          else if (p.iconStyle === 'custom') { badgeFg = color; badgeBack = '#ffffff'; }
          else { badgeFg = icon.color; badgeBack = '#ffffff'; }
        }
        const svg = icon && icon.badge
          ? `<span style="display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;width:${size}px;height:${size}px;min-width:${size}px;margin:0;padding:0;border:0;background:none;flex:none;line-height:0;position:relative;float:none;transform:none;"><svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false" style="display:block;width:${size}px;height:${size}px;max-width:none;margin:0;padding:0;border:0;position:static;float:none;transform:none;vertical-align:baseline;flex:none;overflow:visible;"><circle cx="12" cy="12" r="11.5" fill="${escapeAttr(badgeBack)}"/><path fill="${escapeAttr(badgeFg)}" d="${escapeAttr(icon.path)}"/></svg></span>`
          : icon
          ? `<span style="display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;width:${size}px;height:${size}px;min-width:${size}px;margin:0;padding:0;border:0;border-radius:50%;background:${escapeAttr(bg)};flex:none;line-height:0;position:relative;float:none;transform:none;"><svg viewBox="0 0 24 24" width="${glyph}" height="${glyph}" aria-hidden="true" focusable="false" style="display:block;width:${glyph}px;height:${glyph}px;max-width:none;margin:0;padding:0;border:0;position:static;float:none;transform:none;vertical-align:baseline;flex:none;overflow:visible;"><path fill="${escapeAttr(fg)}" d="${escapeAttr(icon.path)}"/></svg></span>`
          : '';
        const name = showName || !svg
          ? `<span style="font-weight:600;color:${escapeAttr(color)};margin:0;padding:0;line-height:1.2;">${escapeHtml(l.name)}</span>`
          : '';
        return `<a href="${escapeAttr(l.href)}"${/^https?:/i.test(l.href) ? ' target="_blank" rel="noopener"' : ''} aria-label="${escapeAttr(l.name)}" title="${escapeAttr(l.name)}" style="display:inline-flex;align-items:center;gap:.45rem;text-decoration:none;margin:.3rem .35rem;padding:0;border:0;background:none;line-height:1;width:auto;height:auto;">${svg}${name}</a>`;
      });
      return `<div class="sp-social" style="text-align:center;margin:1.25rem auto;max-width:720px;padding:0 1rem;display:flex;flex-wrap:wrap;justify-content:center;align-items:center;">${items.join('')}</div>`;
    },
  },

  // ---- v0.33.265 blocks -------------------------------------------------
  // Blocks below keep all behaviour in rf-compat.js (no scripts in the
  // block): they render markup with data-showpilot-* hooks.

  messageBox: {
    label: 'Message Box',
    description: 'The "send a message to the show" form. Only shows while visitor messages are open (Visitor Messages page).',
    once: true,
    detect: '\\{MESSAGE_BOX\\}|data-showpilot-message-box',
    defaultProps: {},
    render() {
      return '<div style="max-width:560px;margin:1rem auto;padding:0 1rem;">{MESSAGE_BOX}</div>';
    },
  },

  messageWall: {
    label: 'Message Wall',
    description: 'Messages visitors chose to share, once approved. Hidden while there are none.',
    once: true,
    detect: '\\{MESSAGE_WALL\\}|data-showpilot-message-wall',
    defaultProps: {},
    render() {
      return '<div style="max-width:720px;margin:1rem auto;padding:0 1rem;">{MESSAGE_WALL}</div>';
    },
  },

  showButtons: {
    label: 'Show Buttons',
    description: 'Buttons visitors press to run an effect on your show (fog, a flood light, a prop). Set them up in Settings → Show Buttons. Hidden while they are off.',
    once: true,
    detect: '\\{SHOW_BUTTONS\\}|data-showpilot-show-buttons',
    defaultProps: {},
    render() {
      return '<div style="max-width:720px;margin:1rem auto;padding:0 1rem;">{SHOW_BUTTONS}</div>';
    },
  },

  listenOnly: {
    label: 'Listen Only',
    description: 'Shown only in Listen only mode, in place of the song list (v0.33.281). Visitors see this message while voting and requests are closed.',
    once: true,
    detect: '\\{listen-only-dynamic-container\\}',
    defaultProps: {
      title: 'Sit back and enjoy the show',
      text: 'Requests and voting are paused right now. Tune in on your radio or tap {LISTEN_BUTTON} to listen on your phone.',
      titleColor: '#dc2626',
    },
    render(p) {
      // {LISTEN_BUTTON} in the text is left for the viewer renderer to turn
      // into the inline headphones button.
      const text = escapeHtml(p.text || '').replace(/\{LISTEN_BUTTON\}/g, '{LISTEN_BUTTON}');
      return `
<div {listen-only-dynamic-container} style="max-width:560px;margin:1.5rem auto;padding:0 1rem;text-align:center;">
  ${p.title ? `<h2 style="color:${escapeAttr(p.titleColor)};font-size:clamp(24px,6vw,32px);margin:0 0 .5rem;">${escapeHtml(p.title)}</h2>` : ''}
  ${p.text ? `<p style="font-size:clamp(16px,4.3vw,19px);line-height:1.5;margin:0;">${text}</p>` : ''}
</div>`;
    },
  },

  listenButton: {
    label: 'Listen Button',
    description: 'A big "Listen on your phone" button that opens Listen on Phone. Hidden when phone audio is off or the visitor is out of range.',
    once: true,
    detect: '\\{LISTEN_BUTTON\\}|data-showpilot-listen',
    defaultProps: { text: 'Listen on your phone', buttonColor: '#dc2626', textColor: '#ffffff' },
    render(p) {
      return `<div style="text-align:center;margin:1.25rem auto;">
  <button type="button" class="sp-listen-big" data-showpilot-listen
          style="display:inline-flex;align-items:center;gap:10px;min-height:52px;padding:0 24px;border:0;border-radius:999px;cursor:pointer;font:inherit;font-weight:700;font-size:clamp(16px,4.5vw,19px);background:${escapeAttr(p.buttonColor)};color:${escapeAttr(p.textColor)};box-shadow:0 4px 14px rgba(0,0,0,.35);">
    <span aria-hidden="true">🎧</span><span>${formatText(p.text || '')}</span>
  </button>
</div>`;
    },
  },

  countdown: {
    label: 'Countdown',
    description: 'Counts down to tonight\u2019s show (every day at the start time) or to one date, in the show\u2019s time zone (Show time zone, next to Scheduled switches). Shows a message while the show is on.',
    detect: 'data-showpilot-countdown',
    defaultProps: {
      title: 'Show starts in',
      countTo: 'daily',
      startTime: '18:00',
      endTime: '22:00',
      date: '',
      liveText: 'The show is on! 🎄',
      titleColor: '#dc2626',
    },
    propTypes: {
      countTo: { type: 'enum', options: [
        { value: 'daily', label: 'Every day at the start time' },
        { value: 'date',  label: 'One date' },
      ] },
      startTime: { type: 'time' },
      endTime: { type: 'time' },
      date: { type: 'datetime' },
    },
    render(p) {
      const daily = p.countTo !== 'date';
      const attrs = daily
        ? `data-showpilot-countdown="daily" data-start="${escapeAttr(p.startTime || '18:00')}" data-end="${escapeAttr(p.endTime || '')}"`
        : `data-showpilot-countdown="date" data-date="${escapeAttr(p.date || '')}"`;
      return `
<div ${attrs} data-live-text="${escapeAttr(p.liveText || '')}" style="text-align:center;margin:1.5rem auto;max-width:560px;padding:0 1rem;">
  <div class="sp-countdown-title" style="color:${escapeAttr(p.titleColor)};font-size:clamp(20px,5vw,26px);font-weight:700;margin-bottom:.5rem;">${formatText(p.title || '')}</div>
  <div class="sp-countdown-time" data-showpilot-countdown-time style="font-size:clamp(30px,9vw,46px);font-weight:800;letter-spacing:.02em;font-variant-numeric:tabular-nums;">&nbsp;</div>
  <div class="sp-countdown-live" data-showpilot-countdown-live hidden style="font-size:clamp(22px,6vw,30px);font-weight:800;">${formatText(p.liveText || '')}</div>
</div>`;
    },
  },

  visitorRules: {
    label: 'Visitor Rules',
    description: 'A short list of show etiquette.',
    defaultProps: {
      title: 'Please help us keep the show fun',
      rules: [
        { text: 'Turn off your headlights' },
        { text: 'Stay in your car' },
        { text: 'Don\u2019t block driveways or mailboxes' },
        { text: 'Keep the volume down for our neighbors' },
        { text: 'Please don\u2019t touch the lights' },
      ],
      accentColor: '#dc2626',
    },
    // rules is a list of { text } (v0.33.269+); older pages saved one per line.
    propTypes: { rules: { type: 'rows', label: 'Rules', addLabel: 'Add a rule', fields: [{ key: 'text', label: 'Rule' }] } },
    render(p) {
      const items = listRows(p.rules, ['text']).map(r => r.text).filter(Boolean);
      if (!items.length) return '<!-- (no rules) -->';
      const accent = escapeAttr(p.accentColor);
      return `
<div class="sp-rules" style="max-width:560px;margin:1.25rem auto;padding:0 1rem;">
  <h2 style="text-align:center;color:${accent};font-size:clamp(22px,5.5vw,28px);margin:0 0 .6rem;">${formatText(p.title || '')}</h2>
  <ul style="list-style:none;margin:0;padding:.75rem 1rem;background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.1);border-radius:10px;text-align:left;">
    ${items.map(t => `<li style="display:flex;gap:10px;align-items:flex-start;padding:.4rem 0;font-size:clamp(15px,4vw,18px);line-height:1.4;"><span aria-hidden="true" style="color:${accent};font-weight:800;">✓</span><span>${formatText(t)}</span></li>`).join('')}
  </ul>
</div>`;
    },
  },

  faq: {
    label: 'FAQ',
    description: 'Questions that tap open to show the answer.',
    defaultProps: {
      title: 'Questions',
      items: [
        { q: 'How do I hear the music?', a: 'Tune your radio to 98.9 FM, or tap the headphones to listen on your phone.' },
        { q: 'Why didn\u2019t my song play yet?', a: 'Requests play in order. Yours is in the queue!' },
        { q: 'How long is the show?', a: 'About 30 minutes, and it repeats all night.' },
      ],
      accentColor: '#dc2626',
    },
    // items is a list of { q, a } (v0.33.268+). Older pages saved it as text,
    // one "Question | Answer" per line; faqRows() reads both.
    propTypes: { items: { type: 'rows', label: 'Questions', addLabel: 'Add a question', fields: [
      { key: 'q', label: 'Question' },
      { key: 'a', label: 'Answer', long: true },
    ] } },
    render(p) {
      const rows = faqRows(p.items);
      if (!rows.length) return '<!-- (no questions) -->';
      const accent = escapeAttr(p.accentColor);
      return `
<style>.sp-faq summary{list-style:none;cursor:pointer}.sp-faq summary::-webkit-details-marker{display:none}.sp-faq summary::after{content:'+';float:right;font-weight:800;opacity:.8}.sp-faq details[open] summary::after{content:'\\2212'}</style>
<div class="sp-faq" style="max-width:560px;margin:1.25rem auto;padding:0 1rem;text-align:left;">
  ${p.title ? `<h2 style="text-align:center;color:${accent};font-size:clamp(22px,5.5vw,28px);margin:0 0 .6rem;">${formatText(p.title)}</h2>` : ''}
  ${rows.map(r => `<details style="background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.1);border-left:3px solid ${accent};border-radius:10px;margin:.45rem 0;">
    <summary style="padding:.8rem 1rem;font-weight:700;font-size:clamp(15px,4vw,17px);">${formatText(r.q)}</summary>
    ${r.a ? `<div style="padding:0 1rem .9rem;line-height:1.5;opacity:.92;">${formatText(r.a).replace(/\n/g, '<br>')}</div>` : ''}
  </details>`).join('')}
</div>`;
    },
  },

  donate: {
    label: 'Donate',
    description: 'A donation or charity button, with an optional goal bar.',
    detect: 'sp-donate',
    defaultProps: {
      title: 'Support our charity',
      text: 'This year we\u2019re raising money for our local food bank. Every bit helps!',
      buttonText: 'Donate',
      link: '',
      goal: 0,
      raised: 0,
      accentColor: '#16a34a',
    },
    propTypes: { goal: { type: 'number', min: 0, step: 1 }, raised: { type: 'number', min: 0, step: 1 } },
    render(p) {
      const accent = escapeAttr(p.accentColor);
      const goal = Math.max(0, Number(p.goal) || 0);
      const raised = Math.max(0, Number(p.raised) || 0);
      const pct = goal > 0 ? Math.min(100, Math.round(raised / goal * 100)) : 0;
      const money = (n) => '$' + Math.round(n).toLocaleString('en-US');
      const link = /^https?:\/\//i.test(p.link || '') ? p.link : '';
      return `
<div style="max-width:560px;margin:1.25rem auto;padding:0 1rem;"><div class="sp-donate" style="padding:1rem 1.1rem;background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.1);border-radius:12px;text-align:center;">
  <h2 style="color:${accent};font-size:clamp(22px,5.5vw,28px);margin:0 0 .4rem;">${formatText(p.title || '')}</h2>
  ${p.text ? `<p style="margin:0 0 .8rem;line-height:1.5;">${formatText(p.text)}</p>` : ''}
  ${goal > 0 ? `<div style="height:12px;border-radius:999px;background:rgba(255,255,255,.15);overflow:hidden;margin:.4rem 0 .35rem;"><div style="height:100%;width:${pct}%;background:${accent};border-radius:999px;"></div></div>
  <div style="font-size:.92em;opacity:.9;margin-bottom:.8rem;">${money(raised)} of ${money(goal)} raised</div>` : ''}
  ${link ? `<a href="${escapeAttr(link)}" target="_blank" rel="noopener" style="display:inline-block;padding:.75rem 1.6rem;border-radius:999px;background:${accent};color:#fff;font-weight:700;text-decoration:none;">${formatText(p.buttonText || 'Donate', { noLinks: true })}</a>` : '<!-- (add a donation link to show the button) -->'}
</div></div>`;
    },
  },

  image: {
    label: 'Image',
    description: 'A picture, or a small gallery, with an optional caption.',
    // width / height / fit (v0.33.277-master.3+): blank width and height keep the
    // original look (one picture up to 560px wide, gallery tiles square),
    // so blocks saved before these existed render exactly as before.
    defaultProps: { images: [], caption: '', rounded: true, width: null, height: null, fit: 'contain' },
    // images is a list of { url } (v0.33.269+); older pages saved one per line.
    propTypes: {
      images: { type: 'rows', label: 'Pictures', addLabel: 'Add a picture', fields: [
        { key: 'url', label: 'Picture address (https://… or /path/on/this/site)' },
      ] },
      width:  { type: 'number', min: 20, max: 2000, step: 1, label: 'Width in pixels (blank = full width; in a gallery, each picture)' },
      height: { type: 'number', min: 20, max: 2000, step: 1, label: 'Height in pixels (blank = keep the shape)' },
      fit: { type: 'enum', label: 'When both are set', options: [
        { value: 'fill',    label: 'Set to exactly this size' },
        { value: 'contain', label: 'Show the whole picture' },
        { value: 'cover',   label: 'Fill the space (trims the edges)' },
      ] },
    },
    render(p) {
      const urls = listRows(p.images, ['url']).map(r => r.url).filter(u => /^(https?:\/\/|\/)/i.test(u));
      if (!urls.length) return '<!-- (add an image address) -->';
      const r = p.rounded ? 'border-radius:12px;' : '';
      const one = urls.length === 1;
      // Whole pixels in range, or 0 for "not set". Never trust saved props as CSS.
      const px = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 20 ? Math.min(n, 2000) : 0; };
      const w = px(p.width), h = px(p.height);
      const fit = p.fit === 'cover' || p.fit === 'fill' ? p.fit : 'contain';
      const size = one
        ? (h ? `height:${h}px;object-fit:${fit};` : 'height:auto;')
        : (h ? `height:${h}px;object-fit:${fit};` : 'aspect-ratio:1/1;object-fit:cover;');
      const imgs = urls.map(u => `<img src="${escapeAttr(u)}" alt="" loading="lazy" style="display:block;width:100%;${size}${r}">`).join('');
      // A single picture's width caps the figure (plus its 1rem side padding);
      // a gallery's width is each tile's size.
      const maxW = one ? (w ? w + 32 : 560) : 720;
      // Gallery columns: a set width makes every tile that size (centred,
      // never wider than the screen); blank keeps the stretchy 140px grid.
      const cols = w
        ? `grid-template-columns:repeat(auto-fill,min(${w}px,100%));justify-content:center;`
        : 'grid-template-columns:repeat(auto-fill,minmax(140px,1fr));';
      return `
<figure style="max-width:${maxW}px;margin:1.25rem auto;padding:0 1rem;">
  ${one ? imgs : `<div style="display:grid;${cols}gap:8px;">${imgs}</div>`}
  ${p.caption ? `<figcaption style="text-align:center;margin-top:.5rem;opacity:.85;font-size:.95em;">${formatText(p.caption)}</figcaption>` : ''}
</figure>`;
    },
  },

  directions: {
    label: 'Directions',
    description: 'Your address with an "Open in Maps" button.',
    defaultProps: { title: 'Find us', address: '', buttonText: 'Open in Maps', accentColor: '#dc2626' },
    render(p) {
      const addr = String(p.address || '').trim();
      if (!addr) return '<!-- (add an address) -->';
      const accent = escapeAttr(p.accentColor);
      const url = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(addr);
      return `
<div style="max-width:560px;margin:1.25rem auto;padding:0 1rem;text-align:center;">
  ${p.title ? `<h2 style="color:${accent};font-size:clamp(22px,5.5vw,28px);margin:0 0 .4rem;">${formatText(p.title)}</h2>` : ''}
  <div style="font-size:clamp(16px,4.3vw,19px);margin-bottom:.75rem;">${escapeHtml(addr)}</div>
  <a href="${escapeAttr(url)}" target="_blank" rel="noopener" style="display:inline-block;padding:.7rem 1.5rem;border-radius:999px;background:${accent};color:#fff;font-weight:700;text-decoration:none;">📍 ${formatText(p.buttonText || 'Open in Maps', { noLinks: true })}</a>
</div>`;
    },
  },

  topSongs: {
    label: 'Top Songs',
    description: 'The songs visitors picked most (requests and vote winners) tonight, this week or all season. Updates by itself.',
    detect: 'data-showpilot-top-songs',
    defaultProps: { title: 'Most requested tonight', period: 'tonight', count: 5, titleColor: '#dc2626' },
    propTypes: {
      period: { type: 'enum', options: [
        { value: 'tonight', label: 'Tonight' },
        { value: 'week',    label: 'Last 7 days' },
        { value: 'all',     label: 'All time' },
      ] },
      count: { type: 'number', min: 1, max: 10, step: 1 },
    },
    render(p) {
      const period = ['tonight', 'week', 'all'].includes(p.period) ? p.period : 'tonight';
      const count = Math.max(1, Math.min(10, parseInt(p.count, 10) || 5));
      return `
<div class="sp-top-songs" data-showpilot-top-songs="${period}" data-count="${count}" style="max-width:560px;margin:1.25rem auto;padding:0 1rem;">
  <h2 style="text-align:center;color:${escapeAttr(p.titleColor)};font-size:clamp(22px,5.5vw,28px);margin:0 0 .6rem;">${formatText(p.title || '')}</h2>
  <ol class="sp-top-songs-list" data-showpilot-top-songs-list style="margin:0;padding:.6rem 1rem .6rem 2.4rem;background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.1);border-radius:10px;text-align:left;line-height:1.7;font-size:clamp(15px,4vw,18px);"></ol>
  <div class="sp-top-songs-empty" data-showpilot-top-songs-empty hidden style="text-align:center;opacity:.75;">No picks yet. Be the first!</div>
</div>`;
    },
  },

  showStats: {
    label: 'Tonight\u2019s Stats',
    description: 'Songs played, requests, votes and visitors tonight. Updates by itself.',
    detect: 'data-showpilot-stats',
    defaultProps: { title: 'Tonight so far', showPlayed: true, showRequests: true, showVotes: true, showVisitors: true, accentColor: '#dc2626' },
    render(p) {
      const tiles = [
        ['played', 'Songs played', p.showPlayed],
        ['requests', 'Requests', p.showRequests],
        ['votes', 'Votes', p.showVotes],
        ['visitors', 'Visitors', p.showVisitors],
      ].filter(t => t[2]);
      if (!tiles.length) return '<!-- (no stats picked) -->';
      const accent = escapeAttr(p.accentColor);
      return `
<div class="sp-stats" data-showpilot-stats style="max-width:560px;margin:1.25rem auto;padding:0 1rem;text-align:center;">
  ${p.title ? `<h2 style="color:${accent};font-size:clamp(22px,5.5vw,28px);margin:0 0 .6rem;">${formatText(p.title)}</h2>` : ''}
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;">
    ${tiles.map(([k, label]) => `<div style="background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:.7rem .4rem;">
      <div data-showpilot-stat="${k}" style="font-size:clamp(24px,7vw,32px);font-weight:800;color:${accent};font-variant-numeric:tabular-nums;">–</div>
      <div style="font-size:.85em;opacity:.85;">${label}</div>
    </div>`).join('')}
  </div>
</div>`;
    },
  },

  sponsors: {
    label: 'Sponsors',
    description: 'A row of sponsor logos, each with an optional link.',
    defaultProps: { title: 'Thank you to our sponsors', logos: [] },
    // logos is a list of { img, link } (v0.33.269+); older pages saved
    // "image address | link" per line.
    propTypes: { logos: { type: 'rows', label: 'Sponsors', addLabel: 'Add a sponsor', fields: [
      { key: 'img', label: 'Logo image address (https://… or /path/on/this/site)' },
      { key: 'link', label: 'Link (optional)' },
    ] } },
    render(p) {
      const rows = listRows(p.logos, ['img', 'link']).map(r => ({
        img: r.img,
        link: r.link && !/^[a-z][a-z0-9+.-]*:/i.test(r.link) ? 'https://' + r.link.replace(/^\/+/, '') : r.link,
      })).filter(r => /^(https?:\/\/|\/)/i.test(r.img));
      if (!rows.length) return '<!-- (add sponsor logos) -->';
      return `
<div class="sp-sponsors" style="max-width:720px;margin:1.5rem auto;padding:0 1rem;text-align:center;">
  ${p.title ? `<div style="font-size:clamp(15px,4vw,18px);font-weight:700;opacity:.9;margin-bottom:.7rem;">${formatText(p.title)}</div>` : ''}
  <div style="display:flex;flex-wrap:wrap;justify-content:center;align-items:center;gap:14px 22px;">
    ${rows.map(r => {
      const img = `<img src="${escapeAttr(r.img)}" alt="" loading="lazy" style="display:block;max-height:56px;max-width:140px;width:auto;height:auto;object-fit:contain;">`;
      return /^https?:\/\//i.test(r.link || '') ? `<a href="${escapeAttr(r.link)}" target="_blank" rel="noopener">${img}</a>` : img;
    }).join('')}
  </div>
</div>`;
    },
  },

  banner: {
    label: 'Banner',
    description: 'A colored announcement bar. Give it dates (12-01 to 12-26 repeats every year) to make seasonal banners that switch by themselves.',
    detect: 'sp-banner',
    defaultProps: {
      text: 'Merry Christmas from our family to yours!',
      subtext: '',
      showFrom: '',
      showUntil: '',
      bgColor: '#b91c1c',
      textColor: '#ffffff',
    },
    render(p) {
      const range = (p.showFrom || p.showUntil)
        ? ` data-showpilot-from="${escapeAttr(p.showFrom || '')}" data-showpilot-until="${escapeAttr(p.showUntil || '')}" hidden`
        : '';
      return `
<div class="sp-banner"${range} style="margin:1rem auto;max-width:720px;padding:0 1rem;">
  <div style="background:${escapeAttr(p.bgColor)};color:${escapeAttr(p.textColor)};border-radius:12px;padding:.9rem 1.1rem;text-align:center;box-shadow:0 4px 14px rgba(0,0,0,.3);">
    <div style="font-weight:800;font-size:clamp(17px,4.6vw,22px);">${formatText(p.text || '')}</div>
    ${p.subtext ? `<div style="margin-top:.25rem;opacity:.92;">${formatText(p.subtext)}</div>` : ''}
  </div>
</div>`;
    },
  },

  customHtml: {
    label: 'Custom HTML',
    description: 'Raw HTML you want to include',
    defaultProps: { html: '<!-- your HTML here -->' },
    render(p) {
      // NOT escaped — this is the whole point of a custom block.
      // User is responsible for valid HTML.
      return p.html || '';
    },
  },
};

function listBlockTypes() {
  return Object.entries(BLOCK_TYPES).map(([type, def]) => ({
    type,
    label: def.label,
    description: def.description,
    defaultProps: def.defaultProps,
    // propTypes (v0.32.10+) — optional per-prop control hints used by
    // the admin block editor. When absent, the editor falls back to
    // auto-inference based on the prop's value (color/bool/long-text/text).
    // Send null when there are no hints so the JSON shape is consistent.
    propTypes: def.propTypes || null,
    // once / detect (v0.33.265): the builders mark blocks already on the
    // page. `detect` is a regex source matched against a custom page's HTML
    // (Sections tab); added blocks also carry <!-- sp-added: Label -->.
    once: !!def.once,
    detect: def.detect || null,
  }));
}

function renderBlocksTemplate(blocks, settings) {
  // settings provides the page-wrapping body styles (bg color, font, etc.)
  const s = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  const bgLayer = s.bgImageUrl
    ? `background-image: url('${escapeAttr(s.bgImageUrl)}'), linear-gradient(180deg, ${escapeAttr(s.bgGradientStart)}, ${escapeAttr(s.bgGradientEnd)});
       background-size: cover; background-position: center; background-attachment: fixed;`
    : `background: linear-gradient(180deg, ${escapeAttr(s.bgGradientStart)}, ${escapeAttr(s.bgGradientEnd)}); background-attachment: fixed;`;

  const blockHtml = (blocks || []).map(b => {
    const def = BLOCK_TYPES[b.type];
    if (!def) return `<!-- unknown block type: ${escapeHtml(b.type)} -->`;
    const props = { ...def.defaultProps, ...(b.props || {}) };
    try { return def.render(props); }
    catch (e) { return `<!-- error rendering ${escapeHtml(b.type)}: ${escapeHtml(e.message)} -->`; }
  }).join('\n');

  // Common shell shared across blocks layouts (CSS for song list, status messages, etc.)
  return `${MANAGED_MARKER_BLOCKS}
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    ${bgLayer}
    color: ${escapeAttr(s.textColor)};
    font-family: ${s.fontFamily};
    min-height: 100vh;
    padding-bottom: 110px;
    overflow-x: hidden;
  }
  /* Song list cards (used by Song List block) */
  #playlists_container, .rtable {
    display: flex; flex-direction: column; gap: 8px;
    margin: 1rem auto; max-width: 720px; padding: 0 1rem;
  }
  .rtable { flex-direction: row; flex-wrap: wrap; gap: 8px 0; align-items: stretch; }
  .cell-vote-playlist, .jukebox-list {
    display: flex; align-items: center; gap: 12px;
    padding: 10px 14px; min-height: 64px;
    background: rgba(0,0,0,0.4); border: 2px solid rgba(255,255,255,0.1);
    border-radius: 10px; color: ${escapeAttr(s.textColor)};
    font-size: clamp(15px, 4vw, 18px); cursor: pointer; line-height: 1.25;
  }
  .cell-vote-playlist { width: calc(100% - 80px); border-radius: 10px 0 0 10px; }
  .cell-vote-playlist:hover, .jukebox-list:hover {
    background: ${escapeAttr(s.primaryColor)}40; border-color: ${escapeAttr(s.primaryColor)};
  }
  .cell-vote {
    display: flex; align-items: center; justify-content: center;
    width: 80px; min-height: 64px; background: ${escapeAttr(s.primaryColor)};
    border-radius: 0 10px 10px 0; color: #fff; font-weight: 700;
    font-size: clamp(18px, 5vw, 22px);
  }
  .sequence-image { width: 48px; height: 48px; border-radius: 6px; object-fit: cover; flex-shrink: 0; }
  .cell-vote-playlist-artist, .jukebox-list-artist {
    display: block; width: 100%; opacity: 0.7; font-size: 0.82em; margin-top: 2px;
  }
  /* Status toasts (v0.32.12+).
     These eight IDs are flipped to display:block by rf-compat.js when
     a corresponding event fires (vote, request, error, etc.). Without
     position:fixed they were rendered as block-level elements at the
     bottom of the document — invisible to most users on a phone.
     Floating them at the top center matches the bundled themed
     templates. */
  #requestSuccessful, #voteSuccessful, #requestFailed, #requestPlaying,
  #queueFull, #alreadyVoted, #invalidLocation, #invalidLocationCode,
  #songPlaying, #songNextUp, #songCooldown, #alreadyRequested {
    position: fixed; top: 18px; left: 50%; transform: translateX(-50%);
    z-index: 10000; max-width: min(480px, calc(100vw - 32px));
    width: max-content; cursor: pointer;
    box-shadow: 0 6px 22px rgba(0,0,0,0.4);
    border-radius: 8px;
    animation: ofToastDrop 0.3s ease-out;
  }
  @keyframes ofToastDrop {
    from { transform: translate(-50%, -16px); opacity: 0; }
    to   { transform: translate(-50%, 0); opacity: 1; }
  }
  /* Reset inner-box margins since the outer div now handles positioning. */
  #requestSuccessful .innerRequestSuccessful,
  #voteSuccessful .innerRequestSuccessful,
  #requestFailed .failed_Info_Box,
  #requestPlaying .failed_Info_Box,
  #queueFull .failed_Info_Box,
  #alreadyVoted .failed_Info_Box,
  #invalidLocation .failed_Info_Box,
  #invalidLocationCode .failed_Info_Box,
  #songPlaying .failed_Info_Box, #songNextUp .failed_Info_Box,
  #songCooldown .failed_Info_Box, #alreadyRequested .failed_Info_Box {
    margin: 0; max-width: none;
  }
  .innerRequestSuccessful, .failed_Info_Box {
    margin: 1rem auto; max-width: 600px; padding: 0.85rem 1rem;
    border-radius: 8px; text-align: center; font-weight: 600;
  }
  .innerRequestSuccessful { background: #16a34a; color: #fff; }
  .failed_Info_Box { background: #ea580c; color: #fff; }
  @media (max-width: 480px) {
    .cell-vote-playlist { width: calc(100% - 60px); padding: 8px 10px; min-height: 56px; gap: 8px; }
    .cell-vote { width: 60px; min-height: 56px; }
    .sequence-image { width: 40px; height: 40px; }
  }
</style>
<meta name="viewport" content="width=device-width, initial-scale=1.0">

${blockHtml}

<!-- Status messages — required by client JS -->
<div id="requestSuccessful" style="display:none"><div class="innerRequestSuccessful">Successfully Added!</div></div>
<div id="voteSuccessful" style="display:none"><div class="innerRequestSuccessful">You've Successfully Voted! 🗳️</div></div>
<div id="requestFailed" style="display:none"><div class="failed_Info_Box">An unexpected error has occurred.</div></div>
<div id="requestPlaying" style="display:none"><div class="failed_Info_Box">SONG ALREADY REQUESTED</div></div>
<div id="queueFull" style="display:none"><div class="failed_Info_Box">QUEUE FULL — max {QUEUE_DEPTH}</div></div>
<div id="invalidLocation" style="display:none"><div class="failed_Info_Box">INVALID LOCATION</div></div>
<div id="alreadyVoted" style="display:none"><div class="failed_Info_Box">ALREADY VOTED</div></div>
<div id="invalidLocationCode" style="display:none"><div class="failed_Info_Box">INVALID CODE</div></div>
<div id="songPlaying" style="display:none"><div class="failed_Info_Box">SONG IS CURRENTLY PLAYING</div></div>
<div id="songNextUp" style="display:none"><div class="failed_Info_Box">SONG IS ALREADY NEXT UP</div></div>
<div id="songCooldown" style="display:none"><div class="failed_Info_Box">JUST PLAYED — back <span data-showpilot-cooldown-text>soon</span></div></div>
<div id="alreadyRequested" style="display:none"><div class="failed_Info_Box">YOU ALREADY HAVE A REQUEST IN — wait for it to play</div></div>
`;
}

// Detect if a template's HTML was generated by the visual designer
function detectMode(html) {
  if (!html) return 'code';
  if (html.includes(MANAGED_MARKER_SETTINGS)) return 'settings';
  if (html.includes(MANAGED_MARKER_BLOCKS)) return 'blocks';
  return 'code';
}

module.exports = {
  formatText,
  DEFAULT_SETTINGS,
  BLOCK_TYPES,
  listBlockTypes,
  renderSettingsTemplate,
  renderBlocksTemplate,
  detectMode,
  MANAGED_MARKER_SETTINGS,
  MANAGED_MARKER_BLOCKS,
};
