// Is this request from a signed-in admin?
//
// The admin session cookie is sent with every request to the show's web
// address, viewer pages and viewer API calls included, so a phone that is
// signed in to /admin/ can be recognised on the viewer side too. Same test
// as requireAdmin in routes/admin.js: a valid, unexpired session for a user
// that still exists and is enabled. Never throws; anything wrong means "no".
//
// Cheap for ordinary viewers: they have no admin cookie, so it returns
// before any signature check or database lookup.
'use strict';
const config = require('./config-loader');

function isAdminRequest(req) {
  const token = req && req.cookies && req.cookies[config.sessionCookieName];
  if (!token) return false;
  try {
    const payload = require('jsonwebtoken').verify(token, config.jwtSecret);
    if (!payload || !payload.userId) return false;
    const user = require('./db').getUserById(payload.userId);
    return !!(user && user.enabled);
  } catch {
    return false;
  }
}

// Does this request skip the location checks (the GPS check and the audio
// distance limit)? Only when the owner turned on "Signed-in admins skip
// location checks" (admin_skip_location) and the request is from a
// signed-in admin. The setting is checked first, so with it off nothing
// else is looked at.
function skipsLocationChecks(req, cfg) {
  return !!cfg && cfg.admin_skip_location === 1 && isAdminRequest(req);
}

module.exports = { isAdminRequest, skipsLocationChecks };
