'use strict';
// ============================================================
// Garbled sequence names ("mojibake") — v0.33.256+ / Lite v0.5.98+
// ============================================================
// A file name like "Idina Menzel – Christmas Just Ain't Christmas" (en dash)
// sent as raw UTF-8 bytes and read as Latin-1 / Windows-1252 turns into
// "Idina Menzel â€“ Christmas…" (or â + two invisible control characters).
// Show players that stored such a name and later fix it report the correct
// name on the next playlist sync. Matched by exact name, the corrected song
// would arrive as a NEW sequence and the old row (display name, artist,
// cover, category, play history) would go inactive.
//
// fix(s) turns garbled text back into what was meant, and only that: each
// character is mapped back to its byte (Latin-1, or the Windows-1252
// characters for 0x80-0x9F) and the bytes must form valid UTF-8 with at
// least one multi-byte character. "Café", "Señor" etc. are never changed.
//
// adoptRenamed(db, names) renames such rows to the incoming correct name
// (with their votes, queue, history and snapshot entries) before the sync
// upserts, so everything set up for the song stays with it.
// All SQL here is static (no string-built queries), as Lite requires.
//
// This file is byte-identical between ShowPilot and ShowPilot-Lite.
// ============================================================

const CP1252 = {
  '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a,
  '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97,
  '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f,
};
const decoder = new TextDecoder('utf-8', { fatal: true });

function fix(s) {
  if (typeof s !== 'string' || !/[Â-ô]/.test(s)) return s;
  const bytes = [];
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c <= 0xff) bytes.push(c);
    else if (CP1252[ch] !== undefined) bytes.push(CP1252[ch]);
    else return s;
  }
  let out;
  try { out = decoder.decode(Uint8Array.from(bytes)); } catch { return s; }
  return out !== s && /[^\x00-\x7f]/.test(out) ? out : s;
}

// Tables that refer to a sequence by name (besides sequences itself).
const RENAMES = [
  'UPDATE play_history SET sequence_name = ? WHERE sequence_name = ?',
  'UPDATE vote_log SET sequence_name = ? WHERE sequence_name = ?',
  'UPDATE votes SET sequence_name = ? WHERE sequence_name = ?',
  'UPDATE tiebreak_votes SET sequence_name = ? WHERE sequence_name = ?',
  'UPDATE race_taps SET sequence_name = ? WHERE sequence_name = ?',
  'UPDATE jukebox_queue SET sequence_name = ? WHERE sequence_name = ?',
  'UPDATE sequence_snapshot_items SET name = ? WHERE name = ?',
];

// Returns [{ from, to }] for each row renamed. Call inside the sync's
// transaction, before the upserts. A garbled row is only renamed when no
// row already has the correct name.
function adoptRenamed(db, incomingNames) {
  const wanted = new Set((incomingNames || []).map((n) => String(n || '').trim()).filter(Boolean));
  if (!wanted.size) return [];
  const rows = db.prepare('SELECT id, name, display_name FROM sequences').all();
  const existing = new Set(rows.map((r) => r.name));
  const renamed = [];
  const setName = db.prepare('UPDATE sequences SET name = ? WHERE id = ?');
  const setDisplay = db.prepare('UPDATE sequences SET display_name = ? WHERE id = ?');
  const others = [];
  for (const sql of RENAMES) { try { others.push(db.prepare(sql)); } catch (_) { /* table not in this edition */ } }
  for (const r of rows) {
    const good = fix(r.name);
    if (good === r.name || !wanted.has(good) || existing.has(good)) continue;
    setName.run(good, r.id);
    // A display name that was just the garbled name (or its garbled default) is fixed too.
    const fixedDisplay = fix(r.display_name || '');
    if (fixedDisplay !== (r.display_name || '')) setDisplay.run(fixedDisplay, r.id);
    for (const st of others) st.run(good, r.name);
    existing.delete(r.name);
    existing.add(good);
    renamed.push({ from: r.name, to: good });
  }
  return renamed;
}

module.exports = { fix, adoptRenamed };
