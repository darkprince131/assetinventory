/**
 * passwords.js — scrypt hashing and the credential table.
 *
 * Passwords rather than SSO because the alternatives all cost something the
 * project does not have: Google sign-in needs a Cloud OAuth client, and
 * magic links need an email service above Supabase's free-tier rate limit.
 *
 * Stored format: scrypt$N$r$p$<salt base64>$<hash base64>
 */

const crypto = require('crypto');
const db = require('./supabase');

const N = 16384, R = 8, P = 1, KEYLEN = 32;
const MAX_ATTEMPTS = 8;
const LOCKOUT_MINUTES = 15;
const MIN_LENGTH = 10;

function hash(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(password), salt, KEYLEN, { N, r: R, p: P });
  return ['scrypt', N, R, P, salt.toString('base64'), derived.toString('base64')].join('$');
}

function verify(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  let derived;
  try {
    derived = crypto.scryptSync(String(password), Buffer.from(saltB64, 'base64'), KEYLEN,
      { N: Number(n), r: Number(r), p: Number(p) });
  } catch (e) {
    return false;
  }
  const expected = Buffer.from(hashB64, 'base64');
  if (expected.length !== derived.length) return false;
  return crypto.timingSafeEqual(expected, derived);
}

/** Rejects the passwords that make a breach trivial, without being precious. */
function checkStrength(password) {
  const p = String(password || '');
  if (p.length < MIN_LENGTH) throw new Error('Use at least ' + MIN_LENGTH + ' characters.');
  if (/^\d+$/.test(p)) throw new Error('Use more than just digits.');
  const common = ['password', 'passw0rd', '1234567890', 'qwertyuiop', 'letmein123', 'assettracker'];
  if (common.indexOf(p.toLowerCase()) >= 0) throw new Error('That password is too easy to guess.');
  return true;
}

async function find(email) {
  const rows = await db.selectWhere('auth_credentials', 'email=eq.' + encodeURIComponent(String(email).toLowerCase()));
  return rows[0] || null;
}

async function create(email, password, mustChange) {
  checkStrength(password);
  return db.insert('auth_credentials', [{
    email: String(email).toLowerCase(),
    password_hash: hash(password),
    must_change: mustChange !== false
  }]);
}

async function setPassword(email, password, mustChange) {
  checkStrength(password);
  const existing = await find(email);
  if (!existing) return create(email, password, mustChange);
  return db.update('auth_credentials', 'email=eq.' + encodeURIComponent(String(email).toLowerCase()), {
    password_hash: hash(password),
    must_change: mustChange === true,
    failed_attempts: 0,
    locked_until: null,
    updated_at: new Date().toISOString()
  }, { returning: false });
}

function lockedFor(row) {
  if (!row || !row.locked_until) return 0;
  const ms = new Date(row.locked_until).getTime() - Date.now();
  return ms > 0 ? Math.ceil(ms / 60000) : 0;
}

async function noteFailure(row) {
  const attempts = (row.failed_attempts || 0) + 1;
  const patch = { failed_attempts: attempts };
  if (attempts >= MAX_ATTEMPTS) {
    patch.locked_until = new Date(Date.now() + LOCKOUT_MINUTES * 60000).toISOString();
    patch.failed_attempts = 0;
  }
  await db.update('auth_credentials', 'email=eq.' + encodeURIComponent(row.email), patch, { returning: false });
}

async function noteSuccess(row) {
  if (!row.failed_attempts && !row.locked_until) return;
  await db.update('auth_credentials', 'email=eq.' + encodeURIComponent(row.email),
    { failed_attempts: 0, locked_until: null }, { returning: false });
}

module.exports = {
  hash, verify, checkStrength, find, create, setPassword,
  lockedFor, noteFailure, noteSuccess,
  MIN_LENGTH, MAX_ATTEMPTS, LOCKOUT_MINUTES
};
