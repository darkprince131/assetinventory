# Asset Tracker

A lightweight in-house replacement for ManageEngine AssetExplorer. Tracks IT and non-IT
assets, who has them, where they are, what they cost, and what has happened to them.

**A Google Sheet is the database.** The app is a Google Apps Script web app (HTML Service)
bound to that sheet. No hosting, no service accounts, no API quotas — and the ops team can
open the raw sheet and fix data by hand when something goes sideways.

Setup instructions: [docs/SETUP.md](docs/SETUP.md).

## Three deployments, one codebase

| Target | Data | Auth | Use it for |
|---|---|---|---|
| **Apps Script** (`/src`) | The shared Google Sheet | Workspace login, free | The simplest real deployment — one click, no hosting |
| **Netlify** (`--backend=http`) | The same shared Google Sheet, via the Sheets API | Google OAuth → signed cookie | A real deployment on your own domain |
| **Netlify demo** (`--backend=demo`) | This browser's localStorage | A fake local user, role switchable | Demos and review with no credentials at all |

All three run the *same* `/src/*.gs` business logic — not a port of it. Apps Script runs it
natively; Netlify Functions run it in a `vm` with the Apps Script globals supplied; the demo
build runs it in the browser over localStorage. `Sheets.gs` was always the only file allowed
to touch `SpreadsheetApp`, and that is the seam all three hang off.

```bash
node web/build.js --backend=demo && npx --yes serve web/public
```

Setup for the hosted versions: [docs/SETUP.md](docs/SETUP.md) (Apps Script),
[docs/NETLIFY.md](docs/NETLIFY.md) (Netlify, including the Google Cloud steps).

## What it does

| Area | Detail |
|---|---|
| Assets | Dense searchable register with filters, sort, column toggles, pagination, CSV export of the filtered set |
| Lifecycle | Assign · Return · Transfer · Retire, plus maintenance open/close, with status transitions enforced server-side |
| Bulk import | CSV templates, browser-side parsing, per-row validate + field-level diff preview, chunked commit, error-row download |
| Dashboard | Stat cards, "attention needed" list, category and location breakdowns, recent activity, asset value |
| Reports | Nine canned exports — CSV download or written to a new tab in the sheet |
| Masters | Employees, Locations, Vendors, Users. Soft-deactivate only |
| Audit | Append-only log, one row per changed field, filterable viewer |

## Repo layout

```
/src
  appsscript.json
  Code.gs           doGet, routing, include(), the api_* surface
  Auth.gs           role lookup, permission guards
  Sheets.gs         ONLY file that touches SpreadsheetApp; also setupSpreadsheet() and seedDemoData()
  Assets.gs         CRUD + validation on assets
  Assignments.gs    assign / return / transfer
  Maintenance.gs    repair + AMC records
  Import.gs         bulk CSV import: parse, validate, preview, commit
  Export.gs         canned reports
  Dashboard.gs      metric aggregation
  Audit.gs          change log writer
  Utils.gs          ids, dates, validation helpers
  /ui               Index, Styles, App.js and one file per screen
/web                Static frontend build
  build.js          generates web/public from /src — no bundler, no dependencies
  src/
    index.html      static shell
    host-browser.js Apps Script host objects over localStorage (demo build)
    local-transport.js  demo transport, seeding and demo bar
    http-transport.js   transport that calls the Netlify backend
/netlify/functions  Netlify backend — zero runtime dependencies
  api.js            the single JSON endpoint
  auth-*.js         Google OAuth redirect flow
  _lib/             env, session cookies, Sheets REST, the grid, the vm runtime
/tools
  build-logic.js    bundles /src/*.gs for the functions
/docs
  SETUP.md          Apps Script setup
  NETLIFY.md        Netlify setup, architecture, security notes, limitations
netlify.toml
```

## Local development

```bash
npm install -g @google/clasp
clasp login
clasp create --type sheets --title "Asset Tracker" --rootDir ./src
clasp push
clasp open
```

`clasp create` writes `.clasp.json` in the repo root — it is gitignored because it contains
your own script id. Everything else lives in git.

## Design rules worth keeping

- **`Sheets.gs` is the only file that touches `SpreadsheetApp`.** It is the seam that would be
  swapped if the data ever moves off Sheets. Nothing else may import it sideways.
- **Rows are never deleted.** Retirement is `status: Retired`; masters are deactivated. Deletion
  is a manual act in the raw sheet.
- **Every id mint + append is wrapped in `Utils.withLock()`** (script lock, 30s) so two users
  cannot collide.
- **Reads pull a whole tab at once** and are cached in `CacheService` for 60s against a version
  key that every write bumps. Writes always use `setValues()` / batched appends.
- **Load once, filter client-side.** Apps Script round trips are 300–800ms; the assets list is
  fetched once and re-fetched only after a write or a manual refresh. Good to roughly 10,000 rows.
- **The server is the authority on validation.** Client-side checks exist to be fast, not correct.
- **Dropdowns read from the `Config` tab.** No enum is hardcoded in the client.

## Assumptions flagged back to DJ

1. Single organisation, single spreadsheet, under ~5,000 assets. At 20,000+ the stack needs
   revisiting before Phase 1.
2. Google Workspace accounts exist for everyone who will use the tool.
3. Currency defaults to INR.
4. Employees are loaded by import from HR data, not synced from any system.
5. "Inventory/stock" is modelled as `status: In Stock` on individual asset rows, not as a
   quantity-based consumables ledger. "43 HDMI cables" as a single counted row is a different
   data model — ask before building it.

## Out of scope

Barcode/QR scanning · email notifications · approval workflows · ticketing/helpdesk · software
licence and compliance tracking · network auto-discovery · depreciation schedules · procurement
workflow · mobile app · charts beyond CSS bars · multi-currency conversion · file attachments.

### Possible next steps

Noted while building, deliberately not built:

- The `Assignments.acknowledged` flag is captured but nothing chases an unacknowledged handover.
  A weekly digest would be a small addition if it ever matters.
- `Maintenance` already records cost and vendor; a per-vendor SLA view (average days out for
  repair) would fall out of the existing data with no schema change.
- The audit log carries enough detail to reconstruct an asset's field history over time; a
  point-in-time "what did the register look like on date X" view is possible without new writes.
