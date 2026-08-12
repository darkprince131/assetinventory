# Netlify + Supabase

Postgres instead of a Google Sheet, and password sign-in instead of Google. No
Google Cloud project, no service account, no billing prompt — everything here fits
in Supabase's and Netlify's free tiers.

The app itself is unchanged. The same `/src/*.gs` business logic runs; only the
storage adapter and the sign-in screen differ.

---

## Before you start

You need a Supabase project. If you already created tables in it by hand, **drop any
table named `assets`, `assignments`, `maintenance`, `employees`, `locations`,
`vendors`, `users`, `auditlog`, `config`, `_system` or `auth_credentials` first.** The
schema script uses `create table if not exists`, so a table that already exists with
different columns is left alone — and then nothing lines up.

---

## 1. Create the schema

The SQL is generated from `DB.SCHEMA`, so it always matches what the code expects.
Regenerate it any time the schema changes:

```bash
node tools/build-supabase-sql.js
```

In Supabase: **SQL Editor → New query**, paste the whole of `supabase/schema.sql`, and
**Run**. It creates:

- the nine tables, typed (`date`, `numeric`, `boolean`, `timestamptz`), each with a
  `row_id` identity column that preserves insertion order
- indexes on the columns the app actually looks things up by
- `_system` — one row, used as the write mutex
- `auth_credentials` — email, scrypt password hash, lockout counters
- the `Config` dropdown lists, seeded
- **RLS enabled on every table with no policies**, so the public anon key can read
  nothing at all. Only the service role — held by the Netlify functions — gets in.

Re-running it is safe. It never drops anything.

## 2. Get the service-role key

**Project settings → API keys → `service_role`.** Reveal and copy it.

That key bypasses RLS: it is a full read/write credential for your database. It goes
into Netlify's environment and nowhere else — never into the repo, never into the
frontend bundle, never into a chat window. If it leaks, rotate it in the same screen.

Also copy the **Project URL** (`https://<project-ref>.supabase.co`).

## 3. Netlify environment variables

**Site configuration → Environment variables.** Only five, and none of them Google:

| Variable | Value |
|---|---|
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | The `service_role` key from step 2 |
| `SESSION_SECRET` | A long random string — see below |
| `BOOTSTRAP_EMAIL` | Your email. Temporary |
| `BOOTSTRAP_PASSWORD` | A password you choose. Temporary |

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Setting `SUPABASE_URL` is what selects this backend — the code picks Postgres and
password sign-in automatically. No Google variables are read or required.

Then **Deploys → Trigger deploy → Deploy site**.

Optional:

| Variable | Default | Effect |
|---|---|---|
| `SESSION_HOURS` | `12` | How long a sign-in lasts |
| `LOCK_TIMEOUT_MS` | `30000` | How long a write waits for the lock |

## 4. First sign-in

Open the site. You get an email and password form.

Sign in with `BOOTSTRAP_EMAIL` / `BOOTSTRAP_PASSWORD`. That one-time path exists only
while no credential row exists for that address: it creates the account, hashes the
password, and immediately asks you to choose a new one.

**Then delete `BOOTSTRAP_EMAIL` and `BOOTSTRAP_PASSWORD` from Netlify** and redeploy.
They have done their job and leaving them set is a standing back door.

## 5. Seed the access rows

Signed in, open the browser console on your site and run:

```bash
fetch('/api', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fn: 'setupSpreadsheet', args: [] }) }).then(r => r.json()).then(console.log)
```

Despite the name, on Postgres this only seeds `Config` if empty and writes **you** into
`users` as Admin. Reload and the dashboard appears.

Want sample data to click around first? Same call with `seedDemoData` — ~80 assets, 20
employees, 5 locations, 5 vendors. It refuses if `assets` already has rows.

## 6. Add your team

Two steps per person, because access and credentials are separate:

1. **Masters → Users** in the app: email, name, role (`Admin` / `Editor` / `Viewer`),
   active. This is what grants access.
2. Give them a starting password — as an Admin, from the browser console:

```bash
fetch('/api/auth/password', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'set', email: 'them@example.com', password: 'their-initial-password' }) }).then(r => r.json()).then(console.log)
```

They will be forced to choose their own password on first sign-in. The same call resets
a forgotten password.

## 7. Load real data

Order matters — assets reference the masters, and nothing is created implicitly:
**Locations → Vendors → Employees → Assets**, each through **Import**. The rules are
unchanged from the Sheets version (match on serial, `--CLEAR--` to blank a field,
day-first dates); see [SETUP.md](SETUP.md) §5.

---

## How it differs from the Sheets backend

| | Google Sheets | Supabase |
|---|---|---|
| Storage | The spreadsheet | Postgres, nine typed tables |
| Sign-in | Google Workspace OAuth | Email + password (scrypt) |
| Fixing data by hand | Open the sheet | Supabase table editor, or SQL |
| Write lock | A cell in a hidden tab | One atomic conditional `UPDATE` |
| Read cost | Whole spreadsheet, quota-limited | Whole table set, no meaningful quota |
| "Write report to a sheet tab" | Works | Refused with a message — download the CSV |
| Concurrency | ~60 API reads/min ceiling | Real database limits, far higher |

Everything else — validation, assign/return/transfer, maintenance, bulk import with
diffs, the dashboard, the nine reports, the audit log, roles — is the identical code.

**What you give up:** "the sheet is the database", which was the founding decision in
the original spec. Ops can no longer open a familiar spreadsheet and fix a row. The
Supabase table editor is a competent replacement, but it is a database UI, not Excel.

## Security notes

- The service-role key never reaches the browser. The client only ever talks to `/api`.
- RLS is on with no policies, so the anon key — the one that is safe to expose — can
  read nothing. A leak of it exposes no data.
- Passwords are scrypt-hashed with a per-password salt. Eight failed attempts locks the
  account for 15 minutes. Wrong-password and unknown-email return the same message and
  take the same time, so the form cannot be used to enumerate who has an account.
- The session cookie is signed, HttpOnly, SameSite=Lax — unreadable by page scripts and
  not sent cross-site, which is also what makes the JSON API CSRF-proof.
- Being able to sign in is not the same as having access: every call re-checks the
  `users` table, so deactivating someone takes effect immediately, without hunting down
  a session.
- Roles are enforced server-side. Hidden buttons are a convenience; `Auth.require` is
  the boundary.

## Limitations

- **No password reset by email.** An Admin resets it with the call in step 6. Adding
  email would mean an SMTP provider; Supabase's built-in sender is rate-limited to a
  couple of messages an hour on the free tier, which does not work for a team.
- **Every request loads the whole table set.** Same as the other backends, and fine to
  roughly 5,000 assets. Past that, `supabase-host.js` is the file to make selective.
- **Netlify free-tier functions time out at 10s.** Bulk import already commits in
  chunks of 200 rows, so a timeout costs one chunk rather than the run.
- **`PropertiesService` is per-request**, so closing a repair defaults the restored
  status to *In Stock* rather than remembering *Assigned*. Cosmetic; the dialog still
  validates.
