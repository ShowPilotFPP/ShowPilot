// ============================================================
// Sequence list CSV import / export (v0.33.247+)
// ============================================================
// Two layouts:
//
//   rf        — Remote Falcon's own export, column for column:
//               name,displayName,artist,group,imageUrl,category
//   showpilot — the same six columns first (so the file still opens
//               anywhere the RF layout does), then everything else a
//               ShowPilot sequence carries:
//               visible,votable,jukeboxable,psa,cooldownMinutes,active,badge
//
// Import accepts either layout (columns are matched by header name, in any
// order, case-insensitive) and matches rows to sequences by `name`, the
// show player's sequence name. A blank cell never overwrites a value, so a
// Remote Falcon file with no artist doesn't wipe artists ShowPilot already
// has. `group` is read but ignored (ShowPilot has no sequence groups) and
// `active` is export-only: the playlist sync decides what is active.
//
// Remote Falcon prefixes a cell that starts with = + - or @ with an
// apostrophe so spreadsheets don't treat it as a formula ("'- Just Lights -").
// Export does the same; import strips it again.
// ============================================================

const FORMULA_START = /^[=+\-@]/;

function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (FORMULA_START.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

// RFC 4180 parser: quoted fields, "" escapes, commas/newlines inside
// quotes, CRLF or LF line ends, optional UTF-8 BOM. Returns an array of
// rows (arrays of strings); fully blank lines are dropped.
function parseCsv(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  return rows;
}

function unguard(s) {
  const v = String(s || '').trim();
  return v.length > 1 && v[0] === "'" && FORMULA_START.test(v.slice(1)) ? v.slice(1) : v;
}

// Header aliases → internal key.
const HEADER_KEYS = {
  name: 'name', sequencename: 'name', sequence: 'name',
  displayname: 'display_name',
  artist: 'artist',
  group: 'group',
  imageurl: 'image_url', image: 'image_url', cover: 'image_url',
  category: 'category',
  visible: 'visible',
  votable: 'votable', vote: 'votable',
  jukeboxable: 'jukeboxable', jukebox: 'jukeboxable',
  psa: 'is_psa', ispsa: 'is_psa',
  cooldownminutes: 'cooldown_minutes', cooldown: 'cooldown_minutes',
  active: 'active',
  badge: 'badge',
};
const TOGGLES = ['visible', 'votable', 'jukeboxable', 'is_psa'];

function parseBool(v) {
  const s = String(v || '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return 1;
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return 0;
  return null;
}

// Turn CSV text into normalized records: { name, display_name?, artist?,
// image_url?, category?, visible?, votable?, jukeboxable?, is_psa?,
// cooldown_minutes? } — keys only present when the cell had a usable value.
function readRecords(text) {
  const rows = parseCsv(text);
  if (!rows.length) throw new Error('The file is empty.');
  const header = rows[0].map((h) => HEADER_KEYS[String(h).trim().toLowerCase().replace(/[\s_-]/g, '')] || null);
  if (!header.includes('name')) {
    throw new Error('No "name" column found. Use a ShowPilot or Remote Falcon sequence export.');
  }
  const records = [];
  const seen = new Set();
  for (const r of rows.slice(1)) {
    const rec = {};
    header.forEach((key, i) => {
      if (!key || key === 'group' || key === 'active') return;
      const raw = unguard(r[i]);
      if (raw === '') return;
      if (TOGGLES.includes(key)) {
        const b = parseBool(raw);
        if (b !== null) rec[key] = b;
      } else if (key === 'cooldown_minutes') {
        const n = parseInt(raw, 10);
        if (Number.isFinite(n)) rec[key] = Math.max(0, Math.min(1440, n));
      } else {
        rec[key] = raw;
      }
    });
    if (!rec.name) continue;
    const k = rec.name.toLowerCase();
    if (seen.has(k)) continue; // first row for a name wins
    seen.add(k);
    records.push(rec);
  }
  return records;
}

// rows: sequences from the DB. absUrl(path) turns /covers/... into a full URL.
function buildCsv(rows, format, absUrl) {
  const rf = format === 'rf';
  const cols = ['name', 'displayName', 'artist', 'group', 'imageUrl', 'category'];
  if (!rf) cols.push('visible', 'votable', 'jukeboxable', 'psa', 'cooldownMinutes', 'active', 'badge');
  const lines = [cols.join(',')];
  for (const s of rows) {
    const img = s.image_url ? String(s.image_url).split('?')[0] : '';
    const cells = [s.name, s.display_name, s.artist, '', img && img.startsWith('/') ? absUrl(img) : img, s.category];
    if (!rf) {
      cells.push(s.visible ? 1 : 0, s.votable ? 1 : 0, s.jukeboxable ? 1 : 0, s.is_psa ? 1 : 0,
        s.cooldown_minutes || 0, s.active === 0 ? 0 : 1, s.badge || '');
    }
    lines.push(cells.map(csvCell).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

module.exports = { parseCsv, readRecords, buildCsv };
