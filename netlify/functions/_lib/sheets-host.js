/**
 * sheets-host.js — fills the shared grid from the Google Sheets API and writes
 * changed rows back.
 *
 *   load(schemaCols) → run the logic synchronously → flush()
 *
 * Only rows the logic actually touched are written back.
 */

const grid = require('./grid');
const google = require('./google');
const env = require('./env');

const SYSTEM_TAB = '_System';
const LOCK_STALE_MS = 30000;

function quoteTitle(t) { return "'" + String(t).replace(/'/g, "''") + "'"; }

// -------------------------------------------------------------- date <-> serial

function serialToDate(serial) {
  const days = Math.floor(serial);
  const frac = serial - days;
  // Build in local time so the value matches the wall clock the sheet shows.
  const base = new Date(1899, 11, 30);
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + days);
  const secs = Math.round(frac * 86400);
  if (secs) d.setSeconds(d.getSeconds() + secs);
  return d;
}

function dateToSheetString(d, withTime) {
  return withTime ? grid.dateTimeString(d) : grid.dateOnlyString(d);
}

/**
 * USER_ENTERED makes Sheets parse what it is given, which is what turns a date
 * string into a real date — but it would also turn the serial number
 * "12-05-2024" into a date. Text that could be misread is prefixed with an
 * apostrophe, which Sheets treats as "this is text" and strips on read.
 */
function needsTextGuard(s) {
  if (!s) return false;
  if (/^[=+@]/.test(s)) return true;             // formula-ish
  if (/^-[\d.]/.test(s)) return false;           // a negative number is fine
  if (/^\d+([-\/.]\d+)+$/.test(s)) return true;  // date-ish
  if (/^0\d+$/.test(s)) return true;             // leading zeros must survive
  return false;
}

function encodeRow(row, width, types) {
  const out = [];
  for (let i = 0; i < width; i++) {
    const v = row[i];
    const type = types[i];
    if (v === undefined || v === null || v === '') { out.push(''); continue; }
    if (v instanceof Date) { out.push(dateToSheetString(v, type === 'datetime')); continue; }
    if (typeof v === 'number' || typeof v === 'boolean') { out.push(v); continue; }
    const s = String(v);
    out.push(needsTextGuard(s) ? "'" + s : s);
  }
  return out;
}

// ------------------------------------------------------------------- the host

function createHost() {
  const ss = new grid.Spreadsheet(google.spreadsheetUrl());

  return {
    spreadsheet: ss,
    SpreadsheetApp: grid.spreadsheetApp(ss),

    /** Column type per tab, keyed by position, worked out during load. */
    columnTypes: {},

    /**
     * schemaCols: { tab: [[columnName, type], …] } straight from DB.SCHEMA —
     * the single source of truth. Types are matched against each tab's actual
     * header row, so a human reordering columns in the sheet cannot corrupt
     * date handling.
     */
    async load(schemaCols) {
      const meta = await google.getMetadata();
      const titles = meta.map(m => m.title).filter(t => t !== SYSTEM_TAB);
      const values = await google.batchGet(titles);

      ss.sheets = [];
      this.columnTypes = {};

      meta.forEach(m => {
        if (m.title === SYSTEM_TAB) return;
        const sh = new grid.Sheet(m.title, m.sheetId);
        sh.maxRows = m.rows;
        sh.maxCols = m.columns;

        const rows = values[m.title] || [];
        const spec = schemaCols[m.title] || null;
        const byName = {};
        if (spec) spec.forEach(c => { byName[c[0]] = c[1]; });

        const header = rows[0] || [];
        const types = header.map(h => byName[String(h).trim()] || 'text');
        this.columnTypes[m.title] = types;

        sh.grid = rows.map((row, r) => row.map((v, i) => {
          if (v === null || v === undefined) return '';
          // Row 1 is the header; never coerce it.
          if (r > 0 && typeof v === 'number' && (types[i] === 'date' || types[i] === 'datetime')) {
            return serialToDate(v);
          }
          return v;
        }));
        sh.dirty.clear();
        ss.sheets.push(sh);
      });
      return ss.sheets.length;
    },

    hasChanges() {
      return ss.sheets.some(s => s.isNew || s.dirty.size) || ss.deleted.length > 0;
    },

    /** Writes back only what changed. Returns a summary for logging. */
    async flush() {
      const columnTypes = this.columnTypes;
      const structure = [];
      ss.deleted.forEach(s => structure.push({ deleteSheet: { sheetId: s.id } }));
      const created = ss.sheets.filter(s => s.isNew);
      created.forEach(s => structure.push({ addSheet: { properties: { title: s.name } } }));
      if (structure.length) await google.structureUpdate(structure);

      const data = [];
      ss.sheets.forEach(sh => {
        const types = columnTypes[sh.name] || [];
        if (sh.isNew) {
          const rows = sh.grid;
          if (!rows.length) return;
          const width = Math.max.apply(null, rows.map(r => r.length).concat([1]));
          data.push({
            range: quoteTitle(sh.name) + '!A1:' + grid.colLetter(width) + rows.length,
            values: rows.map(r => encodeRow(r, width, types))
          });
          return;
        }
        if (!sh.dirty.size) return;

        const width = Math.max(sh.getLastColumn(), 1);
        grid.runs([...sh.dirty].sort((a, b) => a - b)).forEach(run => {
          const values = [];
          for (let r = run.start; r <= run.end; r++) values.push(encodeRow(sh.grid[r - 1] || [], width, types));
          data.push({
            range: quoteTitle(sh.name) + '!A' + run.start + ':' + grid.colLetter(width) + run.end,
            values
          });
        });
      });

      const res = data.length ? await google.batchUpdate(data) : { updated: 0 };
      ss.sheets.forEach(s => { s.dirty.clear(); s.isNew = false; });
      ss.deleted = [];
      return { ranges: data.length, cells: res.updated, sheetsAdded: created.length };
    }
  };
}

// ---------------------------------------------------------------------- locking

/**
 * A mutex in the spreadsheet itself, so it works across Netlify containers
 * without adding another service.
 *
 * Write our token, pause, read it back: if a competing writer landed after us
 * we see their token and back off, and they see their own and proceed. Exactly
 * one winner per round.
 */
async function acquireLock(label) {
  const token = require('crypto').randomUUID() + '@' + Date.now();
  const deadline = Date.now() + env.lockTimeoutMs();
  await ensureSystemTab();

  while (Date.now() < deadline) {
    const current = await readLock();
    const free = !current.token || (Date.now() - current.at > LOCK_STALE_MS);

    if (free) {
      await writeLock(token, label);
      await sleep(350);
      const check = await readLock();
      if (check.token === token) {
        return async () => { await writeLock('', ''); };
      }
    }
    await sleep(400 + Math.floor(Math.random() * 250));
  }
  throw new Error('The system is busy with another update. Try again in a moment.');
}

async function ensureSystemTab() {
  const meta = await google.getMetadata();
  if (meta.some(m => m.title === SYSTEM_TAB)) return;
  await google.structureUpdate([{ addSheet: { properties: { title: SYSTEM_TAB, hidden: true } } }]);
  await google.batchUpdate([{
    range: quoteTitle(SYSTEM_TAB) + '!A1:D1',
    values: [['write lock (system use — do not edit)', '', '', '']]
  }]);
}

async function readLock() {
  const values = await google.batchGet([SYSTEM_TAB]);
  const row = (values[SYSTEM_TAB] || [])[0] || [];
  const token = row[1] ? String(row[1]) : '';
  const at = Number(row[2]) || 0;
  return { token, at };
}

async function writeLock(token, label) {
  await google.batchUpdate([{
    range: quoteTitle(SYSTEM_TAB) + '!B1:D1',
    values: [[token, token ? Date.now() : '', label || '']]
  }]);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = {
  createHost,
  acquireLock,
  SYSTEM_TAB,
  _internals: {
    colLetter: grid.colLetter,
    runs: grid.runs,
    serialToDate,
    dateToSheetString,
    needsTextGuard,
    encodeRow
  }
};
