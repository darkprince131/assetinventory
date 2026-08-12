/**
 * session.js — signed, HttpOnly session cookies. No JWT library: an HMAC over a
 * compact JSON payload is all this needs, and node:crypto ships with the runtime.
 *
 * The browser never sees a Google token. It holds an opaque cookie it cannot
 * read (HttpOnly) and cannot be made to send cross-site (SameSite=Lax), which is
 * also what keeps the JSON API free of CSRF.
 */

const crypto = require('crypto');
const env = require('./env');

const COOKIE = 'at_session';

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function sign(data) {
  return b64url(crypto.createHmac('sha256', env.sessionSecret()).update(data).digest());
}

/** payload: { email, name } — returns the cookie value. */
function create(payload) {
  const body = {
    email: payload.email,
    name: payload.name || '',
    exp: Date.now() + env.sessionHours() * 3600 * 1000
  };
  const data = b64url(JSON.stringify(body));
  return data + '.' + sign(data);
}

/** Returns the payload, or null if absent, tampered with, or expired. */
function verify(cookieValue) {
  if (!cookieValue || typeof cookieValue !== 'string') return null;
  const dot = cookieValue.lastIndexOf('.');
  if (dot < 1) return null;

  const data = cookieValue.slice(0, dot);
  const mac = cookieValue.slice(dot + 1);
  const expected = sign(data);

  // Constant-time compare; lengths must match first or timingSafeEqual throws.
  if (mac.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;

  let body;
  try { body = JSON.parse(unb64url(data).toString('utf8')); } catch (e) { return null; }
  if (!body || !body.email) return null;
  if (!body.exp || body.exp < Date.now()) return null;
  return body;
}

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i < 0) return;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function fromRequest(headers) {
  const raw = headers.cookie || headers.Cookie || '';
  return verify(parseCookies(raw)[COOKIE]);
}

function setCookie(value, maxAgeSeconds) {
  const bits = [
    COOKIE + '=' + encodeURIComponent(value),
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=' + maxAgeSeconds
  ];
  // Secure would make the cookie unusable on plain-http local dev.
  if (env.siteUrl().indexOf('https://') === 0) bits.push('Secure');
  return bits.join('; ');
}

module.exports = {
  COOKIE,
  create,
  verify,
  fromRequest,
  parseCookies,
  cookieHeader: value => setCookie(value, env.sessionHours() * 3600),
  clearHeader: () => setCookie('', 0),
  b64url,
  unb64url
};
