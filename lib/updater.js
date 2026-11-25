// ============================================================
// ShowPilot — In-app updater (v0.33.0+)
// ============================================================
// Fetches the latest release from GitHub, applies it via `git fetch`
// and `git checkout <tag>`, snapshots data/ before any changes so a
// rollback is possible to exactly one previous version.
//
// Why git operations rather than a symlink-managed `.versions/` tree:
// we only retain ONE previous version (current + previous), so the
// elaborate per-version directory infrastructure was overkill. Git's
// own object store is already the version archive — we just need to
// remember one previous tag/SHA and snapshot data/ separately. See
// SHOWPILOT-PRIMER.md "Architecture decisions worth knowing" for the
// reasoning trail.
//
// Bootstrap problem: same as ShipPilot — if the new release crashes
// on startup, the supervisor will keep trying to revive us into the
// broken code. Manual recovery is documented in the primer; the
// updater itself can't help once it's exited into a bad release.

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

const supervisor = require('./process-supervisor');
const config = require('./config-loader');
const db = require('./db');

// Project root — one level up from lib/. Resolves at module load time
// to keep all paths absolute (avoids surprises if process.cwd() changes).
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const SNAPSHOT_DIR = path.join(DATA_DIR, '.snapshots', 'previous');

// Cache of the latest-version check. Avoids hammering the GitHub API.
// Kept in data/update-checks.json (v0.33.277-master.2) so restarts don't
// start over and ask GitHub again.
const CHECK_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
// "Check now" pressed again within a minute uses the answer just fetched.
const FORCE_MIN_GAP_MS = 60 * 1000;
let lastCheck = { at: 0, latest: null, error: null };

// Background poll interval — every 6 hours.
const BACKGROUND_POLL_MS = 6 * 60 * 60 * 1000;

// GitHub API endpoints. We use /releases?per_page=100 (the list endpoint)
// rather than /releases/latest because /releases/latest returns whichever
// release GitHub has manually marked as "latest" — which requires a manual
// step after every publish and silently stays stale otherwise. The list
// endpoint returns all releases; we pick the highest semver tag ourselves,
// which is always correct regardless of GitHub's "latest" marker.
// Falls back to the tags endpoint if no Release objects exist at all.
// Update source (v0.33.277): ShowPilot's own repo unless the owner picked
// another GitHub repo (their fork) in Settings → Updates → Update source.
// Everything the updater reads or fetches comes from that one repo, whatever
// this install's git `origin` says.
const DEFAULT_REPO = 'ShowPilotFPP/ShowPilot';
const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
function repoSlug() {
  try { const r = String(db.getConfig().update_repo || '').trim(); return REPO_RE.test(r) ? r : DEFAULT_REPO; } catch (_) { return DEFAULT_REPO; }
}
// "owner/repo", or a GitHub address (https://github.com/owner/repo(.git),
// git@github.com:owner/repo.git) -> "owner/repo"; null if it isn't one.
function normalizeRepo(input) {
  let t = String(input || '').trim().replace(/\.git$/i, '').replace(/\/+$/, '');
  const m = /^(?:https?:\/\/(?:www\.)?github\.com\/|git@github\.com:)?([A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100})$/i.exec(t);
  return m ? m[1] : null;
}
const API = () => 'https://api.github.com/repos/' + repoSlug();
const RAW = () => 'https://raw.githubusercontent.com/' + repoSlug() + '/';
const WEB = () => 'https://github.com/' + repoSlug();
const GITHUB_RELEASES_URL = () => API() + '/releases?per_page=100';
const CANONICAL_REPO_URL = () => WEB() + '.git';
const GITHUB_TAGS_URL = () => API() + '/tags?per_page=100';
const GITHUB_RELEASES_WEB_URL = () => WEB() + '/releases';
const GITHUB_TAGS_WEB_URL = () => WEB() + '/tags';

// Minimum free disk space we want available before an update.
// Conservative — npm install pulls dependencies which can run 100-150MB
// of node_modules churn even on a small upgrade.
const MIN_FREE_DISK_MB = 200;

// ------------------------------------------------------------
// Version helpers
// ------------------------------------------------------------

function readPackageVersion() {
  // Read package.json fresh each time rather than caching at startup —
  // the file changes on the disk during an update, and we want any
  // post-restart "what version am I" lookups to see the new value
  // without needing the lib reloaded.
  const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
  return pkg.version;
}

// Compare semver-ish strings ("0.33.0" vs "v0.33.0" both fine).
// Returns positive if a > b, negative if a < b, 0 if equal.
// Trailing pre-release tags ("0.33.0-beta1") are ignored — we only
// compare the numeric prefix. Good enough for our release flow which
// doesn't use pre-releases.
function compareVersions(a, b) {
  const norm = v => String(v).replace(/^v/, '').split('-')[0].split('.').map(n => parseInt(n, 10) || 0);
  const av = norm(a);
  const bv = norm(b);
  for (let i = 0; i < 3; i++) {
    const d = (av[i] || 0) - (bv[i] || 0);
    if (d !== 0) return d;
  }
  // Same X.Y.Z: a stable release outranks its own prereleases
  // (0.33.219 > 0.33.219-beta.1), so beta testers are offered it (v0.33.219+).
  const pa = isPrerelease(a), pb = isPrerelease(b);
  if (pa && !pb) return -1;
  if (!pa && pb) return 1;
  // Both prereleases of the same X.Y.Z: compare the prerelease part the
  // semver way (v0.33.225+), so beta.2 > beta.1 and beta.10 > beta.9. Before
  // this, every beta of one version compared equal and a newer beta was
  // never offered to someone already on an older one.
  if (pa && pb) return comparePrerelease(prereleaseOf(a), prereleaseOf(b));
  return 0;
}

function prereleaseOf(v) {
  const s = String(v || '').replace(/^v/, '');
  const i = s.indexOf('-');
  return i < 0 ? '' : s.slice(i + 1);
}

// Semver prerelease precedence: dot-separated identifiers compared left to
// right; numeric ones numerically, others as text; numeric < text; a longer
// list wins when all shared identifiers are equal (beta < beta.1).
function comparePrerelease(x, y) {
  const xs = x.split('.'), ys = y.split('.');
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    if (i >= xs.length) return -1;
    if (i >= ys.length) return 1;
    const xn = /^\d+$/.test(xs[i]), yn = /^\d+$/.test(ys[i]);
    if (xn && yn) {
      const d = parseInt(xs[i], 10) - parseInt(ys[i], 10);
      if (d !== 0) return d;
    } else if (xn !== yn) {
      return xn ? -1 : 1;
    } else if (xs[i] !== ys[i]) {
      return xs[i] < ys[i] ? -1 : 1;
    }
  }
  return 0;
}

// Commit this install is on (git installs only), for spotting a beta rebuilt
// under the same version number. null when it can't be read.
async function readHeadSha() {
  try {
    const { stdout } = await execFileP('git', ['rev-parse', 'HEAD'], { cwd: PROJECT_ROOT, timeout: 5000 });
    const sha = stdout.trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch (_) { return null; }
}

function isPrerelease(v) {
  return /-/.test(String(v || '').replace(/^v/, ''));
}
// Beta builds are X.Y.Z-beta.N; Master builds (v0.33.276+) are X.Y.Z-master.N.
function isBetaVersion(v) { return /-beta(\.|$)/i.test(String(v || '')); }
function isMasterVersion(v) { return /-master(\.|$)/i.test(String(v || '')); }

// Update channel (v0.33.276+): 'stable' (default) gets only releases;
// 'master' gets every update as soon as it lands on the main branch, like
// FPP's master. Beta is separate: installs running a beta build stay on it.
// With a custom update source (v0.33.277-master.2), the install follows
// that repo's main branch: a fork usually has no releases of its own. The
// saved Stable/Master choice comes back when the source is ShowPilot again.
function getChannel() {
  if (repoSlug() !== DEFAULT_REPO) return 'master';
  try { return db.getConfig().update_channel === 'master' ? 'master' : 'stable'; } catch (_) { return 'stable'; }
}

// ------------------------------------------------------------
// GitHub release check
// ------------------------------------------------------------

// Generic JSON GET helper. Returns { status, body } so callers can
// branch on 404 cleanly without throwing on that case (404 from
// /releases/latest is expected when only tags exist).
//
// GitHub's limit (v0.33.277-master.2): without signing in, GitHub answers
// 60 API requests an hour per network address, shared by everything on that
// network. Once it says the allowance is used up, we don't ask again until
// it resets (asking would only fail), and the Updates page says when that is.
// raw.githubusercontent.com and git itself don't count toward it.
let rateLimitedUntil = 0;
function githubLimitedUntil() { loadCache(); return rateLimitedUntil > Date.now() ? rateLimitedUntil : 0; }
function limitError() {
  const e = new Error("GitHub's hourly limit for update checks from this network is used up");
  e.rateLimited = true;
  return e;
}
function ghGetJson(url) {
  const isApi = /^https:\/\/api\.github\.com\//.test(url);
  if (isApi && githubLimitedUntil()) return Promise.resolve({ status: 403, body: null, rateLimited: true });
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'ShowPilot-Updater',
        'Accept': 'application/vnd.github+json',
      },
      timeout: 10000,
    }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = body ? JSON.parse(body) : null; } catch { /* leave as null on parse error */ }
        let rateLimited = false;
        if (isApi && (res.statusCode === 403 || res.statusCode === 429)) {
          const h = res.headers || {};
          const left = h['x-ratelimit-remaining'];
          const reset = Number(h['x-ratelimit-reset']) * 1000;
          const retry = Number(h['retry-after']) * 1000;
          if (left === '0' || retry > 0 || /rate limit/i.test(String(parsed && parsed.message))) {
            rateLimited = true;
            const now = Date.now();
            rateLimitedUntil = Math.min(now + 60 * 60 * 1000,
              reset > now ? reset : now + (retry > 0 ? retry : 15 * 60 * 1000));
            saveCache();
          }
        }
        resolve({ status: res.statusCode, body: parsed, rateLimited });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('GitHub API timed out')); });
    req.on('error', reject);
  });
}
function httpError(r, what) {
  if (r && r.rateLimited) return limitError();
  return new Error('GitHub returned HTTP ' + (r ? r.status : '?') + ' for ' + what);
}

// Newest commit on a branch of the update source, asked of git itself
// (v0.33.277-master.2): not part of GitHub's hourly API limit. Falls back
// to the API when git can't reach the repo.
async function remoteBranchSha(branch) {
  try {
    const { stdout } = await execFileP('git', ['ls-remote', CANONICAL_REPO_URL(), 'refs/heads/' + branch],
      { cwd: PROJECT_ROOT, timeout: 20000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    const m = /^([0-9a-f]{40})\s+refs\/heads\//m.exec(stdout);
    return m ? { sha: m[1] } : { missing: true };
  } catch (_) { return null; }
}
async function branchHead(branch) {
  const g = await remoteBranchSha(branch);
  if (g) return g;
  const c = await ghGetJson(API() + '/commits/' + branch);
  if (c.status === 404 || c.status === 422) return { missing: true };
  if (c.status !== 200 || !c.body || !c.body.sha) throw httpError(c, 'the ' + branch + ' branch');
  const commit = c.body.commit || {};
  return { sha: c.body.sha, date: (commit.committer && commit.committer.date) || (commit.author && commit.author.date) || null,
           title: String(commit.message || '').split('\n')[0].slice(0, 200) };
}
// package.json at an exact commit (never stale, unlike a branch URL).
async function versionAt(sha) {
  const p = await ghGetJson(RAW() + sha + '/package.json');
  return (p.status === 200 && p.body && p.body.version) ? String(p.body.version) : null;
}

// ------------------------------------------------------------
// Saved checks (v0.33.277-master.2)
// ------------------------------------------------------------
const CACHE_FILE = path.join(DATA_DIR, 'update-checks.json');
const compareCache = new Map(); // "head...sha" -> { behindBy, changes, title, date }; never changes
function saveCache() {
  if (process.env.NODE_ENV === 'test') return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({
      repo: repoSlug(), rateLimitedUntil, lastCheck, lastBetaCheck, lastMasterCheck,
      compare: [...compareCache.entries()].slice(-10),
    }));
  } catch (_) { /* only a cache */ }
}
let cacheLoaded = false;
function loadCache() {
  if (cacheLoaded || process.env.NODE_ENV === 'test') return;
  cacheLoaded = true;
  try {
    const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (!c || c.repo !== repoSlug()) return;
    if (Number(c.rateLimitedUntil) > Date.now()) rateLimitedUntil = Number(c.rateLimitedUntil);
    if (c.lastCheck && c.lastCheck.at) lastCheck = c.lastCheck;
    if (c.lastBetaCheck && c.lastBetaCheck.at) lastBetaCheck = c.lastBetaCheck;
    if (c.lastMasterCheck && c.lastMasterCheck.at) lastMasterCheck = c.lastMasterCheck;
    for (const [k, v] of (Array.isArray(c.compare) ? c.compare : [])) compareCache.set(k, v);
  } catch (_) { /* none yet */ }
}
// Use the saved answer unless it's old, or "Check now" asked and it's over a
// minute old. While GitHub's limit is used up, the saved answer is kept.
function fresh(c, force) {
  loadCache();
  if (!c || !c.at) return false;
  const age = Date.now() - c.at;
  if (age < FORCE_MIN_GAP_MS) return true;
  return !force && age < CHECK_CACHE_TTL_MS;
}

// Filter to tags that look like semver (vX.Y.Z), parse, sort descending,
// return the highest. Returns null if there are no semver-shaped tags.
function pickHighestSemverTag(tags) {
  const semverTags = (tags || [])
    .map(t => t && t.name)
    .filter(name => typeof name === 'string' && /^v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(name));
  if (semverTags.length === 0) return null;
  semverTags.sort((a, b) => compareVersions(b, a)); // descending
  return semverTags[0];
}

// Pick the highest-semver release from a releases list array.
// Skips drafts, pre-releases, and tags that aren't shaped like vX.Y.Z / X.Y.Z
// (guards against malformed release tags like "33.15" which parse as major
// version 33 and beat legitimate "v0.33.x" tags in the sort).
function pickHighestSemverRelease(releases) {
  if (!Array.isArray(releases) || releases.length === 0) return null;
  const semverShape = /^v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;
  const candidates = releases.filter(r =>
    r && r.tag_name &&
    semverShape.test(r.tag_name) &&
    !r.draft &&
    !r.prerelease
  );
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => compareVersions(b.tag_name, a.tag_name)); // descending
  return candidates[0];
}

// Try /releases?per_page=100 and /tags?per_page=100 in parallel, then
// return whichever has the higher semver. This handles the mixed state
// where some releases have GitHub Release objects (richer data) and newer
// ones were shipped as tags only (ShipPilot creates tags, not Releases).
// One release's notes by tag (v0.33.261). The release list is cached by
// GitHub for about a minute, so right after a release ships its tag can be
// visible while the list doesn't have it yet; this asks for it directly.
async function fetchReleaseNote(tag) {
  const r = await ghGetJson(API() + '/releases/tags/' + encodeURIComponent(tag));
  if (r.status !== 200 || !r.body || r.body.draft) return null;
  return { tag: r.body.tag_name, body: String(r.body.body || '').slice(0, 6000), url: r.body.html_url || null, publishedAt: r.body.published_at || null };
}

async function fetchLatestRelease() {
  const [releasesRes, tagsRes] = await Promise.all([
    ghGetJson(GITHUB_RELEASES_URL()),
    ghGetJson(GITHUB_TAGS_URL()),
  ]);

  const bestRelease = (releasesRes.status === 200 && Array.isArray(releasesRes.body))
    ? pickHighestSemverRelease(releasesRes.body)
    : null;

  const bestTag = (tagsRes.status === 200)
    ? pickHighestSemverTag(tagsRes.body)
    : null;

  if (!bestRelease && !bestTag) {
    if (releasesRes.rateLimited || tagsRes.rateLimited) throw limitError();
    throw new Error('No releases or semver-shaped tags found on GitHub');
  }

  // Prefer the release object for its richer data (notes, published date),
  // but only if it's actually the highest version. If a newer tag exists
  // that has no Release object yet, use the tag.
  // Release notes for "What's new" on the Updates page (v0.33.259): every
  // published stable release, newest first (ShipPilot publishes each one
  // with its changelog). Capped so the cached check stays small.
  const notes = (releasesRes.status === 200 && Array.isArray(releasesRes.body) ? releasesRes.body : [])
    .filter(r => r && r.tag_name && /^v?\d+\.\d+\.\d+$/.test(r.tag_name) && !r.draft && !r.prerelease)
    .sort((a, b) => compareVersions(b.tag_name, a.tag_name))
    .slice(0, 40)
    .map(r => ({ tag: r.tag_name, body: String(r.body || '').slice(0, 6000), url: r.html_url || null, publishedAt: r.published_at || null }));

  const releaseIsHigher = bestRelease && bestTag
    ? compareVersions(bestRelease.tag_name, bestTag) >= 0
    : !!bestRelease;

  if (releaseIsHigher) {
    return {
      tag: bestRelease.tag_name,
      name: bestRelease.name || bestRelease.tag_name,
      url: bestRelease.html_url || GITHUB_RELEASES_WEB_URL(),
      publishedAt: bestRelease.published_at,
      body: bestRelease.body || '',
      source: 'releases',
      notes,
    };
  }

  // Tag is higher (or no release objects exist at all)
  return {
    tag: bestTag,
    name: bestTag,
    url: `${GITHUB_RELEASES_WEB_URL()}/tag/${encodeURIComponent(bestTag)}`,
    publishedAt: null,
    body: '',
    source: 'tags',
    notes,
  };
}

// ------------------------------------------------------------
// Beta channel (v0.33.219+) — debugging and testing builds only
// ------------------------------------------------------------
// Beta builds are pushed to the `beta` branch WITHOUT a tag (so they never
// become a release or the Docker :latest image). The updater installs the
// exact commit at the tip of `beta`, verified at install time.
const GITHUB_BETA_COMMIT_URL = () => API() + '/commits/beta';
const GITHUB_BETA_PKG_URL = () => RAW() + 'beta/package.json';
const GITHUB_BETA_PKG_AT = () => RAW();
let lastBetaCheck = { at: 0, beta: null, error: null };

async function checkBeta({ force = false } = {}) {
  loadCache();
  const now = Date.now();
  if (fresh(lastBetaCheck, force)) return lastBetaCheck;
  try {
    // Newest beta commit from git (not part of GitHub's hourly limit), then
    // package.json at that exact commit (v0.33.258-beta.2+: a commit URL is
    // never served stale, unlike the branch URL).
    const h = await branchHead('beta');
    if (h.missing) { lastBetaCheck = { at: now, beta: null, error: null }; saveCache(); return lastBetaCheck; }
    const version = await versionAt(h.sha);
    const prev = lastBetaCheck.beta && lastBetaCheck.beta.sha === h.sha ? lastBetaCheck.beta : null;
    lastBetaCheck = {
      at: now,
      error: null,
      beta: {
        sha: h.sha,
        shortSha: h.sha.slice(0, 7),
        version,
        date: h.date || (prev && prev.date) || null,
        title: h.title || (prev && prev.title) || '',
        url: WEB() + '/commit/' + h.sha,
      },
    };
  } catch (err) {
    lastBetaCheck = { at: now, beta: lastBetaCheck.beta, error: err.message };
  }
  saveCache();
  return lastBetaCheck;
}

// ------------------------------------------------------------
// Master channel (v0.33.276+) — every update as it lands on main
// ------------------------------------------------------------
// Updates ship to main without a version tag (X.Y.Z-master.N); only real
// releases are tagged. A Master install follows the tip of main: the check
// reads that commit, its package.json, and how many updates this install is
// behind (GitHub's compare), with their titles for "What's new".
const GITHUB_MAIN_COMMIT_URL = () => API() + '/commits/main';
const GITHUB_COMPARE_URL = () => API() + '/compare/';
let lastMasterCheck = { at: 0, master: null, error: null };

async function checkMaster({ force = false } = {}) {
  loadCache();
  const now = Date.now();
  const head = await readHeadSha();
  // A saved answer only counts for the commit this install is on now
  // (after an update it would still say "behind").
  if (fresh(lastMasterCheck, force) && (!lastMasterCheck.master || lastMasterCheck.master.head === head)) return lastMasterCheck;
  try {
    // v0.33.277-master.2: the newest commit comes from git and its version
    // from raw.githubusercontent.com, so finding out THAT there's an update
    // never uses GitHub's hourly API limit. Only the list of what changed
    // does (one request, remembered for good).
    const h = await branchHead('main');
    if (h.missing || !h.sha) throw new Error('The update source has no main branch');
    const version = await versionAt(h.sha);
    const current = readPackageVersion();
    let behindBy = null, changes = [], title = h.title || '', date = h.date || null;
    if (head && head === h.sha) behindBy = 0;
    else if (head) {
      const key = head + '...' + h.sha;
      let cmp = compareCache.get(key);
      if (!cmp) {
        const r = await ghGetJson(GITHUB_COMPARE_URL() + key);
        if (r.status === 200 && r.body) {
          const list = (r.body.commits || []).slice().reverse();
          cmp = {
            behindBy: r.body.status === 'behind' || r.body.status === 'identical' ? 0 : Number(r.body.ahead_by) || 0,
            changes: list.slice(0, 50).map((x) => ({
              sha: x.sha, shortSha: String(x.sha).slice(0, 7),
              date: (x.commit && x.commit.committer && x.commit.committer.date) || null,
              message: String((x.commit && x.commit.message) || '').slice(0, 4000),
            })),
          };
          compareCache.set(key, cmp);
          while (compareCache.size > 10) compareCache.delete(compareCache.keys().next().value);
        }
      }
      if (cmp) {
        behindBy = cmp.behindBy; changes = cmp.changes;
        if (changes[0]) { title = title || String(changes[0].message).split('\n')[0].slice(0, 200); date = date || changes[0].date; }
      }
    }
    // Couldn't list the changes (e.g. GitHub's limit is used up): a newer
    // version number on main is still an update.
    const available = behindBy > 0 || (behindBy == null && !!head && head !== h.sha && !!version && compareVersions(version, current) > 0);
    lastMasterCheck = {
      at: now,
      error: null,
      master: {
        sha: h.sha,
        shortSha: h.sha.slice(0, 7),
        version,
        date,
        title,
        url: WEB() + '/commit/' + h.sha,
        head,
        behindBy,      // null = couldn't tell (this install's commit isn't on GitHub, or GitHub's limit)
        available,
        changes,       // newest first, each with its full message (the changelog)
      },
    };
  } catch (err) {
    lastMasterCheck = { at: now, master: lastMasterCheck.master, error: err.message };
  }
  saveCache();
  return lastMasterCheck;
}

// The Master updates between a release tag and this install's commit
// (v0.33.282-master.2), newest first, for the Updates page when a Master
// install is up to date. One GitHub request per (tag, commit) pair,
// remembered with the other comparisons. null when GitHub can't say.
async function changesSince(baseTag, head) {
  if (!baseTag || !head) return null;
  const key = String(baseTag) + '...' + head;
  let cmp = compareCache.get(key);
  if (!cmp) {
    try {
      const r = await ghGetJson(GITHUB_COMPARE_URL() + key);
      if (r.status !== 200 || !r.body) return null;
      const list = (r.body.commits || []).slice().reverse();
      cmp = {
        behindBy: Number(r.body.ahead_by) || 0,
        changes: list.slice(0, 50).map((x) => ({
          sha: x.sha, shortSha: String(x.sha).slice(0, 7),
          date: (x.commit && x.commit.committer && x.commit.committer.date) || null,
          message: String((x.commit && x.commit.message) || '').slice(0, 4000),
        })),
      };
      compareCache.set(key, cmp);
      while (compareCache.size > 10) compareCache.delete(compareCache.keys().next().value);
    } catch (_) { return null; }
  }
  return cmp.changes;
}

async function applyMasterUpdate(expectedSha, { force = false } = {}) {
  const errors = await preflightChecks({ force });
  if (errors.length) {
    const e = new Error('Pre-flight checks failed');
    e.preflightErrors = errors;
    throw e;
  }
  const currentVersion = readPackageVersion();
  await snapshotData(currentVersion);
  const { oldSha } = await gitFetchBetaAndCheckout(expectedSha, 'main');
  await npmInstall();
  db.setUpdateState({
    previous_version_tag: 'v' + currentVersion,
    previous_version_sha: oldSha,
    last_update_at: new Date().toISOString(),
    last_update_target: 'master@' + expectedSha.slice(0, 7),
  });
  return { previousVersion: currentVersion, previousSha: oldSha, target: 'master@' + expectedSha.slice(0, 7) };
}

async function gitFetchBetaAndCheckout(expectedSha, branch = 'beta') {
  const { stdout: oldSha } = await execFileP('git', ['rev-parse', 'HEAD'], { cwd: PROJECT_ROOT, timeout: 5000 });
  // Same clean-slate reset as a normal update (config.js and data/ are
  // untracked and untouched).
  await execFileP('git', ['reset', '--hard', 'HEAD'], { cwd: PROJECT_ROOT, timeout: 10000 });
  await execFileP('git', ['clean', '-fd'], { cwd: PROJECT_ROOT, timeout: 10000 });
  // Straight from the update source (ShowPilot, or the owner's chosen
  // repo), whatever `origin` points at (v0.33.276 / v0.33.277).
  await execFileP('git', ['fetch', CANONICAL_REPO_URL(), branch], { cwd: PROJECT_ROOT, timeout: 60000 });
  const { stdout: fetched } = await execFileP('git', ['rev-parse', 'FETCH_HEAD'], { cwd: PROJECT_ROOT, timeout: 5000 });
  if (fetched.trim() !== expectedSha) {
    throw new Error('The ' + (branch === 'main' ? 'Master' : 'beta') + ' channel changed since this page loaded (now ' + fetched.trim().slice(0, 7) + '). Refresh and try again.');
  }
  await execFileP('git', ['checkout', '--detach', expectedSha], { cwd: PROJECT_ROOT, timeout: 30000 });
  return { oldSha: oldSha.trim() };
}

async function applyBetaUpdate(expectedSha, { force = false } = {}) {
  const errors = await preflightChecks({ force });
  if (errors.length) {
    const e = new Error('Pre-flight checks failed');
    e.preflightErrors = errors;
    throw e;
  }
  const currentVersion = readPackageVersion();
  await snapshotData(currentVersion);
  const { oldSha } = await gitFetchBetaAndCheckout(expectedSha);
  await npmInstall();
  db.setUpdateState({
    previous_version_tag: 'v' + currentVersion,
    previous_version_sha: oldSha,
    last_update_at: new Date().toISOString(),
    last_update_target: 'beta@' + expectedSha.slice(0, 7),
  });
  return { previousVersion: currentVersion, previousSha: oldSha, target: 'beta@' + expectedSha.slice(0, 7) };
}

async function checkForUpdate({ force = false } = {}) {
  loadCache();
  const now = Date.now();
  if (fresh(lastCheck, force)) return lastCheck;
  // v0.33.278-master.2: the newest version tag comes from git, which isn't
  // part of GitHub's hourly API limit. When it's the release we already
  // know about, nothing has changed and the saved answer is reused (0 API
  // requests). The release list (2 requests) is only fetched when a new tag
  // appears, or when git can't reach the update source.
  const newest = await newestRemoteTag();
  const known = lastCheck.latest && lastCheck.latest.tag;
  if (newest && known && newest === known) {
    // Copy without _noteTried, so routes/updates.js may still fetch a new
    // release's notes once if the list didn't have them yet.
    const { _noteTried, ...latest } = lastCheck.latest;
    lastCheck = { at: now, latest, error: null };
    saveCache();
    return lastCheck;
  }
  // GitHub's limit used up: keep what we knew, say why, ask once it resets.
  // A newer tag found through git is still offered (without its notes).
  if (githubLimitedUntil()) {
    if (newest && (!known || compareVersions(newest, known) > 0)) {
      return { ...lastCheck, latest: tagOnlyRelease(newest, lastCheck.latest && lastCheck.latest.notes), error: limitError().message };
    }
    return { ...lastCheck, error: limitError().message };
  }
  try {
    const latest = await fetchLatestRelease();
    lastCheck = { at: now, latest, error: null };
  } catch (err) {
    const fallback = newest ? tagOnlyRelease(newest, lastCheck.latest && lastCheck.latest.notes) : lastCheck.latest;
    lastCheck = { at: now, latest: fallback, error: err.message };
  }
  saveCache();
  return lastCheck;
}

// Highest version tag on the update source, asked of git itself
// (v0.33.278-master.2): no GitHub API request. null when git can't reach the
// repo or there are no version tags (the caller then asks the API as before).
async function newestRemoteTag() {
  try {
    const { stdout } = await execFileP('git', ['ls-remote', '--tags', '--refs', CANONICAL_REPO_URL()],
      { cwd: PROJECT_ROOT, timeout: 20000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    const names = [];
    for (const line of stdout.split('\n')) {
      const m = /^[0-9a-f]{40}\s+refs\/tags\/(\S+)$/.exec(line.trim());
      // Only plain releases (v1.2.3): a beta or Master tag is never a
      // Stable update, even if one was ever tagged.
      if (m && /^v?\d+\.\d+\.\d+$/.test(m[1])) names.push({ name: m[1] });
    }
    return pickHighestSemverTag(names);
  } catch (_) { return null; }
}

// A release known only by its tag (same shape fetchLatestRelease returns).
function tagOnlyRelease(tag, notes) {
  return {
    tag,
    name: tag,
    url: `${GITHUB_RELEASES_WEB_URL()}/tag/${encodeURIComponent(tag)}`,
    publishedAt: null,
    body: '',
    source: 'tags',
    notes: Array.isArray(notes) ? notes : [],
  };
}

// ------------------------------------------------------------
// Pre-flight checks
// ------------------------------------------------------------

async function preflightChecks({ force = false } = {}) {
  const errors = [];

  // 1. Free disk space. statvfs is the right call but Node doesn't
  // expose it directly without a native module; `df` is universal on
  // the platforms ShowPilot main runs on (Linux LXC, Docker on
  // Linux/macOS). On Windows we'd need a different approach but the
  // updater is gated to non-Docker Linux deployments anyway.
  try {
    const { stdout } = await execFileP('df', ['-Pm', PROJECT_ROOT], { timeout: 5000 });
    const lines = stdout.trim().split('\n');
    const lastLine = lines[lines.length - 1];
    const parts = lastLine.split(/\s+/);
    // df -Pm output: Filesystem 1M-blocks Used Available Capacity Mounted-on
    const availableMb = parseInt(parts[3], 10);
    if (Number.isFinite(availableMb) && availableMb < MIN_FREE_DISK_MB) {
      errors.push({ msg: `Only ${availableMb}MB free; need at least ${MIN_FREE_DISK_MB}MB`, override: false });
    }
  } catch (e) {
    // If df fails, don't block — log and continue. Better to attempt
    // and fail loudly than refuse to update because of a missing
    // utility.
    console.warn('[updater] df check skipped:', e.message);
  }

  // 2. Working-tree cleanliness used to be a blocking check here.
  // Removed in v0.33.7 because `npm install --omit=dev` (run as part
  // of every successful update) modifies the tracked package-lock.json,
  // which then dirties the tree and blocks the NEXT update. The fix
  // is to auto-stash in gitFetchAndCheckout instead — local changes
  // (including post-update package-lock churn) are preserved across
  // the checkout and dropped on success. If the stash itself fails
  // to apply we surface that as an error from the checkout step.

  // 3. DB integrity. SQLite's PRAGMA integrity_check returns "ok" on a
  // healthy DB and a list of issues otherwise. We don't want to ship
  // an upgrade that runs migrations against a corrupt DB.
  try {
    const result = db.db.prepare('PRAGMA integrity_check').get();
    const value = result && (result.integrity_check || Object.values(result)[0]);
    if (value !== 'ok') {
      errors.push({ msg: 'DB integrity check failed: ' + value, override: false });
    }
  } catch (e) {
    errors.push({ msg: 'DB integrity check threw: ' + e.message, override: false });
  }

  // 4. Active-show check. If a voting round is in progress with cast
  // votes, or the jukebox queue has entries, refuse — restarting
  // mid-show is hostile to viewers. Operator can override with the
  // "Update anyway" button when they're sure (e.g. testing, end of
  // night, no live audience).
  try {
    const cfg = db.getConfig();
    if (cfg.viewer_control_mode === 'VOTING') {
      const voteCount = db.db.prepare('SELECT COUNT(*) AS n FROM votes').get().n;
      if (voteCount > 0 && !force) {
        errors.push({ msg: 'Voting round has active votes — clear the round before updating', override: true });
      }
    }
    const queueCount = db.db.prepare(
      "SELECT COUNT(*) AS n FROM jukebox_queue WHERE played = 0"
    ).get().n;
    if (queueCount > 0 && !force) {
      errors.push({ msg: `Jukebox queue has ${queueCount} pending request(s) — clear the queue before updating`, override: true });
    }
  } catch (e) {
    errors.push({ msg: 'Show-state check failed: ' + e.message, override: false });
  }

  return errors;
}

// ------------------------------------------------------------
// Snapshot / restore of data/
// ------------------------------------------------------------

// We snapshot data/ before each update. Only ONE snapshot is kept
// (overwritten on each new update) so disk usage stays bounded.
//
// Notable exclusions: data/.snapshots/ itself (recursion!), and
// data/audio-cache/ which can be 100s of MB and is regenerable from
// the FPP plugin. The cache will repopulate automatically as
// sequences play after a rollback. Also data/tts/engine and
// data/tts/models (Tools → Announcements' free voices, ~400 MB,
// re-installable from the admin); data/tts's keys/settings ARE kept.
async function snapshotData(currentVersion) {
  // Wipe any previous snapshot first — we only keep one.
  if (fs.existsSync(SNAPSHOT_DIR)) {
    await execFileP('rm', ['-rf', SNAPSHOT_DIR], { timeout: 30000 });
  }
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });

  // Use rsync for atomic-ish copy with exclusions. Falls back to cp
  // if rsync unavailable (rare on Linux, common on minimal Alpine
  // Docker images — but Docker is excluded from updates anyway).
  try {
    await execFileP('rsync', [
      '-a',
      '--exclude=.snapshots',
      '--exclude=audio-cache',
      '--exclude=/tts/engine',
      '--exclude=/tts/models',
      `${DATA_DIR}/`,
      `${SNAPSHOT_DIR}/`,
    ], { timeout: 120000 });
  } catch (e) {
    // Fallback (no rsync, common on minimal Debian/Ubuntu containers): copy
    // each top-level entry except the snapshot folder itself. Copying
    // data/. whole would copy data/ into its own data/.snapshots and fail
    // ("cannot copy a directory into itself"), so every update failed on
    // installs without rsync (fixed v0.33.276).
    for (const entry of fs.readdirSync(DATA_DIR)) {
      if (entry === '.snapshots' || entry === 'audio-cache') continue;
      await execFileP('cp', ['-a', path.join(DATA_DIR, entry), SNAPSHOT_DIR + path.sep], { timeout: 120000 });
    }
    for (const excl of ['tts/engine', 'tts/models']) {
      const p = path.join(SNAPSHOT_DIR, excl);
      if (fs.existsSync(p)) {
        await execFileP('rm', ['-rf', p], { timeout: 30000 });
      }
    }
  }

  // Tag the snapshot with the version it represents — useful for the
  // UI ("Roll back to v0.32.14") and for sanity-checking on rollback.
  fs.writeFileSync(
    path.join(SNAPSHOT_DIR, '.snapshot-meta.json'),
    JSON.stringify({
      version: currentVersion,
      createdAt: new Date().toISOString(),
    }, null, 2)
  );
}

async function restoreSnapshot() {
  if (!fs.existsSync(SNAPSHOT_DIR)) {
    throw new Error('No snapshot to restore');
  }
  // Restore everything except audio-cache (which we excluded from the
  // snapshot, so it's not in there anyway — but defensive). Critically
  // we DON'T wipe data/ first — we just rsync the snapshot OVER it. That
  // way audio-cache and any dirs created post-snapshot survive, and we
  // only replace what was actually snapshotted (DB, secrets, covers,
  // etc.). The DB file gets overwritten atomically by rsync.
  try {
    await execFileP('rsync', [
      '-a',
      '--delete',
      '--exclude=.snapshots',
      '--exclude=audio-cache',
      '--exclude=/tts/engine',
      '--exclude=/tts/models',
      `${SNAPSHOT_DIR}/`,
      `${DATA_DIR}/`,
    ], { timeout: 120000 });
  } catch (e) {
    // No clean rsync fallback for the --delete semantics, so just cp -a.
    // This won't delete files that exist in data/ but not in snapshot,
    // which is acceptable — in practice the only things in data/ are
    // things ShowPilot knows about.
    await execFileP('cp', ['-af', `${SNAPSHOT_DIR}/.`, DATA_DIR], { timeout: 120000 });
  }
}

function readSnapshotMeta() {
  const metaPath = path.join(SNAPSHOT_DIR, '.snapshot-meta.json');
  if (!fs.existsSync(metaPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    return null;
  }
}

// ------------------------------------------------------------
// Apply update
// ------------------------------------------------------------

// Run the actual git operations + npm install. Returns {oldSha}.
async function gitFetchAndCheckout(targetTag) {
  const { stdout: oldSha } = await execFileP('git', ['rev-parse', 'HEAD'], {
    cwd: PROJECT_ROOT,
    timeout: 5000,
  });

  // Hard-reset + clean before checkout so a dirty working tree never
  // blocks the update. This happens routinely because `npm install
  // --omit=dev` modifies the tracked package-lock.json, and new
  // releases may add untracked files (e.g. lib/translator.js) that
  // git refuses to overwrite without --force.
  //
  // ShowPilot's working tree intentionally has no operator-edited
  // files — config.js and data/ are excluded from git and untouched
  // by these commands. It is safe to discard everything else.
  //
  // -x is intentionally NOT used — it would delete .gitignored files
  // like node_modules and config.js.
  await execFileP('git', ['reset', '--hard', 'HEAD'], {
    cwd: PROJECT_ROOT,
    timeout: 10000,
  });
  await execFileP('git', ['clean', '-fd'], {
    cwd: PROJECT_ROOT,
    timeout: 10000,
  });

  await execFileP('git', ['fetch', '--tags', 'origin'], {
    cwd: PROJECT_ROOT,
    timeout: 60000,
  });

  // The release check asks GitHub's ShowPilot repo directly, but `origin`
  // can point somewhere else (a fork, a mirror, an old address) that
  // doesn't have the new tag, and the checkout then failed with "pathspec
  // 'vX' did not match" (v0.33.276). Fetch the tag from ShowPilot itself.
  const hasTag = async () => {
    try {
      await execFileP('git', ['rev-parse', '--verify', '--quiet', 'refs/tags/' + targetTag], { cwd: PROJECT_ROOT, timeout: 5000 });
      return true;
    } catch (_) { return false; }
  };
  // A custom update source always supplies the tag (its vX may differ
  // from ShowPilot's own vX).
  if (repoSlug() !== DEFAULT_REPO || !(await hasTag())) {
    await execFileP('git', ['fetch', '--no-tags', CANONICAL_REPO_URL(), '+refs/tags/' + targetTag + ':refs/tags/' + targetTag], {
      cwd: PROJECT_ROOT,
      timeout: 60000,
    });
  }

  await execFileP('git', ['checkout', targetTag], {
    cwd: PROJECT_ROOT,
    timeout: 30000,
  });

  return { oldSha: oldSha.trim() };
}

// Drop a labeled updater stash. Best-effort — if the stash was already
// dropped or the label doesn't match, log and move on.
async function dropUpdaterStash(stashLabel) {
  if (!stashLabel) return;
  try {
    // Find the stash entry by label and drop it. `git stash list`
    // outputs lines like "stash@{0}: On main: showpilot-updater-1234".
    const { stdout } = await execFileP('git', ['stash', 'list'], {
      cwd: PROJECT_ROOT,
      timeout: 5000,
    });
    const lines = stdout.split('\n');
    const match = lines.find(l => l.includes(stashLabel));
    if (!match) {
      console.warn('[updater] stash', stashLabel, 'not found, nothing to drop');
      return;
    }
    const refMatch = match.match(/^(stash@\{\d+\})/);
    if (!refMatch) return;
    await execFileP('git', ['stash', 'drop', refMatch[1]], {
      cwd: PROJECT_ROOT,
      timeout: 5000,
    });
    console.log('[updater] dropped stash', stashLabel);
  } catch (e) {
    console.warn('[updater] drop stash failed (non-fatal):', e.message);
  }
}

async function npmInstall() {
  // --omit=dev is the modern flag (was --production); both work on
  // recent npm but --omit=dev is preferred. 5-minute timeout because
  // a fresh install on slow disk can take a while.
  await execFileP('npm', ['install', '--omit=dev'], {
    cwd: PROJECT_ROOT,
    timeout: 300000,
  });
}

// Apply an update: snapshot data/, fetch tag, checkout, npm install,
// record state, schedule clean exit. Throws if any step fails.
//
// Options:
//   force — when true, the active-show preflight check is skipped.
//           Used by the UI's "Update anyway" button. Other preflight
//           checks (disk, DB integrity) are NOT bypassed by force.
async function applyUpdate(targetTag, { force = false } = {}) {
  const errors = await preflightChecks({ force });
  if (errors.length) {
    const e = new Error('Pre-flight checks failed');
    e.preflightErrors = errors;
    throw e;
  }

  const currentVersion = readPackageVersion();

  // 1. Snapshot data/
  await snapshotData(currentVersion);

  // 2. Capture current SHA, hard-reset working tree, fetch + checkout new tag.
  const { oldSha } = await gitFetchAndCheckout(targetTag);

  // 3. npm install for any new dependencies
  await npmInstall();

  // 5. Record what we came from so the UI's rollback button knows
  // where to go back to. We set this AFTER all the risky operations
  // succeeded — if any earlier step failed, we never recorded the
  // pending state, so the rollback UI accurately reflects "we never
  // updated".
  db.setUpdateState({
    previous_version_tag: 'v' + currentVersion,
    previous_version_sha: oldSha,
    last_update_at: new Date().toISOString(),
    last_update_target: targetTag,
  });

  return { previousVersion: currentVersion, previousSha: oldSha, targetTag };
}

// Roll back to the previous version. Restores data/ from snapshot,
// checks out the previous SHA, runs npm install in case dependency
// versions changed.
async function applyRollback() {
  const state = db.getUpdateState();
  if (!state || !state.previous_version_sha) {
    throw new Error('No previous version recorded — rollback unavailable');
  }
  if (!fs.existsSync(SNAPSHOT_DIR)) {
    throw new Error('Data snapshot missing — cannot safely roll back');
  }

  // Restore data/ first. If this fails we haven't touched git yet, so
  // the install is still self-consistent.
  await restoreSnapshot();

  // Hard-reset + clean before checkout — same reasoning as gitFetchAndCheckout.
  await execFileP('git', ['reset', '--hard', 'HEAD'], {
    cwd: PROJECT_ROOT,
    timeout: 10000,
  });
  await execFileP('git', ['clean', '-fd'], {
    cwd: PROJECT_ROOT,
    timeout: 10000,
  });

  // Check out the old SHA. We use the SHA rather than the tag because
  // it's unambiguous — even if the tag was deleted on origin, we still
  // have the commit locally.
  await execFileP('git', ['checkout', state.previous_version_sha], {
    cwd: PROJECT_ROOT,
    timeout: 30000,
  });

  await npmInstall();

  // Clear the previous-version pointer. After a rollback there's no
  // "next previous" — the operator would have to update again before
  // a rollback button makes sense.
  db.setUpdateState({
    previous_version_tag: null,
    previous_version_sha: null,
    last_update_at: new Date().toISOString(),
    last_update_target: 'rollback to ' + state.previous_version_tag,
  });

  return { rolledBackTo: state.previous_version_tag };
}

// ------------------------------------------------------------
// Restart helpers
// ------------------------------------------------------------

// True if we're running in a context where the updater button should
// be disabled. Docker case shows the version-available info but no
// button (per the design discussion) because Watchtower handles
// updates externally.
function isUpdaterAvailable() {
  if (config.demoMode) return false;
  if (supervisor.detectSupervisor() === 'docker') return false;
  return true;
}

function scheduleCleanExit(reason) {
  // Mirrors routes/backup.js — exit AFTER the response flushes.
  setTimeout(() => {
    console.log('[updater] exiting for supervisor-managed restart:', reason);
    process.exit(0);
  }, 1500);
}

// ------------------------------------------------------------
// Background polling
// ------------------------------------------------------------

let pollTimer = null;
function startBackgroundPolling() {
  if (pollTimer) return;
  // Initial check at startup — wait 30s so we don't slow boot.
  setTimeout(() => {
    checkForUpdate({ force: true }).catch(() => {});
    if (getChannel() === 'master') checkMaster({ force: true }).catch(() => {});
  }, 30000);
  pollTimer = setInterval(() => {
    checkForUpdate({ force: true }).catch(() => {});
    if (getChannel() === 'master') checkMaster({ force: true }).catch(() => {});
  }, BACKGROUND_POLL_MS);
  pollTimer.unref();
}

// ------------------------------------------------------------
// Dashboard notice (v0.33.249-beta.19+)
// ------------------------------------------------------------
// What the last checks found, without making the Dashboard wait on GitHub:
// when the last check is older than the cache time, a new one starts in the
// background and its answer shows on a later poll. A newer stable release
// is offered to everyone; a newer beta only to installs already on a beta.
// Scenario tests (NODE_ENV=test) never call GitHub: they put the newest
// versions in data/test-release.json ({ "stable": "x", "beta": "y" }).
let noticeKickAt = 0;
function notice() {
  loadCache();
  const current = readPackageVersion();
  const onBeta = isBetaVersion(current);
  const onMaster = !onBeta && getChannel() === 'master';
  let latest = null, beta = null, master = null;
  if (process.env.NODE_ENV === 'test') {
    try {
      const t = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'test-release.json'), 'utf8'));
      latest = t.stable || null; beta = t.beta || null;
    } catch (e) { /* no test release */ }
  } else {
    const now = Date.now();
    const stale = (c) => !c.at || now - c.at >= CHECK_CACHE_TTL_MS;
    if ((stale(lastCheck) || (onBeta && stale(lastBetaCheck)) || (onMaster && stale(lastMasterCheck))) && now - noticeKickAt > 60000) {
      noticeKickAt = now;
      if (stale(lastCheck)) checkForUpdate().catch(() => {});
      if (onBeta && stale(lastBetaCheck)) checkBeta().catch(() => {});
      if (onMaster && stale(lastMasterCheck)) checkMaster().catch(() => {});
    }
    latest = lastCheck.latest && lastCheck.latest.tag ? String(lastCheck.latest.tag) : null;
    beta = lastBetaCheck.beta && lastBetaCheck.beta.version ? String(lastBetaCheck.beta.version) : null;
    master = lastMasterCheck.master;
  }
  const strip = (v) => String(v).replace(/^v/, '');
  // Master installs are told about new updates on main, not about releases
  // (a release is already on main by the time it's tagged).
  if (onMaster) {
    if (master && (master.available || master.behindBy > 0) && master.head === readHeadShaSync()) return { kind: 'master', current, latest: master.version ? strip(master.version) : master.shortSha, behindBy: master.behindBy };
    return null;
  }
  if (latest && compareVersions(latest, current) > 0) return { kind: 'stable', current, latest: strip(latest) };
  if (onBeta && beta && compareVersions(beta, current) > 0) return { kind: 'beta', current, latest: strip(beta) };
  return null;
}

// Forget cached checks (the update source changed).
function resetChecks() {
  lastCheck = { at: 0, latest: null, error: null };
  lastBetaCheck = { at: 0, beta: null, error: null };
  lastMasterCheck = { at: 0, master: null, error: null };
  compareCache.clear();
  saveCache();
}

// HEAD for the Dashboard notice, which can't wait: read once per minute.
let headSync = { at: 0, sha: null };
function readHeadShaSync() {
  if (Date.now() - headSync.at < 60000) return headSync.sha;
  let sha = null;
  try {
    const out = require('child_process').execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT_ROOT, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (/^[0-9a-f]{40}$/.test(out)) sha = out;
  } catch (_) { /* not a git install */ }
  headSync = { at: Date.now(), sha };
  return sha;
}


module.exports = {
  repoSlug,
  normalizeRepo,
  DEFAULT_REPO,
  resetChecks,
  githubLimitedUntil,
  fetchReleaseNote,
  notice,
  readPackageVersion,
  compareVersions,
  isPrerelease,
  isBetaVersion,
  isMasterVersion,
  getChannel,
  readHeadSha,
  checkBeta,
  applyBetaUpdate,
  checkMaster,
  changesSince,
  applyMasterUpdate,
  checkForUpdate,
  preflightChecks,
  applyUpdate,
  applyRollback,
  isUpdaterAvailable,
  scheduleCleanExit,
  startBackgroundPolling,
  readSnapshotMeta,
};
