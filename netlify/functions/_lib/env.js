/**
 * env.js — configuration, read once and validated loudly.
 * Everything secret comes from Netlify environment variables. Nothing here is
 * ever sent to the browser.
 */

function required(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) {
    throw new Error('Missing environment variable ' + name + '. See docs/NETLIFY.md.');
  }
  return String(v).trim();
}

function optional(name, fallback) {
  const v = process.env[name];
  return (v === undefined || v === null || String(v).trim() === '') ? fallback : String(v).trim();
}

/**
 * Netlify stores multi-line values with literal \n. Both forms are accepted so
 * pasting the raw PEM also works.
 */
function privateKey() {
  return required('GOOGLE_PRIVATE_KEY').replace(/\\n/g, '\n');
}

/** The site's own origin, used to build the OAuth redirect URI. */
function siteUrl() {
  const explicit = optional('PUBLIC_SITE_URL', '');
  if (explicit) return explicit.replace(/\/$/, '');
  // Netlify sets these automatically. DEPLOY_PRIME_URL covers branch/preview builds.
  const netlify = optional('DEPLOY_PRIME_URL', '') || optional('URL', '');
  if (netlify) return netlify.replace(/\/$/, '');
  return 'http://localhost:8888';
}

const env = {
  sheetId: () => required('GOOGLE_SHEET_ID'),
  serviceAccountEmail: () => required('GOOGLE_SERVICE_ACCOUNT_EMAIL'),
  privateKey,
  oauthClientId: () => required('GOOGLE_OAUTH_CLIENT_ID'),
  oauthClientSecret: () => required('GOOGLE_OAUTH_CLIENT_SECRET'),
  sessionSecret: () => required('SESSION_SECRET'),
  /** Optional: restrict sign-in to one Workspace domain, e.g. "example.com". */
  allowedDomain: () => optional('ALLOWED_DOMAIN', ''),
  sessionHours: () => Number(optional('SESSION_HOURS', '12')),
  lockTimeoutMs: () => Number(optional('LOCK_TIMEOUT_MS', '30000')),
  /** Seconds a warm container may reuse the tab list. Values are never cached. */
  metadataCacheSeconds: () => Number(optional('METADATA_CACHE_SECONDS', '60')),
  siteUrl,
  redirectUri: () => siteUrl() + '/api/auth/callback',
  isProduction: () => optional('CONTEXT', 'dev') === 'production',

  /** Fails fast at boot with one message listing everything missing. */
  check() {
    const missing = [];
    ['GOOGLE_SHEET_ID', 'GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_PRIVATE_KEY',
     'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'SESSION_SECRET'].forEach(n => {
      if (!process.env[n] || !String(process.env[n]).trim()) missing.push(n);
    });
    if (missing.length) {
      throw new Error('The backend is not configured. Missing: ' + missing.join(', ') +
        '. Set these in Netlify → Site configuration → Environment variables (see docs/NETLIFY.md).');
    }
  }
};

module.exports = env;
