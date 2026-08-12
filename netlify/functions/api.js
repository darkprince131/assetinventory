/**
 * api.js — the single JSON endpoint the client talks to.
 *
 *   POST /api  { "fn": "api_getAssets", "args": [false] }
 *   → 200 { ok: true, result }
 *   → 401 { ok: false, error, needsAuth: true }
 *   → 4xx/5xx { ok: false, error }
 *
 * CSRF: the session cookie is SameSite=Lax and this endpoint only accepts POST
 * with a JSON content type, so a cross-site form post carries no cookie and a
 * cross-site fetch is stopped by the preflight (no CORS headers are sent).
 */

const env = require('./_lib/env');
const session = require('./_lib/session');
const runtime = require('./_lib/runtime');

const JSON_HEADERS = {
  'content-type': 'application/json',
  'cache-control': 'no-store'
};

function reply(status, body, extraHeaders) {
  return {
    statusCode: status,
    headers: Object.assign({}, JSON_HEADERS, extraHeaders || {}),
    body: JSON.stringify(body)
  };
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: { allow: 'POST' } };
  if (event.httpMethod !== 'POST') {
    return reply(405, { ok: false, error: 'Use POST.' }, { allow: 'POST' });
  }

  const contentType = String(event.headers['content-type'] || event.headers['Content-Type'] || '');
  if (contentType.indexOf('application/json') < 0) {
    return reply(415, { ok: false, error: 'Send application/json.' });
  }

  try {
    env.check();
  } catch (e) {
    console.error('[asset-tracker] configuration error: ' + e.message);
    return reply(500, { ok: false, error: e.message });
  }

  const user = session.fromRequest(event.headers || {});
  if (!user) {
    // The client renders a different sign-in screen per mode.
    return reply(401, {
      ok: false,
      needsAuth: true,
      authMode: env.authMode(),
      loginUrl: '/api/auth/login',
      error: 'Sign in to continue.'
    });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return reply(400, { ok: false, error: 'Malformed request body.' });
  }

  const fn = payload.fn;
  const args = payload.args || [];
  if (!Array.isArray(args)) return reply(400, { ok: false, error: 'args must be an array.' });

  try {
    const result = await runtime.run(fn, args, { email: user.email, name: user.name });
    return reply(200, { ok: true, result: result === undefined ? null : result });
  } catch (e) {
    // Permission failures raised by Auth.gs are 403; everything else the logic
    // rejects is a bad request.
    const denied = /No access|Sign in with|You need (Admin|Editor|Viewer) access/.test(e.message);
    const status = e.status || (denied ? 403 : 400);
    // Anything unexpected is worth a stack in the function log; the user gets
    // the message only.
    if (status >= 500 || !e.status) console.error('[asset-tracker] ' + fn + ' failed: ' + (e.stack || e.message));
    return reply(status, { ok: false, error: e.message || 'Something failed on the server.' });
  }
};
