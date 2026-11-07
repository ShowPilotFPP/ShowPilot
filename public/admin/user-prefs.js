// ============================================================
// ShowPilot admin — per-user view preferences (v0.33.277)
// ============================================================
// View choices (compact rows, switch icons, column order and widths,
// pinned sidebar, dismissed banners…) are saved on the signed-in user, so
// they follow you to any browser or device. Before this they were only in
// the browser's localStorage; on the first sign-in in a browser, whatever
// that browser had is copied to the account if the account doesn't have it.
//
//   SPPrefs.get(key)          -> string or null
//   SPPrefs.set(key, value)   -> value is a string, or null to forget it
//   SPPrefs.load(prefs)       -> called once with /api/admin/me's uiPrefs
//
// localStorage stays as a cache, so the page still works if the server
// can't be reached. Keys look like sp_xxx or sp-xxx.
// ============================================================
(function (root) {
  'use strict';
  const KNOWN = ['sp_seq_compact', 'sp_seq_flag_icons', 'sp_seq_hidden_cols', 'sp_seq_col_order',
    'sp-seq-col-widths-v3', 'sp_rail_pinned', 'sp_top_hide_psa', 'sp_showpilot_update_dismissed',
    'sp_player_update_dismissed', 'sp_norm_match'];
  let prefs = null;          // null until /me has been loaded
  let pending = {};
  let timer = null;

  function ls(op, k, v) {
    try {
      if (op === 'get') return root.localStorage.getItem(k);
      if (v == null) root.localStorage.removeItem(k); else root.localStorage.setItem(k, v);
    } catch (_) { return null; }
    return null;
  }

  function flush() {
    timer = null;
    const body = pending; pending = {};
    if (!Object.keys(body).length) return;
    fetch('/api/admin/me/prefs', {
      method: 'PUT', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefs: body }),
    }).catch(() => { /* kept in localStorage; next change retries */ Object.assign(pending, body); });
  }
  function queue(k, v) {
    pending[k] = v;
    if (!timer) timer = setTimeout(flush, 600);
  }

  const api = {
    get(k) {
      if (prefs && Object.prototype.hasOwnProperty.call(prefs, k)) return prefs[k];
      return ls('get', k);
    },
    set(k, v) {
      const val = v == null ? null : String(v);
      if (prefs) { if (val == null) delete prefs[k]; else prefs[k] = val; }
      ls('set', k, val);
      queue(k, val);
    },
    load(serverPrefs) {
      prefs = (serverPrefs && typeof serverPrefs === 'object') ? { ...serverPrefs } : {};
      // First sign-in in this browser: bring over what it already had.
      for (const k of KNOWN) {
        if (Object.prototype.hasOwnProperty.call(prefs, k)) { ls('set', k, prefs[k]); continue; }
        const local = ls('get', k);
        if (local != null) { prefs[k] = local; queue(k, local); }
      }
    },
  };
  root.SPPrefs = api;
})(window);
