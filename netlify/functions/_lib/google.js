/**
 * google.js — everything that talks to Google, with no SDK.
 *
 *  - a service-account access token (signed JWT grant) for the Sheets API
 *  - the OAuth authorisation-code exchange for signing users in
 *  - thin wrappers over the Sheets REST endpoints
 */

const crypto = require('crypto');
const env = require('./env');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---------------------------------------------------------------- service account

let cachedToken = null; // { token, exp } — reused while the container is warm

async function accessToken() {
  if (cachedToken && cachedToken.exp > Date.now() + 60000) return cachedToken.token;

  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: env.serviceAccountEmail(),
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600
  }));

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(header + '.' + claims);
  const signature = b64url(signer.sign(env.privateKey()));
  const assertion = header + '.' + claims + '.' + signature;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    })
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error('Could not authenticate to Google Sheets (' + res.status + '): ' +
      (body.error_description || body.error || 'unknown error') +
      '. Check GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY.');
  }
  cachedToken = { token: body.access_token, exp: Date.now() + (body.expires_in || 3600) * 1000 };
  return cachedToken.token;
}

async function sheetsFetch(pathAndQuery, options) {
  const token = await accessToken();
  const res = await fetch(SHEETS + '/' + env.sheetId() + pathAndQuery, Object.assign({}, options, {
    headers: Object.assign({
      authorization: 'Bearer ' + token,
      'content-type': 'application/json'
    }, (options && options.headers) || {})
  }));

  const text = await res.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch (e) { body = { raw: text }; }

  if (!res.ok) {
    const msg = (body.error && body.error.message) || body.raw || res.statusText;
    if (res.status === 403) {
      throw new Error('Google Sheets refused access (403): ' + msg +
        '. Share the spreadsheet with ' + env.serviceAccountEmail() + ' as an Editor.');
    }
    if (res.status === 404) {
      throw new Error('Spreadsheet not found (404). Check GOOGLE_SHEET_ID.');
    }
    if (res.status === 429) {
      throw new Error('Google Sheets rate limit reached. Wait a moment and retry.');
    }
    throw new Error('Google Sheets error (' + res.status + '): ' + msg);
  }
  return body;
}

// -------------------------------------------------------------------- sheets API

/**
 * Tab names and ids, so the adapter knows what exists before reading.
 *
 * Cached briefly per warm container: the tab list almost never changes, and
 * Sheets bills reads per service account (60/min), so halving the calls per
 * request matters more than freshness here. Any structural change clears it.
 */
let cachedMeta = null;

async function getMetadata() {
  if (cachedMeta && cachedMeta.exp > Date.now()) return cachedMeta.value;
  const body = await sheetsFetch('?fields=sheets(properties(sheetId,title,gridProperties))&includeGridData=false');
  const value = (body.sheets || []).map(s => ({
    title: s.properties.title,
    sheetId: s.properties.sheetId,
    rows: (s.properties.gridProperties || {}).rowCount || 1000,
    columns: (s.properties.gridProperties || {}).columnCount || 26
  }));
  cachedMeta = { value, exp: Date.now() + env.metadataCacheSeconds() * 1000 };
  return value;
}

function clearMetadataCache() { cachedMeta = null; }

/** One call for every tab. Dates come back as serial numbers. */
async function batchGet(titles) {
  if (!titles.length) return {};
  const params = new URLSearchParams();
  titles.forEach(t => params.append('ranges', "'" + t.replace(/'/g, "''") + "'"));
  params.set('valueRenderOption', 'UNFORMATTED_VALUE');
  params.set('dateTimeRenderOption', 'SERIAL_NUMBER');
  params.set('majorDimension', 'ROWS');

  const body = await sheetsFetch('/values:batchGet?' + params.toString());
  const out = {};
  (body.valueRanges || []).forEach((vr, i) => { out[titles[i]] = vr.values || []; });
  return out;
}

/** data: [{ range: "'Assets'!A2:AG5", values: [[...]] }] */
async function batchUpdate(data) {
  if (!data.length) return { updated: 0 };
  const body = await sheetsFetch('/values:batchUpdate', {
    method: 'POST',
    body: JSON.stringify({
      // USER_ENTERED so 'YYYY-MM-DD' lands as a real date, not text.
      valueInputOption: 'USER_ENTERED',
      data
    })
  });
  return { updated: body.totalUpdatedCells || 0 };
}

/** requests: raw spreadsheets.batchUpdate requests (addSheet, deleteSheet, …). */
async function structureUpdate(requests) {
  if (!requests.length) return {};
  const res = await sheetsFetch(':batchUpdate', {
    method: 'POST',
    body: JSON.stringify({ requests })
  });
  clearMetadataCache(); // tabs were added or removed
  return res;
}

async function clearRange(range) {
  return sheetsFetch('/values/' + encodeURIComponent(range) + ':clear', { method: 'POST', body: '{}' });
}

function spreadsheetUrl() {
  return 'https://docs.google.com/spreadsheets/d/' + env.sheetId() + '/edit';
}

// ------------------------------------------------------------------- user OAuth

function authorizeUrl(state) {
  const params = new URLSearchParams({
    client_id: env.oauthClientId(),
    redirect_uri: env.redirectUri(),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account'
  });
  const domain = env.allowedDomain();
  if (domain) params.set('hd', domain);
  return AUTH_URL + '?' + params.toString();
}

/**
 * Exchanges the code for tokens and returns the verified identity.
 *
 * The id_token comes straight from Google's token endpoint over TLS, so its
 * signature does not need re-checking (OIDC core §3.1.3.7) — but the claims do.
 */
async function exchangeCode(code) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.oauthClientId(),
      client_secret: env.oauthClientSecret(),
      redirect_uri: env.redirectUri(),
      grant_type: 'authorization_code'
    })
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error('Google sign-in failed (' + res.status + '): ' +
      (body.error_description || body.error || 'unknown error'));
  }
  if (!body.id_token) throw new Error('Google sign-in returned no identity token.');

  const parts = String(body.id_token).split('.');
  if (parts.length !== 3) throw new Error('Malformed identity token from Google.');

  let claims;
  try {
    claims = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch (e) {
    throw new Error('Could not read the identity token from Google.');
  }

  if (claims.aud !== env.oauthClientId()) throw new Error('Identity token was issued for a different application.');
  if (['https://accounts.google.com', 'accounts.google.com'].indexOf(claims.iss) < 0) {
    throw new Error('Identity token has an unexpected issuer.');
  }
  if (claims.exp && claims.exp * 1000 < Date.now()) throw new Error('Identity token has already expired.');
  if (!claims.email) throw new Error('Google did not return an email address.');
  if (claims.email_verified === false) throw new Error('That Google account has an unverified email address.');

  const domain = env.allowedDomain();
  if (domain && String(claims.email).split('@')[1].toLowerCase() !== domain.toLowerCase()) {
    throw new Error('Sign in with your ' + domain + ' account.');
  }

  return { email: String(claims.email).toLowerCase(), name: claims.name || '', picture: claims.picture || '' };
}

module.exports = {
  accessToken,
  getMetadata,
  batchGet,
  batchUpdate,
  structureUpdate,
  clearRange,
  spreadsheetUrl,
  authorizeUrl,
  exchangeCode,
  clearMetadataCache,
  _resetTokenCache: () => { cachedToken = null; cachedMeta = null; }
};
