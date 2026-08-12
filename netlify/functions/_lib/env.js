/**
 * env.js — configuration, read once and validated loudly.
 * Everything secret comes from Netlify environment variables. Nothing here is
 * ever sent to the browser.
 *
 * Two data backends are supported. Setting SUPABASE_URL selects Postgres;
 * otherwise the Google Sheet is used. The app is identical either way.
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

/** The site's own origin, used to build redirect URIs. */
function siteUrl() {
  const explicit = optional('PUBLIC_SITE_URL', '');
  if (explicit) return explicit.replace(/\/$/, '');
  // Netlify sets these automatically. DEPLOY_PRIME_URL covers branch/preview builds.
  const netlify = optional('DEPLOY_PRIME_URL', '') || optional('URL', '');
  if (netlify) return netlify.replace(/\/$/, '');
  return 'http://localhost:8888';
}

/** 'supabase' when SUPABASE_URL is set, otherwise 'sheets'. */
function dataBackend() {
  const forced = optional('DATA_BACKEND', '');
  if (forced) return forced;
  return optional('SUPABASE_URL', '') ? 'supabase' : 'sheets';
}

/**
 * 'password' on Supabase (self-contained, no third-party service),
 * 'google' on Sheets (Workspace sign-in via OAuth).
 */
function authMode() {
  const forced = optional('AUTH_MODE', '');
  if (forced) return forced;
  return dataBackend() === 'supabase' ? 'password' : 'google';
}

const env = {
  dataBackend,
  authMode,

  // Google Sheets backend
  sheetId: () => required('GOOGLE_SHEET_ID'),
  serviceAccountEmail: () => required('GOOGLE_SERVICE_ACCOUNT_EMAIL'),
  privateKey,
  oauthClientId: () => required('GOOGLE_OAUTH_CLIENT_ID'),
  oauthClientSecret: () => required('GOOGLE_OAUTH_CLIENT_SECRET'),

  // Supabase backend
  supabaseUrl: () => required('SUPABASE_URL').replace(/\/$/, ''),
  supabaseServiceKey: () => required('SUPABASE_SERVICE_ROLE_KEY'),

  sessionSecret: () => required('SESSION_SECRET'),
  /** Optional: restrict Google sign-in to one Workspace domain. */
  allowedDomain: () => optional('ALLOWED_DOMAIN', ''),
  sessionHours: () => Number(optional('SESSION_HOURS', '12')),
  lockTimeoutMs: () => Number(optional('LOCK_TIMEOUT_MS', '30000')),
  /** Seconds a warm container may reuse the tab list. Values are never cached. */
  metadataCacheSeconds: () => Number(optional('METADATA_CACHE_SECONDS', '60')),

  /**
   * One-time bootstrap for password auth: the first sign-in with this address
   * and password creates the account and makes it Admin. Remove both variables
   * once you are in.
   */
  bootstrapEmail: () => optional('BOOTSTRAP_EMAIL', '').toLowerCase(),
  bootstrapPassword: () => optional('BOOTSTRAP_PASSWORD', ''),

  siteUrl,
  redirectUri: () => siteUrl() + '/api/auth/callback',
  isProduction: () => optional('CONTEXT', 'dev') === 'production',

  /** Fails fast with one message listing everything missing for this backend. */
  check() {
    const needed = dataBackend() === 'supabase'
      ? ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SESSION_SECRET']
      : ['GOOGLE_SHEET_ID', 'GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_PRIVATE_KEY',
         'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'SESSION_SECRET'];

    const missing = needed.filter(n => !process.env[n] || !String(process.env[n]).trim());
    if (missing.length) {
      throw new Error('The backend is not configured. Missing: ' + missing.join(', ') +
        '. Set these in Netlify → Site configuration → Environment variables (see docs/NETLIFY.md).');
    }
  }
};

module.exports = env;
