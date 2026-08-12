/**
 * auth-callback.js — Google redirects back here with an authorisation code.
 * Verifies the state nonce, exchanges the code, and sets the session cookie.
 *
 * Being in the Users tab is NOT checked here: signing in and having access are
 * separate. Auth.gs decides access per call, so revoking someone is a single
 * edit in the sheet rather than a session to hunt down.
 */

const crypto = require('crypto');
const env = require('./_lib/env');
const google = require('./_lib/google');
const session = require('./_lib/session');

const STATE_COOKIE = 'at_oauth_state';

exports.handler = async function (event) {
  const params = event.queryStringParameters || {};

  if (params.error) {
    return html(400, 'Sign-in cancelled', 'Google reported: ' + params.error);
  }
  if (!params.code || !params.state) {
    return html(400, 'Sign-in failed', 'The response from Google was incomplete. Start again from the app.');
  }

  let state;
  try {
    state = JSON.parse(session.unb64url(params.state).toString('utf8'));
  } catch (e) {
    return html(400, 'Sign-in failed', 'The sign-in request could not be verified. Start again from the app.');
  }

  const cookies = session.parseCookies(event.headers.cookie || event.headers.Cookie || '');
  const expected = cookies[STATE_COOKIE] || '';
  if (!expected || !state.n || !timingSafeEqual(expected, state.n)) {
    return html(400, 'Sign-in failed',
      'The sign-in request could not be verified — it may have expired, or cookies may be blocked. Start again from the app.');
  }

  try {
    env.check();
    const identity = await google.exchangeCode(params.code);
    const cookie = session.create({ email: identity.email, name: identity.name });
    const secure = env.siteUrl().indexOf('https://') === 0 ? '; Secure' : '';

    return {
      statusCode: 302,
      multiValueHeaders: {
        'set-cookie': [
          session.cookieHeader(cookie),
          STATE_COOKIE + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + secure
        ]
      },
      headers: {
        location: typeof state.r === 'string' && state.r.indexOf('/') === 0 ? state.r : '/',
        'cache-control': 'no-store'
      },
      body: ''
    };
  } catch (e) {
    console.error('[asset-tracker] sign-in failed: ' + (e.stack || e.message));
    return html(400, 'Sign-in failed', e.message);
  }
};

function timingSafeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

function html(status, title, message) {
  const esc = s => String(s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  return {
    statusCode: status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    body: '<!doctype html><meta charset="utf-8"><title>' + esc(title) + '</title>' +
      '<div style="font:14px -apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:80px auto">' +
      '<h1 style="font-size:18px">' + esc(title) + '</h1>' +
      '<p style="color:#666">' + esc(message) + '</p>' +
      '<p><a href="/" style="color:#1a5fb4">Back to Asset Tracker</a></p></div>'
  };
}
