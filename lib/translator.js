// lib/translator.js — Viewer page translation engine (v0.33.181+)
//
// Translates rendered viewer page HTML into the viewer's browser language.
// Uses MyMemory (free, no key) by default. LibreTranslate (self-hosted)
// and DeepL (free tier) are also supported.
//
// Flow:
//   1. Check SQLite cache — if hit, return immediately
//   2. Split HTML into text tokens using a capturing regex split
//      so tags and text nodes alternate predictably
//   3. Skip text inside script/style/noscript and data-content elements
//   4. Translate unique strings via backend API (concurrent requests)
//   5. Walk the same token list, replacing matching text nodes
//   6. Cache the result keyed by (template_id, lang, content_hash)

'use strict';

const { db } = require('./db');
const https = require('https');
const http = require('http');
const { createHash } = require('crypto');

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function getCachedTranslation(templateId, lang, contentHash) {
  // Look up by (template_id, lang) only — contentHash is used for
  // invalidation: if the stored hash differs from the current template
  // hash, the cache entry is stale and we retranslate.
  const row = db.prepare(`
    SELECT translated_html, content_hash FROM translation_cache
    WHERE template_id = ? AND lang = ? LIMIT 1
  `).get(templateId, lang);
  if (!row) return null;
  // Stale if template was edited (hash changed)
  if (row.content_hash !== contentHash) return null;
  return row.translated_html;
}

function setCachedTranslation(templateId, lang, contentHash, translatedHtml) {
  db.prepare(`
    INSERT INTO translation_cache (template_id, lang, content_hash, translated_html, cached_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(template_id, lang) DO UPDATE SET
      content_hash    = excluded.content_hash,
      translated_html = excluded.translated_html,
      cached_at       = CURRENT_TIMESTAMP
  `).run(templateId, lang, contentHash, translatedHtml);
}

function clearTranslationCache(templateId) {
  if (templateId) {
    db.prepare(`DELETE FROM translation_cache WHERE template_id = ?`).run(templateId);
  } else {
    db.prepare(`DELETE FROM translation_cache`).run();
  }
}

function getTranslationCacheStats() {
  return db.prepare(`
    SELECT template_id, lang, cached_at, LENGTH(translated_html) AS size_bytes
    FROM translation_cache ORDER BY cached_at DESC
  `).all();
}

// ---------------------------------------------------------------------------
// Skip lists — elements whose text content should never be translated
// ---------------------------------------------------------------------------

// CSS class fragments indicating data content (sequence names, artists, etc.)
const SKIP_CLASS_FRAGS = [
  'sequence-name', 'sequence-artist', 'jukebox-list-artist',
  'cell-vote-playlist-artist', 'now-playing-image',
];

// Data attributes marking live data elements
const SKIP_DATA_ATTRS = [
  'data-showpilot-now', 'data-showpilot-next', 'data-showpilot-queue',
  'data-showpilot-timer', 'data-showpilot-now-img',
  'data-seq', 'data-seq-count', 'data-seq-votes',
];

function isSkipTag(tagStr) {
  // Raw content tags — everything inside is code/markup, not UI text
  const m = tagStr.match(/^<\/?([a-zA-Z][a-zA-Z0-9]*)/);
  if (!m) return false;
  const t = m[1].toLowerCase();
  return t === 'script' || t === 'style' || t === 'noscript';
}

function hasSkipMarker(tagStr) {
  const cm = tagStr.match(/\bclass=["']([^"']*)["']/i);
  if (cm && SKIP_CLASS_FRAGS.some(f => cm[1].includes(f))) return true;
  return SKIP_DATA_ATTRS.some(a => tagStr.includes(a));
}

// Decode common HTML entities so extracted strings match what's
// visually in the page. The template stores &mdash; but the text node
// token is &mdash; — MyMemory sees the decoded form when we send it,
// so we need to match on the decoded form in splice too.
const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  '&mdash;': '\u2014', '&ndash;': '\u2013', '&middot;': '\u00b7',
  '&hellip;': '\u2026', '&nbsp;': '\u00a0', '&laquo;': '\u00ab',
  '&raquo;': '\u00bb', '&copy;': '\u00a9', '&reg;': '\u00ae',
  '&trade;': '\u2122', '&bull;': '\u2022', '&larr;': '\u2190',
  '&rarr;': '\u2192', '&uarr;': '\u2191', '&darr;': '\u2193',
};
function decodeEntities(str) {
  return str
    .replace(/&[a-z]+;/gi, e => ENTITIES[e.toLowerCase()] || e)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function shouldSkip(text) {
  const t = text.trim();
  if (t.length < 2) return true;
  if (/^\d+$/.test(t)) return true;           // pure numbers
  if (!/[a-zA-ZÀ-ÿ]/.test(t)) return true;   // no letters at all
  return false;
}

// ---------------------------------------------------------------------------
// Token helpers
//
// We split the HTML with a CAPTURING regex so the array alternates:
//   [text, tag, text, tag, text, ...]
// index 0, 2, 4, ... are text nodes (may be empty)
// index 1, 3, 5, ... are tags (including <script>...</script> blobs)
//
// We pre-collapse script/style/noscript blocks into empty markers so
// their inner text never appears as a text token.
// ---------------------------------------------------------------------------

function tokenize(html) {
  // Collapse raw-text blocks first so their content is invisible
  const clean = html
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '<script></script>')
    .replace(/<style[\s\S]*?<\/style\s*>/gi,   '<style></style>')
    .replace(/<noscript[\s\S]*?<\/noscript\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  // Split into alternating [text, tag, text, tag, ...]
  return clean.split(/(<[^>]*>)/);
}

// ---------------------------------------------------------------------------
// Extract unique translatable text nodes
// ---------------------------------------------------------------------------

function extractStrings(html) {
  const tokens = tokenize(html);
  const unique = new Map();
  let skipDepth = 0;

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok) continue;

    if (tok.startsWith('<')) {
      // Tag token
      const isClose = tok.startsWith('</');
      if (isSkipTag(tok)) {
        // script/style/noscript — already collapsed to empty, but track depth
        if (isClose) { if (skipDepth > 0) skipDepth--; }
        else { skipDepth++; }
        continue;
      }
      if (isClose) {
        if (skipDepth > 0) skipDepth--;
      } else {
        const selfClose = tok.endsWith('/>') ||
          /^<(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)\b/i.test(tok);
        if (!selfClose && hasSkipMarker(tok)) skipDepth++;
      }
      continue;
    }

    // Text token
    if (skipDepth > 0) continue;
    const raw = tok.trim();
    const text = decodeEntities(raw);
    if (!shouldSkip(text) && !unique.has(text)) {
      unique.set(text, unique.size);
    }
  }

  return unique;
}

// ---------------------------------------------------------------------------
// Splice translated strings back
// Uses the ORIGINAL html (not tokenized version) but the same split logic
// so text-node boundaries are identical to what extractStrings saw.
// ---------------------------------------------------------------------------

function spliceStrings(html, translations) {
  if (translations.size === 0) return html;

  // Strategy: work on the same collapsed HTML that extractStrings used,
  // but track character offsets back to the original so we can splice
  // translations into the right positions.
  //
  // Simpler equivalent: collapse raw blocks in both, split both the same
  // way, replace in collapsed, then restore raw blocks from original.
  //
  // Even simpler: since we know every translatable string appears ONLY
  // as a text node (between > and <), we can do a direct regex replace
  // that is anchored to that context — no token splitting needed.
  // The regex >(\s*)(ORIGINAL)(\s*)< matches only text-node occurrences.

  let result = html;

  for (const [original, translated] of translations) {
    if (!original || !translated || original === translated) continue;

    // Escape original for use in regex
    const esc = original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Also build entity-encoded version of original in case the HTML
    // uses entities where we decoded to literals during extraction
    const entityEsc = original
      .replace(/&/g, '&amp;')
      .replace(/—/g, '&mdash;')
      .replace(/–/g, '&ndash;')
      .replace(/·/g, '&middot;')
      .replace(/…/g, '&hellip;')
      .replace(/\u00a0/g, '&nbsp;')
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Replace both the decoded and entity forms, anchored to text-node context
    for (const pattern of [esc, entityEsc]) {
      if (pattern === esc && esc === entityEsc) {
        result = result.replace(
          new RegExp('(>[ \\t\\n\\r]*)(' + pattern + ')([ \\t\\n\\r]*<)', 'g'),
          (_, before, _orig, after) => before + translated + after
        );
        break;
      }
      result = result.replace(
        new RegExp('(>[ \\t\\n\\r]*)(' + pattern + ')([ \\t\\n\\r]*<)', 'g'),
        (_, before, _orig, after) => before + translated + after
      );
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: { Accept: 'application/json' },
    }, res => {
      let buf = '';
      res.on('data', c => { buf += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) reject(new Error(`HTTP ${res.statusCode}: ${buf.slice(0, 200)}`));
        else { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('Timeout')));
  });
}

function httpPost(url, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const data = JSON.stringify(body);
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
    }, res => {
      let buf = '';
      res.on('data', c => { buf += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) reject(new Error(`HTTP ${res.statusCode}: ${buf.slice(0, 200)}`));
        else { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('Timeout')));
    req.write(data);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Translation backends
// ---------------------------------------------------------------------------

async function translateBatchMyMemory(strings, targetLang) {
  const CONCURRENCY = 5;
  const results = new Array(strings.length);
  const langpair = `en|${targetLang}`;
  for (let i = 0; i < strings.length; i += CONCURRENCY) {
    const slice = strings.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(slice.map(str =>
      httpGet(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(str)}&langpair=${encodeURIComponent(langpair)}`)
    ));
    settled.forEach((r, j) => {
      if (r.status === 'fulfilled') {
        const t = r.value?.responseData?.translatedText;
        results[i + j] = (t && t !== strings[i + j]) ? t : strings[i + j];
      } else {
        results[i + j] = strings[i + j];
      }
    });
  }
  return results;
}

async function translateBatchLibre(strings, targetLang, apiUrl, apiKey) {
  const results = [];
  const BATCH = 50;
  for (let i = 0; i < strings.length; i += BATCH) {
    const batch = strings.slice(i, i + BATCH);
    const body = { q: batch, source: 'auto', target: targetLang, format: 'text' };
    if (apiKey) body.api_key = apiKey;
    const data = await httpPost((apiUrl || 'https://libretranslate.com') + '/translate', body);
    if (Array.isArray(data)) results.push(...data.map(r => r.translatedText || ''));
    else if (data.translatedText) results.push(data.translatedText);
    else throw new Error('Unexpected LibreTranslate response');
  }
  return results;
}

async function translateBatchDeepL(strings, targetLang, apiKey) {
  const results = [];
  const BATCH = 50;
  const deeplLang = targetLang.toUpperCase();
  for (let i = 0; i < strings.length; i += BATCH) {
    const batch = strings.slice(i, i + BATCH);
    const data = await httpPost('https://api-free.deepl.com/v2/translate',
      { text: batch, target_lang: deeplLang },
      { Authorization: `DeepL-Auth-Key ${apiKey}` }
    );
    if (data.translations) results.push(...data.translations.map(t => t.text));
    else throw new Error('Unexpected DeepL response');
  }
  return results;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

// templateHash: hash of the raw template HTML (before state substitution).
// Keying on this instead of the rendered HTML means one cache entry per
// template per language, regardless of mode/state/queue changes.
// Falls back to hashing the rendered html if templateHash isn't provided.
async function translateHtml(html, targetLang, templateId, cfg, templateHash) {
  const lang = (targetLang || '').split('-')[0].toLowerCase();
  if (!lang || lang === 'en' || cfg.translation_enabled !== 1) return html;

  const contentHash = templateHash ||
    createHash('sha256').update(html).digest('hex').slice(0, 16);
  const cached = getCachedTranslation(templateId || 0, lang, contentHash);
  if (cached) {
    console.log(`[translator] cache hit: template ${templateId}, lang=${lang}`);
    return cached;
  }

  console.log(`[translator] translating template ${templateId} → ${lang}`);

  const stringMap = extractStrings(html);
  const originals = [...stringMap.keys()];
  console.log(`[translator] extracted ${originals.length} strings:`, JSON.stringify(originals.slice(0, 6)));

  if (originals.length === 0) return html;

  const backend = cfg.translation_backend || 'mymemory';
  console.log(`[translator] backend: ${backend}`);

  let translated;
  try {
    const apiUrl = cfg.translation_api_url || '';
    const apiKey = cfg.translation_api_key || '';
    if (backend === 'deepl') {
      translated = await translateBatchDeepL(originals, lang, apiKey);
    } else if (backend === 'libretranslate') {
      translated = await translateBatchLibre(originals, lang, apiUrl, apiKey);
    } else {
      translated = await translateBatchMyMemory(originals, lang);
    }
  } catch (err) {
    console.error('[translator] backend error, serving original:', err.message);
    return html;
  }

  const translationMap = new Map();
  originals.forEach((orig, i) => {
    if (translated[i] && translated[i] !== orig) translationMap.set(orig, translated[i]);
  });

  console.log(`[translator] done: ${translationMap.size}/${originals.length} translated`);

  const translatedHtml = spliceStrings(html, translationMap);

  let spliced = 0;
  for (const orig of translationMap.keys()) {
    if (!translatedHtml.includes(orig)) spliced++;
  }
  console.log(`[translator] splice: ${spliced}/${translationMap.size} originals replaced`);

  setCachedTranslation(templateId || 0, lang, contentHash, translatedHtml);
  return translatedHtml;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

// Migrate any existing 'libretranslate' backend to 'mymemory' since the
// public LibreTranslate API now requires a paid key.
function migrateLegacyBackend() {
  try {
    const row = db.prepare(`SELECT translation_backend FROM config WHERE id = 1`).get();
    if (row && row.translation_backend === 'libretranslate') {
      db.prepare(`UPDATE config SET translation_backend = 'mymemory' WHERE id = 1`).run();
      console.log('[translator] migrated translation_backend: libretranslate → mymemory');
    }
  } catch (_) {}
}
migrateLegacyBackend();

function parseAcceptLanguage(header) {
  if (!header) return [];
  return header
    .split(',')
    .map(part => {
      const [lang, q] = part.trim().split(';q=');
      return { lang: lang.trim(), q: q ? parseFloat(q) : 1.0 };
    })
    .sort((a, b) => b.q - a.q)
    .map(e => e.lang.split('-')[0].toLowerCase())
    .filter(l => l && l !== 'en' && /^[a-z]{2,3}$/.test(l));
}

module.exports = {
  translateHtml,
  parseAcceptLanguage,
  clearTranslationCache,
  getTranslationCacheStats,
};
