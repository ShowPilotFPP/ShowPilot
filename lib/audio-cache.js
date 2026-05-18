// ============================================================
// ShowPilot — Audio Cache
// ============================================================
// Stores audio files locally so viewer requests can be served from
// ShowPilot's disk instead of proxying every request through FPP. This
// solves three problems at once:
//
//   1. SCALE — FPP runs on a Pi with an SD card. Many concurrent reads
//      of the same audio file thrash the SD card controller, causing
//      stalls for viewers. ShowPilot can be on real hardware (NUC, NAS,
//      LXC) where concurrent reads come from page cache or NVMe.
//
//   2. LATENCY — Viewer audio start no longer requires a cross-network
//      hop to FPP. First-byte latency drops from ~500-1500ms to
//      ~50-100ms.
//
//   3. INDEPENDENCE — Once cached, audio plays even if FPP is briefly
//      unreachable (network blip, FPP restart). Viewers don't notice.
//
// Storage layout:
//
//   data/audio-cache/<sha256>.bin       — content-addressed audio file
//   audio_cache_files (DB table)        — sha256 → media_name mapping
//
// Files are content-addressed by hash. Two sequences sharing the same
// audio file (e.g. a song and its alternate-light-show pairing) share
// one cache entry. Renaming a sequence on FPP doesn't invalidate the
// cache — same hash means same bytes.
//
// Lifecycle:
//   1. Plugin computes hashes of FPP music files during sync.
//   2. Plugin asks /audio-cache/manifest what hashes ShowPilot has.
//   3. Plugin uploads missing files to /audio-cache/upload.
//   4. Plugin posts mediaName → hash links to /audio-cache/link.
//   5. /api/audio-stream/<seq> serves from cache, falls back to FPP
//      proxy when not cached.
// ============================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db } = require('./db');

// Resolve the cache directory relative to the data dir. We piggyback on
// dbPath the same way secret-store does — wherever the SQLite DB lives,
// audio cache lives next to it.
function cacheDir() {
  const config = require('./config-loader');
  const dbPath = config.dbPath || './data/showpilot.db';
  const projectRoot = path.resolve(__dirname, '..');
  const dataDir = path.isAbsolute(dbPath)
    ? path.dirname(dbPath)
    : path.resolve(projectRoot, path.dirname(dbPath));
  const dir = path.join(dataDir, 'audio-cache');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* exists */ }
  return dir;
}

// Path to a cached file given its hash. Hash MUST be already validated
// (hex, 64 chars) before being passed here — we don't sanitize, callers
// do.
function pathForHash(hash) {
  return path.join(cacheDir(), `${hash}.bin`);
}

// Validate a hex SHA-256 string. The plugin sends hashes; we want to
// reject anything that isn't exactly 64 lowercase hex chars before
// using it as a filename or DB key. Defense against path traversal.
function isValidHash(s) {
  return typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
}

// Compute the SHA-256 of a Buffer. Used at upload time to verify the
// plugin's hash claim matches the bytes we received.
function hashBuffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Get the list of all hashes currently in the cache. Used by the manifest
// endpoint so the plugin can compute the diff (what to upload).
function getCachedHashes() {
  const rows = db.prepare(`SELECT hash FROM audio_cache_files`).all();
  return rows.map(r => r.hash);
}

// Look up the cached file path for a given media_name. Returns null if
// not cached. Used by /api/audio-stream when serving viewer requests.
function getCachedPathForMediaName(mediaName) {
  const row = db.prepare(`
    SELECT hash FROM audio_cache_files WHERE media_name = ? LIMIT 1
  `).get(mediaName);
  if (!row) return null;
  const filePath = pathForHash(row.hash);
  // Sanity check: DB says we have it, but did the file get deleted out
  // from under us? Return null if so — caller can fall back to FPP proxy.
  // Don't auto-clean the orphan DB row here; that happens in the periodic
  // verifier (or on next plugin sync, whichever comes first).
  if (!fs.existsSync(filePath)) return null;
  return filePath;
}

// Same as getCachedPathForMediaName but also returns the stored MIME
// type so the audio-stream route can set the correct Content-Type
// header. Important for video-extracted audio (M4A/AAC) — without
// the right MIME the browser won't decode it correctly. Returns
// { path, mimeType } or null when not cached.
function getCachedFileForMediaName(mediaName, lang) {
  // When a language is requested, try that language first, then fall back
  // to 'default'. This lets shows work normally for viewers who don't pick
  // a language while still serving variants to those who do.
  const targetLang = lang && lang !== 'default' ? lang : 'default';
  if (targetLang !== 'default') {
    const langRow = db.prepare(`
      SELECT hash, mime_type FROM audio_cache_files
      WHERE media_name = ? AND language = ? LIMIT 1
    `).get(mediaName, targetLang);
    if (langRow) {
      const langPath = pathForHash(langRow.hash);
      if (fs.existsSync(langPath)) {
        return { path: langPath, mimeType: langRow.mime_type || 'audio/mpeg', hash: langRow.hash, language: targetLang };
      }
    }
    // Fall through to default if variant file missing from disk
  }
  const row = db.prepare(`
    SELECT hash, mime_type FROM audio_cache_files
    WHERE media_name = ? AND language = 'default' LIMIT 1
  `).get(mediaName);
  // Legacy rows (before language column) have language='default' after backfill,
  // but if for any reason a row has language IS NULL, catch it with a fallback.
  const fallback = row || db.prepare(`
    SELECT hash, mime_type FROM audio_cache_files WHERE media_name = ? LIMIT 1
  `).get(mediaName);
  if (!fallback) return null;
  const filePath = pathForHash(fallback.hash);
  if (!fs.existsSync(filePath)) return null;
  return { path: filePath, mimeType: fallback.mime_type || 'audio/mpeg', hash: fallback.hash, language: 'default' };
}

// Return the list of language codes available for a given sequence name.
// Always includes 'default' when the primary track exists. Used by
// /api/now-playing-audio so rf-compat knows whether to show the language picker.
function getLanguagesForSequence(sequenceName) {
  const seq = db.prepare(
    `SELECT audio_hash, media_name FROM sequences WHERE name = ? COLLATE NOCASE`
  ).get(sequenceName);
  if (!seq || (!seq.audio_hash && !seq.media_name)) return [];

  // Resolve to mediaName — language rows are keyed by media_name
  const mediaName = seq.media_name;
  if (!mediaName) return [];

  const rows = db.prepare(`
    SELECT DISTINCT language FROM audio_cache_files
    WHERE media_name = ? AND language IS NOT NULL
    ORDER BY language
  `).all(mediaName);
  return rows.map(r => r.language).filter(Boolean);
}

// Store a language variant uploaded manually by the admin. Unlike
// storeUploadedFile (used by the FPP plugin), this does NOT clear
// other rows with the same media_name — language variants coexist.
// Overwrites a prior row with the same (hash, language) pair.
function storeLanguageFile(buf, claimedHash, mediaName, lang, mimeType) {
  if (!isValidHash(claimedHash)) throw new Error('Invalid hash format');
  if (!lang || lang.length > 10 || !/^[a-z]{2,10}$/.test(lang)) {
    throw new Error('Language must be 2-10 lowercase letters (e.g. "es", "fr", "de")');
  }
  const actualHash = hashBuffer(buf);
  if (actualHash !== claimedHash) {
    throw new Error(`Hash mismatch: claimed ${claimedHash}, actual ${actualHash}`);
  }
  const filePath = pathForHash(claimedHash);
  fs.writeFileSync(filePath, buf);

  // Upsert keyed on (media_name, language) — the new unique constraint.
  // Same hash can appear in multiple rows (e.g. default + a language variant
  // that happens to use the same file). The UNIQUE constraint is on the
  // (media_name, language) pair, not on hash.
  db.prepare(`
    INSERT INTO audio_cache_files (hash, media_name, size_bytes, mime_type, language, cached_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(media_name, language) DO UPDATE SET
      hash       = excluded.hash,
      size_bytes = excluded.size_bytes,
      mime_type  = excluded.mime_type,
      cached_at  = CURRENT_TIMESTAMP
  `).run(claimedHash, mediaName, buf.length, mimeType || 'audio/mpeg', lang);

  return filePath;
}

// Delete a language variant row (and its disk file if no other row
// references the same hash).
function deleteLanguageFile(mediaName, lang) {
  if (!lang || lang === 'default') throw new Error('Cannot delete the default track via language delete');
  const row = db.prepare(`
    SELECT hash FROM audio_cache_files WHERE media_name = ? AND language = ? LIMIT 1
  `).get(mediaName, lang);
  if (!row) return false;

  // Remove DB row
  db.prepare(`DELETE FROM audio_cache_files WHERE media_name = ? AND language = ?`)
    .run(mediaName, lang);

  // Remove disk file only if no other row references this hash
  const stillUsed = db.prepare(`SELECT 1 FROM audio_cache_files WHERE hash = ? LIMIT 1`).get(row.hash);
  if (!stillUsed) {
    try { fs.unlinkSync(pathForHash(row.hash)); } catch (_) {}
  }
  return true;
}

// Hash-based lookup (v0.24.3+). Sequences store their audio file's hash
// directly in sequences.audio_hash; this resolves that hash to a cached
// file path. The advantage over getCachedFileForMediaName: many
// sequences can share the same hash (legitimately — e.g. "indoor +
// outdoor lights" and "outdoor only" sequences using the same MP3),
// and this lookup serves them all from the single shared cache row.
function getCachedFileByHash(hash) {
  if (!hash || !isValidHash(hash)) return null;
  const row = db.prepare(`
    SELECT mime_type FROM audio_cache_files WHERE hash = ? LIMIT 1
  `).get(hash);
  if (!row) return null;
  const filePath = pathForHash(hash);
  if (!fs.existsSync(filePath)) return null;
  return { path: filePath, mimeType: row.mime_type || 'audio/mpeg', hash };
}

// Look up the cache file for a sequence by its name. Accepts an optional
// language code (e.g. 'es'). When lang is provided and a matching variant
// exists, that file is returned; otherwise falls back to the default track.
// Resolves the sequence's audio_hash for the default path; language variants
// are always looked up by media_name since the plugin only sets audio_hash
// for the primary/default track.
function getCachedFileForSequence(sequenceName, lang) {
  const seq = db.prepare(
    `SELECT audio_hash, media_name FROM sequences WHERE name = ? COLLATE NOCASE`
  ).get(sequenceName);
  if (!seq) return null;

  // Language variant path — always via media_name since variants are stored
  // with explicit language tags, not via sequences.audio_hash.
  if (lang && lang !== 'default' && seq.media_name) {
    const variant = getCachedFileForMediaName(seq.media_name, lang);
    if (variant) return variant;
    // If requested variant isn't found, fall through to default below.
  }

  // Default track: prefer audio_hash lookup (faster, many-to-one safe).
  if (seq.audio_hash) {
    const byHash = getCachedFileByHash(seq.audio_hash);
    if (byHash) return byHash;
  }
  // Legacy fallback — old installs that haven't re-synced will keep
  // working by media_name lookup until the next sync sets audio_hash.
  if (seq.media_name) {
    return getCachedFileForMediaName(seq.media_name);
  }
  return null;
}

// Store an uploaded file. Verifies the claimed hash matches the actual
// bytes (defense against plugin bugs or tampering between plugin and
// server). Throws if hash doesn't match. Returns the stored file path.
//
// Side effect: this hash claims ownership of the given media_name. If
// any OTHER row in the table is currently mapped to the same media_name
// (e.g. a previous version of the same audio file), that mapping is
// cleared — its row is kept (the file bytes might still be valid) but
// its media_name is set to NULL so the lookup query no longer returns
// it. The orphaned bytes can be cleaned up by pruneOrphanedHashes()
// later. Without this, multiple rows could point at the same media_name
// and the lookup's LIMIT 1 would non-deterministically return either,
// causing stale audio to be served.
function storeUploadedFile(buf, claimedHash, mediaName, mimeType) {
  if (!isValidHash(claimedHash)) {
    throw new Error('Invalid hash format');
  }
  const actualHash = hashBuffer(buf);
  if (actualHash !== claimedHash) {
    throw new Error(`Hash mismatch: claimed ${claimedHash}, actual ${actualHash}`);
  }
  const filePath = pathForHash(claimedHash);

  // Store raw file. The Web Audio engine decodes to PCM via decodeAudioData()
  // so transcoding is not needed — seeking happens in PCM, not the container.
  fs.writeFileSync(filePath, buf);

  // No need to detach old rows — the ON CONFLICT(media_name, language)
  // upsert below handles re-uploads correctly. Setting media_name = NULL
  // was the old approach (pre-v0.33.172) but violates the new unique
  // constraint when multiple language rows exist for the same media_name.

  // Upsert keyed on (media_name, language='default') — the plugin always
  // uploads the primary/default track. If a row already exists for this
  // media_name+default, update it (e.g. plugin re-synced with a new file).
  db.prepare(`
    INSERT INTO audio_cache_files (hash, media_name, size_bytes, mime_type, language, cached_at)
    VALUES (?, ?, ?, ?, 'default', CURRENT_TIMESTAMP)
    ON CONFLICT(media_name, language) DO UPDATE SET
      hash       = excluded.hash,
      size_bytes = excluded.size_bytes,
      mime_type  = excluded.mime_type,
      cached_at  = CURRENT_TIMESTAMP
  `).run(claimedHash, mediaName, buf.length, mimeType || 'audio/mpeg');

  return filePath;
}

// Link a media_name to a hash. Used when the plugin reports "this
// sequence's audio file lives in cache as hash X" without re-uploading
// (because we already had that hash from a previous sync). Updates the
// existing row's media_name if needed.
function linkMediaNameToHash(mediaName, hash) {
  if (!isValidHash(hash)) {
    throw new Error('Invalid hash format');
  }
  // Verify the file actually exists in cache
  if (!fs.existsSync(pathForHash(hash))) {
    throw new Error(`Hash ${hash} is not in cache`);
  }
  // Detach any other rows currently claiming this media_name. Same
  // reasoning as in storeUploadedFile — prevents duplicate mappings
  // that would make the lookup query non-deterministic.
  // Upsert the default row for this media_name. Uses (media_name, language)
  // as the conflict target since that's the new unique constraint.
  db.prepare(`
    INSERT INTO audio_cache_files (hash, media_name, size_bytes, mime_type, language, cached_at)
    VALUES (?, ?, 0, 'audio/mpeg', 'default', CURRENT_TIMESTAMP)
    ON CONFLICT(media_name, language) DO UPDATE SET
      hash      = excluded.hash,
      cached_at = CURRENT_TIMESTAMP
  `).run(hash, mediaName);
}

// Stats for the admin UI — total file count and total bytes used.
function getCacheStats() {
  const row = db.prepare(`
    SELECT COUNT(*) AS file_count, COALESCE(SUM(size_bytes), 0) AS total_bytes
    FROM audio_cache_files
  `).get();
  return {
    fileCount: row.file_count,
    totalBytes: row.total_bytes,
  };
}

// Remove cache entries that no longer correspond to any active sequence.
// Catches three cases:
//   (1) media_name is NULL — detached by storeUploadedFile or linkMediaNameToHash
//       when a newer hash took over (e.g. re-extracted with different settings)
//   (2) media_name doesn't match any sequence — sequence was deleted from FPP
//       since the file was originally cached
//   (3) on-disk file is missing — DB row exists but bytes are gone
// Returns the number of entries removed.
function pruneOrphanedHashes() {
  // Since v0.33.172, rows are never set to media_name=NULL — instead they
  // are deleted outright when a sequence is removed. Prune now only removes
  // rows whose media_name no longer matches any sequence, plus disk files
  // that have no corresponding DB row at all.
  const orphaned = db.prepare(`
    SELECT DISTINCT hash FROM audio_cache_files
    WHERE media_name IS NULL
       OR media_name NOT IN (SELECT media_name FROM sequences WHERE media_name IS NOT NULL)
  `).all();
  let removed = 0;
  for (const row of orphaned) {
    // Only delete disk file if no other row still references this hash
    const stillUsed = db.prepare(
      `SELECT 1 FROM audio_cache_files
       WHERE hash = ?
         AND media_name IN (SELECT media_name FROM sequences WHERE media_name IS NOT NULL)
       LIMIT 1`
    ).get(row.hash);
    if (!stillUsed) {
      const filePath = pathForHash(row.hash);
      try { fs.unlinkSync(filePath); } catch (_) { /* already gone */ }
    }
    db.prepare(`DELETE FROM audio_cache_files WHERE hash = ? AND (media_name IS NULL OR media_name NOT IN (SELECT media_name FROM sequences WHERE media_name IS NOT NULL))`).run(row.hash);
    removed++;
  }
  return removed;
}

module.exports = {
  cacheDir,
  pathForHash,
  isValidHash,
  hashBuffer,
  getCachedHashes,
  getCachedPathForMediaName,
  getCachedFileForMediaName,
  getCachedFileByHash,
  getCachedFileForSequence,
  storeUploadedFile,
  linkMediaNameToHash,
  getCacheStats,
  pruneOrphanedHashes,
  getLanguagesForSequence,
  storeLanguageFile,
  deleteLanguageFile,
};
