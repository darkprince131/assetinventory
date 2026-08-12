/**
 * auth-password.js — sign in, change your own password, and (for Admins) set
 * someone else's. Used when the data backend is Supabase.
 *
 *   POST /api/auth/password  { action: "login",  email, password }
 *                            { action: "change", currentPassword, newPassword }
 *                            { action: "set",    email, password }   (Admin only)
 *
 * The session cookie is the same one the Google flow issues: HttpOnly, signed,
 * SameSite=Lax. Nothing about the rest of the app changes.
 */

const env = require('./_lib/env');
const session = require('./_lib/session');
const passwords = require('./_lib/passwords');
const runtime = require('./_lib/runtime');

function reply(status, body, extraHeaders) {
  return {
    statusCode: status,
    headers: Object.assign({ 'content-type': 'application/json', 'cache-control': 'no-store' }, extraHeaders || {}),
    body: JSON.stringify(body)
  };
}

/** Deliberately vague: never reveal whether an address exists. */
const BAD_CREDENTIALS = 'That email and password combination is not recognised.';

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Use POST.' }, { allow: 'POST' });

  try {
    env.check();
  } catch (e) {
    return reply(500, { ok: false, error: e.message });
  }
  if (env.authMode() !== 'password') {
    return reply(400, { ok: false, error: 'This deployment uses Google sign-in.' });
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch (e) { return reply(400, { ok: false, error: 'Malformed request body.' }); }

  try {
    if (payload.action === 'login') return await login(payload);
    if (payload.action === 'change') return await change(event, payload);
    if (payload.action === 'set') return await setForUser(event, payload);
    return reply(400, { ok: false, error: 'Unknown action.' });
  } catch (e) {
    console.error('[asset-tracker] auth-password ' + payload.action + ' failed: ' + (e.stack || e.message));
    return reply(400, { ok: false, error: e.message });
  }
};

async function login(payload) {
  const email = String(payload.email || '').trim().toLowerCase();
  const password = String(payload.password || '');
  if (!email || !password) return reply(400, { ok: false, error: 'Enter your email and password.' });

  let row = await passwords.find(email);

  // One-time bootstrap so the first administrator can get in at all.
  if (!row && env.bootstrapEmail() && email === env.bootstrapEmail()) {
    const expected = env.bootstrapPassword();
    if (!expected) return reply(400, { ok: false, error: 'BOOTSTRAP_PASSWORD is not set.' });
    if (password !== expected) return reply(401, { ok: false, error: BAD_CREDENTIALS });
    await passwords.create(email, password, true);
    console.log('[asset-tracker] bootstrap account created for ' + email);
    row = await passwords.find(email);
  }

  if (!row) {
    // Spend roughly the same time as a real check so timing says nothing.
    passwords.verify(password, passwords.hash('decoy-value-for-constant-time'));
    return reply(401, { ok: false, error: BAD_CREDENTIALS });
  }

  const lockedMinutes = passwords.lockedFor(row);
  if (lockedMinutes) {
    return reply(429, { ok: false, error: 'Too many failed attempts. Try again in ' + lockedMinutes + ' minutes.' });
  }

  if (!passwords.verify(password, row.password_hash)) {
    await passwords.noteFailure(row);
    return reply(401, { ok: false, error: BAD_CREDENTIALS });
  }

  await passwords.noteSuccess(row);
  return reply(200,
    { ok: true, mustChange: row.must_change === true },
    { 'set-cookie': session.cookieHeader(session.create({ email, name: email.split('@')[0] })) }
  );
}

async function change(event, payload) {
  const user = session.fromRequest(event.headers || {});
  if (!user) return reply(401, { ok: false, needsAuth: true, error: 'Sign in first.' });

  const row = await passwords.find(user.email);
  if (!row) return reply(400, { ok: false, error: 'No password is set for this account.' });
  if (!passwords.verify(String(payload.currentPassword || ''), row.password_hash)) {
    return reply(401, { ok: false, error: 'Your current password is not correct.' });
  }
  if (String(payload.newPassword || '') === String(payload.currentPassword || '')) {
    return reply(400, { ok: false, error: 'The new password must be different.' });
  }

  await passwords.setPassword(user.email, String(payload.newPassword || ''), false);
  return reply(200, { ok: true });
}

/** Admin sets or resets another person's password. */
async function setForUser(event, payload) {
  const user = session.fromRequest(event.headers || {});
  if (!user) return reply(401, { ok: false, needsAuth: true, error: 'Sign in first.' });

  // Role is decided by the same Auth.gs the rest of the app uses.
  await runtime.run('api_bootstrap', [], { email: user.email, name: user.name })
    .then(boot => {
      if (!boot || boot.user.role !== 'Admin') {
        throw new Error('You need Admin access to set someone else\'s password.');
      }
    });

  const email = String(payload.email || '').trim().toLowerCase();
  if (!email) throw new Error('Which account?');
  await passwords.setPassword(email, String(payload.password || ''), true);
  console.log('[asset-tracker] ' + user.email + ' set the password for ' + email);
  return reply(200, { ok: true, email, mustChange: true });
}
