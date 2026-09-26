'use strict';
// Song progress bar on the viewer page (v0.33.206+).
//
// One place that turns the config row into the small object the viewer
// page receives (bootstrap and every /api/state poll), with values
// normalized so the client never sees anything unexpected. The color is
// applied client-side through element.style (never string-built CSS), so
// an odd value is simply ignored by the browser.
function progressBarConfig(cfg) {
  const c = cfg || {};
  const position = c.viewer_progress_bar_position === 'bottom' ? 'bottom' : 'top';
  let color = typeof c.viewer_progress_bar_color === 'string' ? c.viewer_progress_bar_color.trim() : '';
  if (color.length > 40) color = '';
  return {
    enabled: c.viewer_progress_bar === 1,
    position,
    showTime: c.viewer_progress_bar_show_time !== 0,
    color,
  };
}

module.exports = { progressBarConfig };
