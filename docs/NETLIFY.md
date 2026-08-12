# The Netlify deployment

Same UI, same business logic as the Apps Script app, served as a static site with
Netlify Functions behind it and the Google Sheet still acting as the database.

Two build modes:

| `--backend=` | Data | Auth | Use |
|---|---|---|---|
| `http` *(default in netlify.toml)* | The shared Google Sheet, via the Sheets API | Google sign-in | The real thing |
| `demo` | This browser's localStorage | A fake local user, role switchable | Demos and review, no credentials needed |

```bash
node web/build.js --backend=demo && npx --yes serve web/public   # demo, runs anywhere
```

---

## How a request works

The shared logic in `/src/*.gs` is synchronous Apps Script code, so the async work
sits at the edges rather than being threaded through the middle:

```
POST /api {fn,args}
  → verify the session cookie
  → acquire the write lock          (writes only)
  → load the whole spreadsheet      (1 Sheets call)
  → run the logic synchronously against an in-memory grid
  → flush only the rows that changed (1 Sheets call)
  → release the lock
```

That is the same shape as the Apps Script runtime, which is why the logic files are
used **verbatim** — `tools/build-logic.js` concatenates them and the functions execute
them in a `vm` context with the Apps Script globals supplied by `runtime.js`.

```
netlify/functions/
  api.js              the one JSON endpoint: { fn, args } → { ok, result }
  auth-login.js       redirect to Google
  auth-callback.js    verify state, exchange code, set the session cookie
  auth-logout.js      clear the cookie
  _lib/
    env.js            configuration, validated with one clear error
    session.js        signed HttpOnly cookies (HMAC, no JWT library)
    google.js         service-account JWT, OAuth exchange, Sheets REST
    sheets-host.js    in-memory grid + load/flush + the write lock
    runtime.js        the vm sandbox and the read/write classification
    logic-bundle.js   GENERATED from /src/*.gs — gitignored
```

**No runtime dependencies.** The service-account JWT is signed with `node:crypto` and
every API call is `fetch`. Nothing to install, nothing to keep patched.

### What replaced each Apps Script service

| Apps Script | Here |
|---|---|
| `SpreadsheetApp` | In-memory grid loaded from / flushed to the Sheets API |
| `Session.getActiveUser()` | Google OAuth → signed session cookie |
| `LockService` | A mutex cell in a hidden `_System` tab |
| `CacheService` | Per-request memoisation (what makes repeated `DB.read` cheap) |
| `PropertiesService` | Per-request memory — see the limitation below |

### The write lock

`Utils.withLock` protects "mint an id, then append", which is the one place two writers
can corrupt each other. Containers share nothing, so the mutex lives in the sheet:
write a token to `_System!B1`, pause, read it back. If a competing writer landed after
us we see *their* token and back off; they see their own and proceed. Exactly one
winner per round, and a lock older than 30s is treated as abandoned.

Verified: five simultaneous asset creations produce five distinct ids and five rows.

---

## Setting it up

### 1. The spreadsheet

Create a blank Google Sheet. Its id is the long string in the URL:
`docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`.

You can point this at the *same* sheet an Apps Script deployment already uses — both
read and write the identical schema.

### 2. A service account (so the backend can read and write the sheet)

1. [Google Cloud console](https://console.cloud.google.com/) → create or pick a project.
2. **APIs & Services → Library → Google Sheets API → Enable**.
3. **IAM & Admin → Service Accounts → Create service account**. No roles needed.
4. On the new account: **Keys → Add key → Create new key → JSON**. It downloads once.
5. From that JSON you need `client_email` and `private_key`.
6. **Share the spreadsheet with `client_email` as an Editor.** This is the step people
   miss; without it every call fails with a 403 that names the address to share with.

### 3. An OAuth client (so people can sign in)

1. **APIs & Services → OAuth consent screen**. Choose **Internal** if this is a
   Workspace org — then only your own people can even attempt sign-in.
2. **Credentials → Create credentials → OAuth client ID → Web application**.
3. Authorised redirect URI — exactly, including the scheme:
   `https://YOUR-SITE.netlify.app/api/auth/callback`
4. Keep the client ID and client secret.

### 4. Environment variables

Netlify → Site configuration → Environment variables:

| Variable | Value |
|---|---|
| `GOOGLE_SHEET_ID` | The id from step 1 |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | `client_email` from the JSON key |
| `GOOGLE_PRIVATE_KEY` | `private_key` from the JSON key — paste it whole, `\n` escapes and real newlines both work |
| `GOOGLE_OAUTH_CLIENT_ID` | From step 3 |
| `GOOGLE_OAUTH_CLIENT_SECRET` | From step 3 |
| `SESSION_SECRET` | Any long random string — `openssl rand -base64 32`. Changing it signs everyone out |

Optional:

| Variable | Default | Effect |
|---|---|---|
| `ALLOWED_DOMAIN` | *(none)* | Restrict sign-in to one domain, e.g. `example.com` |
| `SESSION_HOURS` | `12` | How long a sign-in lasts |
| `LOCK_TIMEOUT_MS` | `30000` | How long a write waits for the lock |
| `METADATA_CACHE_SECONDS` | `60` | How long a warm container reuses the tab list |
| `PUBLIC_SITE_URL` | Netlify's `URL` | Override if the site is on a custom domain |

The private key is a credential to your spreadsheet. It belongs in Netlify's
environment only — never in the repo, and never in the client bundle. The build
refuses to ship server logic to the browser in `http` mode.

### 5. Deploy

`netlify.toml` already carries the settings:

```
command   = node tools/build-logic.js && node web/build.js --backend=http
publish   = web/public
functions = netlify/functions
```

### 6. First run — build the tabs

A blank spreadsheet has no tabs yet. Sign in to the deployed site, then run this in
the browser console (the session cookie goes along automatically):

```js
fetch('/api', { method: 'POST', credentials: 'same-origin',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ fn: 'setupSpreadsheet', args: [] })
}).then(r => r.json()).then(console.log)
```

That creates the nine tabs, seeds `Config`, and makes **you** the first Admin. Swap
`setupSpreadsheet` for `seedDemoData` to load ~80 sample assets, or `applyValidation`
to refresh the sheet's dropdowns after editing `Config`.

Then add your colleagues to the `Users` tab — the roles work exactly as they do on
Apps Script, because it is the same `Auth.gs`.

---

## Security notes

- **The session cookie is HttpOnly, SameSite=Lax and Secure.** Page scripts cannot read
  it, and it is not sent on cross-site requests — which is also why the JSON API needs
  no CSRF token. The API only accepts `POST` with `application/json` and sends no CORS
  headers, so a cross-origin caller cannot reach it either.
- **No Google token ever reaches the browser.** The authorisation-code flow keeps tokens
  server-side; there is no third-party script on the page, so the CSP stays closed
  (`script-src 'self'`, `connect-src 'self'`).
- **Signing in is not the same as having access.** Access is decided per call against the
  `Users` tab, so removing someone is one edit in the sheet — no session to hunt down.
- **Roles are enforced server-side.** Hiding buttons is a convenience; `Auth.require` is
  the actual boundary, and a Viewer calling the API directly is rejected.
- The state nonce on the OAuth redirect is compared in constant time, and `returnTo` only
  accepts same-site paths, so the sign-in link cannot be used as an open redirect.

## Known limitations

- **`PropertiesService` is per-request.** Only one thing depends on it:
  `Maintenance.previousStatus`, which pre-selects the status to restore when closing a
  repair. It will default to *In Stock* rather than remembering *Assigned*. The dialog
  still validates properly, so the effect is a worse default, nothing more. It could be
  derived from the AuditLog instead — the old value is already recorded there.
- **Sheets API quota.** Google allows 60 read requests per minute *per service account*.
  A read costs 1–2 calls, a write about 7 (lock, load, flush, release). Fine for a team
  of a few; a large simultaneous crowd would hit 429s, which surface as "rate limit
  reached, wait a moment". The client already loads the asset list once and filters in
  the browser, which is what keeps request counts low.
- **Every request loads the whole spreadsheet.** Same as Apps Script, and fine to roughly
  5,000 assets. Past that, `sheets-host.js` is the file to make smarter — for instance
  loading only the tabs a given call touches.
- **Netlify Functions time out at 10s** on the free plan. A very large bulk-import chunk
  could exceed it; the client already sends 200 rows at a time, and each chunk commits
  independently, so a timeout costs one chunk rather than the import.
