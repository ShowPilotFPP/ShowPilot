'use strict';
// Listen-on-Phone launcher button colors (v0.33.249+).
//
// Turns the config row into the small object the viewer page receives
// (bootstrap and every /api/state poll), so admin changes reach open pages
// without a reload. Only '#rrggbb' values pass (the admin uses a color
// picker); anything else becomes '' = built-in default (red button, white
// icon). The client sets these as the --sp-launcher-bg / --sp-launcher-fg
// CSS variables on the button, so an empty value lets a template's own
// --sp-launcher-* variables (or the built-in default) apply.
const HEX = /^#[0-9a-f]{6}$/i;

function hexOrEmpty(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  return HEX.test(s) ? s.toLowerCase() : '';
}

function launcherColors(cfg) {
  const c = cfg || {};
  return {
    bg: hexOrEmpty(c.launcher_bg_color),
    fg: hexOrEmpty(c.launcher_fg_color),
  };
}

module.exports = { launcherColors, hexOrEmpty };
