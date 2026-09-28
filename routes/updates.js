// ============================================================
// ShowPilot — In-app updater routes (v0.33.0+)
// ============================================================
// Wraps lib/updater.js with HTTP endpoints. Auth applied at mount
// time in server.js (requireAdmin). Mounted as a sibling of the
// /api/admin/backup and /api/admin/cloudflared routers.
//
// All endpoints return 503 when the updater is unavailable (Docker
// container, demo mode) so the UI can render its own "no updates here"
// state without separately probing capabilities.

const express = require('express');
const router = express.Router();

const updater = require('../lib/updater');
const db = require('../lib/db');
const supervisor = require('../lib/process-supervisor');
const config = require('../lib/config-loader');

router.use(express.json({ limit: '1mb' }));

// Shared response builder for both /status and /check (the only
// difference being whether the GitHub fetch is forced).
async function buildStatusResponse({ force }) {
  const current = updater.readPackageVersion();
  const check = await updater.checkForUpdate({ force });
  const updateState = db.getUpdateState();
  const snapshotMeta = updater.readSnapshotMeta();

  const latestTag = check.latest && check.latest.tag;
  const updateAvailable = latestTag
    ? updater.compareVersions(latestTag, current) > 0
    : false;
  // Beta channel (v0.33.219+). A beta build can be numerically newer than
  // the latest stable, so the normal check never offers stable again —
  // returnToStable does, whenever this install runs a prerelease.
  const betaCheck = await updater.checkBeta({ force });
  const onBeta = updater.isPrerelease(current);
  // The beta channel is only offered when a beta NEWER than this install
  // exists (v0.33.222+). Betas are published only when there's something to
  // test, so most of the time there's none and the section stays hidden.
  // Also offered when this install runs a beta and the beta branch holds
  // different code under the same version number (a rebuilt beta).
  let betaAvailable = !!(betaCheck.beta && betaCheck.beta.version &&
    updater.compareVersions(betaCheck.beta.version, current) > 0);
  if (!betaAvailable && onBeta && betaCheck.beta && betaCheck.beta.version &&
      updater.compareVersions(betaCheck.beta.version, current) === 0) {
    const head = await updater.readHeadSha();
    if (head && head !== betaCheck.beta.sha) betaAvailable = true;
  }

  return {
    currentVersion: current,
    latestVersion: latestTag,
    latestRelease: check.latest,
    updateAvailable,
    updaterAvailable: updater.isUpdaterAvailable(),
    supervisor: supervisor.detectSupervisor(),
    isDocker: supervisor.detectSupervisor() === 'docker',
    isDemoMode: !!config.demoMode,
    lastCheckAt: check.at ? new Date(check.at).toISOString() : null,
    lastCheckError: check.error || null,
    onBeta,
    returnToStable: (onBeta && latestTag && !updateAvailable) ? latestTag : null,
    beta: betaCheck.beta,
    betaAvailable,
    betaCheckError: betaCheck.error || null,
    rollback: (updateState && updateState.previous_version_sha && snapshotMeta) ? {
      previousVersionTag: updateState.previous_version_tag,
      snapshotVersion: snapshotMeta.version,
      snapshotCreatedAt: snapshotMeta.createdAt,
      lastUpdateAt: updateState.last_update_at,
    } : null,
  };
}

// ------------------------------------------------------------
// GET /api/admin/updates/status
// ------------------------------------------------------------
// Returns current version, latest known version, supervisor info,
// rollback availability, and whether the updater is permitted to act
// on this deployment. The UI calls this on page load and after every
// action.
router.get('/status', async (req, res) => {
  try {
    res.json(await buildStatusResponse({ force: false }));
  } catch (err) {
    console.error('[updates/status] failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------
// POST /api/admin/updates/check
// ------------------------------------------------------------
// Force a fresh GitHub API check, bypassing the in-memory cache.
// Returns the same shape as /status so the UI can refresh in one call.
router.post('/check', async (req, res) => {
  try {
    res.json(await buildStatusResponse({ force: true }));
  } catch (err) {
    console.error('[updates/check] failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------
// POST /api/admin/updates/apply
// ------------------------------------------------------------
// Applies the latest release. Body: { tag: string } — required so the
// UI can confirm what the user clicked Update on, even if a newer
// release lands between page load and click.
router.post('/apply', async (req, res) => {
  if (!updater.isUpdaterAvailable()) {
    return res.status(503).json({
      error: supervisor.detectSupervisor() === 'docker'
        ? 'In-app updates are disabled in Docker — this container is managed by its host (e.g. Watchtower).'
        : 'In-app updates are disabled.'
    });
  }

  const { tag, force } = req.body || {};
  if (!tag || typeof tag !== 'string') {
    return res.status(400).json({ error: 'tag is required' });
  }

  // Confirm the requested tag matches what we believe is latest.
  // Prevents replay-style mistakes where a stale browser tab clicks
  // an old tag after newer releases have shipped.
  const check = await updater.checkForUpdate({ force: false });
  if (!check.latest || check.latest.tag !== tag) {
    return res.status(409).json({
      error: 'Tag does not match the latest release; please refresh.',
      requestedTag: tag,
      latestTag: check.latest && check.latest.tag,
    });
  }

  try {
    const result = await updater.applyUpdate(tag, { force: force === true });
    res.json({
      ok: true,
      message: 'Update applied. Restarting now…',
      previousVersion: result.previousVersion,
      previousSha: result.previousSha,
      targetTag: result.targetTag,
    });
    updater.scheduleCleanExit('apply update to ' + tag);
  } catch (err) {
    console.error('[updates/apply] failed:', err);
    if (err.preflightErrors) {
      return res.status(409).json({
        error: 'Pre-flight checks failed',
        preflightErrors: err.preflightErrors,
      });
    }
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------
// POST /api/admin/updates/apply-beta  (v0.33.219+)
// ------------------------------------------------------------
// Installs the latest beta build — debugging and testing only. Body:
// { sha: string, acknowledged: true, force?: boolean }. `acknowledged`
// must be sent explicitly (the UI's "I understand" box), and the sha must
// still be the tip of the beta branch.
router.post('/apply-beta', async (req, res) => {
  if (!updater.isUpdaterAvailable()) {
    return res.status(503).json({
      error: supervisor.detectSupervisor() === 'docker'
        ? 'In-app updates are disabled in Docker. To test a beta, run the :beta image instead.'
        : 'In-app updates are disabled.'
    });
  }
  const { sha, acknowledged, force } = req.body || {};
  if (acknowledged !== true) {
    return res.status(400).json({ error: 'Beta builds are for debugging and testing only; acknowledgement is required.' });
  }
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) {
    return res.status(400).json({ error: 'sha is required' });
  }
  const check = await updater.checkBeta({ force: true });
  if (!check.beta || check.beta.sha !== sha) {
    return res.status(409).json({ error: 'The beta build changed since this page loaded; please refresh.', latestSha: check.beta && check.beta.sha });
  }
  const installed = updater.readPackageVersion();
  const cmp = check.beta.version ? updater.compareVersions(check.beta.version, installed) : -1;
  let allowed = cmp > 0;
  if (!allowed && cmp === 0 && updater.isPrerelease(installed)) {
    const head = await updater.readHeadSha();
    allowed = !!(head && head !== check.beta.sha);   // same version, rebuilt beta
  }
  if (!allowed) {
    return res.status(409).json({ error: 'No beta newer than this version is available.' });
  }
  try {
    const result = await updater.applyBetaUpdate(sha, { force: force === true });
    res.json({ ok: true, message: 'Beta installed. Restarting now…', previousVersion: result.previousVersion, target: result.target });
    updater.scheduleCleanExit('apply beta ' + result.target);
  } catch (err) {
    console.error('[updates/apply-beta] failed:', err);
    if (err.preflightErrors) return res.status(409).json({ error: 'Pre-flight checks failed', preflightErrors: err.preflightErrors });
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------
// POST /api/admin/updates/rollback
// ------------------------------------------------------------
// Reverts to the previous version. No body required — there's only
// ever one previous version on disk.
router.post('/rollback', async (req, res) => {
  if (!updater.isUpdaterAvailable()) {
    return res.status(503).json({ error: 'Rollback is disabled in this deployment.' });
  }

  try {
    const result = await updater.applyRollback();
    res.json({
      ok: true,
      message: `Rolled back to ${result.rolledBackTo}. Restarting now…`,
      rolledBackTo: result.rolledBackTo,
    });
    updater.scheduleCleanExit('rollback to ' + result.rolledBackTo);
  } catch (err) {
    console.error('[updates/rollback] failed:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
