# Setting up Asset Tracker

Fifteen minutes, once. You need a Google Workspace account that can create spreadsheets in your
organisation.

---

## 1. Create the script and its sheet

From the repo root:

```bash
npm install -g @google/clasp
```

```bash
clasp login
```

```bash
clasp create --type sheets --title "Asset Tracker" --rootDir ./src
```

That creates a new Google Sheet with a bound Apps Script project and writes `.clasp.json`
locally (gitignored — it holds your script id).

```bash
clasp push
```

```bash
clasp open
```

`clasp open` opens the script editor. Use **Overview → the sheet link**, or run
`clasp open --addon`, to reach the spreadsheet itself.

> Already have a sheet you want to use? Open it, choose **Extensions → Apps Script**, copy the
> script id from the URL, and put it in `.clasp.json` yourself instead of running `clasp create`.

---

## 2. Build the tabs

In the Apps Script editor:

1. Pick `setupSpreadsheet` from the function dropdown.
2. Click **Run**.
3. Approve the OAuth prompt the first time (it asks for access to this spreadsheet and your
   email address — nothing else).

This creates the nine tabs with frozen bold headers, seeds the `Config` tab with every dropdown
list, applies data validation to the enum columns, and adds **you** to the `Users` tab as Admin.

Check the sheet: you should see `Assets`, `Assignments`, `Maintenance`, `Employees`,
`Locations`, `Vendors`, `Users`, `AuditLog`, `Config`.

### Optional — demo data

Run `seedDemoData` to generate ~80 realistic assets across categories, 20 employees, 5 locations
and 5 vendors, so the app can be demoed before real data lands. It refuses to run if the
`Assets` tab already has rows.

To start over: delete the data rows (not the header) from `Assets`, `Assignments`, `Maintenance`,
`Employees`, `Locations` and `Vendors`, then run it again.

---

## 3. Deploy the web app

In the Apps Script editor: **Deploy → New deployment → Web app**.

| Setting | Value |
|---|---|
| Description | Asset Tracker |
| Execute as | **User accessing the web app** |
| Who has access | **Anyone within &lt;your organisation&gt;** |

Both settings matter:

- *Execute as user accessing* is what makes `Session.getActiveUser().getEmail()` return the real
  person, which is the whole access-control model.
- *Anyone within the organisation* keeps sheet permissions honest — a user who cannot read the
  spreadsheet cannot read it through the app either.

Copy the `/exec` URL and share it with the team.

After any `clasp push`, redeploy: **Deploy → Manage deployments → edit (pencil) → Version: New
version → Deploy**. The `/exec` URL stays the same.

---

## 4. Give people access

Open the `Users` tab and add one row per person:

| email | name | role | active |
|---|---|---|---|
| dj@example.com | DJ | Admin | TRUE |
| ops@example.com | Ops desk | Editor | TRUE |
| finance@example.com | Finance | Viewer | TRUE |

| Role | Can do |
|---|---|
| **Viewer** | Read everything, run reports, download CSVs |
| **Editor** | The above, plus all asset / assignment / maintenance operations and bulk import |
| **Admin** | The above, plus Masters, Users and Config |

Anyone not listed, or listed with `active = FALSE`, gets a plain "No access — contact your IT
admin" page.

Those people also need read access to the spreadsheet itself (Share → your org, Viewer is
enough for Viewers; Editors need edit access on the sheet).

> **Bootstrap note:** if the `Users` tab is completely empty, the first person to open the app is
> treated as Admin so you are never locked out. Add real rows as soon as you deploy.

---

## 5. Load the real data

Order matters — assets reference the masters, and nothing is created implicitly.

1. **Locations** — go to **Import**, download the Locations template, fill it, upload, commit.
2. **Vendors** — same.
3. **Employees** — same. Usually an export from HR.
4. **Assets** — last, because it points at all three.

Import rules to know:

- Asset rows are matched on `serial_number` first, then on `asset_id` if the serial column is
  blank. A match becomes an `UPDATE` with a field-level diff shown before anything is written.
- FK columns take either the ID (`LOC-001`) or the exact name ("Bengaluru HQ — 4th Floor").
  Unknown or ambiguous names are errors — load the master first.
- Dates accept `DD-MM-YYYY`, `YYYY-MM-DD` and `DD/MM/YYYY`. Ambiguity resolves **day first**.
- On an update row, an empty cell means *leave unchanged*. To actually clear a field, type
  `--CLEAR--`.
- Assignment cannot be imported. Import assets as `In Stock`, then use the Assign action so the
  assignment history is written properly.
- Errors expand inline. Use **Download error rows as CSV**, fix them, and re-upload just those.

---

## 6. Day-to-day

| Task | Where |
|---|---|
| Hand a laptop to someone | Asset detail → **Assign** |
| Take it back | Asset detail → **Return** |
| Move it to a different person or office | Asset detail → **Transfer** (writes a Return + Assign pair) |
| Send it for repair | Asset detail → **Log maintenance** (sets status In Repair) |
| Get it back from repair | Asset detail → **Close maintenance** (asks which status to restore) |
| End of life | Asset detail → **Retire** (asks for a reason, closes any open assignment) |
| Someone leaves | Masters → Employees → set status Exited. The app lists the assets they still hold; it never auto-returns them |

---

## Maintenance and troubleshooting

**"Missing tab X" error** — `setupSpreadsheet()` has not been run, or a tab was renamed. Re-run
it; it is idempotent and will not overwrite existing data or a customised `Config`.

**Changed the `Config` lists?** Run `applyValidation()` from the editor to refresh the sheet's
dropdowns. The app itself picks up config changes within 60 seconds (the cache TTL).

**"The system is busy with another update"** — two writes collided on the 30-second script lock.
Retry.

**Stale numbers** — reads are cached for 60 seconds. Hit **Refresh** on the assets list or the
dashboard, or wait it out.

**Someone edited the sheet by hand.** That is allowed and expected. The app reads by header
name, so keep row 1 intact; do not reorder or rename headers, and do not delete rows (retire
instead). Hand edits are not captured in `AuditLog`, but Google's own version history has them.

**Scale.** This design is comfortable to roughly 10,000 asset rows. Past that, the whole-tab read
gets slow enough to notice and the stack should be revisited. `Sheets.gs` is the only file that
would need replacing.
