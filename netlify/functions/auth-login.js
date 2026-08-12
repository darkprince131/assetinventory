/**
 * auth-login.js — starts the Google sign-in redirect.
 *
 * The authorisation-code flow is used rather than a Google JavaScript widget:
 * no third-party script on the page (the CSP stays closed), and the resulting
 * session cookie is HttpOnly so no token is ever exposed to page scripts.
 */

const crypto = require('crypto');
const env = require('./_lib/env');
const google = require('./_lib/google');
const session = require('./_lib/session');

const STATE_COOKIE = 'at_oauth_state';

exports.handler = async function (event) {
  try {
    env.check();
  } catch (e) {
    return {
      statusCode: 500,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: page('Backend not configured', e.message)
    };
  }

  // CSRF protection for the callback: a nonce that must come back unchanged.
  const nonce = crypto.randomBytes(16).toString('hex');
  const returnTo = sanitiseReturn((event.queryStringParameters || {}).returnTo);
  const state = session.b64url(JSON.stringify({ n: nonce, r: returnTo }));

  const secure = env.siteUrl().indexOf('https://') === 0 ? '; Secure' : '';
  return {
    statusCode: 302,
    headers: {
      location: google.authorizeUrl(state),
      'set-cookie': STATE_COOKIE + '=' + nonce + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=600' + secure,
      'cache-control': 'no-store'
    },
    body: ''
  };
};

/** Only same-site paths may be returned to — never an absolute URL. */
function sanitiseReturn(value) {
  const v = String(value || '/');
  if (v.indexOf('//') === 0 || /^[a-z]+:/i.test(v)) return '/';
  return v.indexOf('/') === 0 ? v : '/';
}

function page(title, message) {
  return '<!doctype html><meta charset="utf-8"><title>' + title + '</title>' +
    '<div style="font:14px -apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:80px auto">' +
    '<h1 style="font-size:18px">' + title + '</h1><p style="color:#666">' +
    String(message).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])) + '</p></div>';
}

exports.STATE_COOKIE = STATE_COOKIE;
exports._sanitiseReturn = sanitiseReturn;
