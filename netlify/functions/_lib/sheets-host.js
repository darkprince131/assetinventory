/**
 * sheets-host.js — an in-memory spreadsheet that looks exactly like
 * SpreadsheetApp to the business logic, loaded from and flushed to the Google
 * Sheets API.
 *
 * This is the Netlify counterpart of src/Sheets.gs's host. The shared logic is
 * synchronous Apps Script code, so the async work is pushed to the edges:
 *
 *     load (1 API call) → run the logic synchronously → flush (1 API call)
 *
 * Only rows the logic actually touched are written back.
 */

const google = require('./google');
const env = require('./env');

const SYSTEM_TAB = '_System';
const LOCK_STALE_MS = 30000;

// ------------------------------------------------------------------ A1 helpers

function colLetter(n) { // 1 -> A
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function quoteTitle(t) { return "'" + String(t).replace(/'/g, "''") + "'"; }

// -------------------------------------------------------------- date <-> serial

const SHEETS_EPOCH_DAYS_OFFSET = 25569; // days between 1899-12-30 and 1970-01-01

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

function pad(n, w) { let s = String(n); while (s.length < w) s = '0' + s; return s; }

function dateToSheetString(d, withTime) {
  const day = d.getFullYear() + '-' + pad(d.getMonth() + 1, 2) + '-' + pad(d.getDate(), 2);
  if (!withTime) return day;
  return day + ' ' + pad(d.getHours(), 2) + ':' + pad(d.getMinutes(), 2) + ':' + pad(d.getSeconds(), 2);
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

// ----------------------------------------------------------------- grid objects

class Range {
  constructor(sheet, r, c, nr, nc) { this.sh = sheet; this.r = r; this.c = c; this.nr = nr; this.nc = nc; }
  getValues() {
    const out = [];
    for (let i = 0; i < this.nr; i++) {
      const row = [];
      for (let j = 0; j < this.nc; j++) row.push(this.sh.cell(this.r + i, this.c + j));
      out.push(row);
    }
    return out;
  }
  setValues(vals) {
    for (let i = 0; i < vals.length; i++) {
      for (let j = 0; j < vals[i].length; j++) this.sh.set(this.r + i, this.c + j, vals[i][j]);
    }
    return this;
  }
  clearContent() {
    for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.sh.set(this.r + i, this.c + j, '');
    return this;
  }
  setFontWeight() { return this; }
  setDataValidation() { return this; }
}

class Sheet {
  constructor(name, id) {
    this.name = name;
    this.id = id;
    this.grid = [];
    this.dirty = new Set();
    this.isNew = false;
    this.maxCols = 40;
    this.maxRows = 5000;
  }
  getName() { return this.name; }
  getSheetId() { return this.id; }
  cell(r, c) {
    const row = this.grid[r - 1];
    const v = row ? row[c - 1] : '';
    return v === undefined ? '' : v;
  }
  set(r, c, v) {
    while (this.grid.length < r) this.grid.push([]);
    const row = this.grid[r - 1];
    while (row.length < c) row.push('');
    const next = (v === undefined || v === null) ? '' : v;
    if (!same(row[c - 1], next)) {
      row[c - 1] = next;
      this.dirty.add(r);
    }
  }
  getLastRow() {
    let last = 0;
    for (let i = 0; i < this.grid.length; i++) {
      const row = this.grid[i];
      if (row && row.some(v => v !== '' && v !== undefined && v !== null)) last = i + 1;
    }
    return last;
  }
  getLastColumn() {
    let m = 0;
    this.grid.forEach(r => { if (r && r.length > m) m = r.length; });
    return m;
  }
  getDataRange() { return new Range(this, 1, 1, Math.max(this.getLastRow(), 1), Math.max(this.getLastColumn(), 1)); }
  getRange(r, c, nr, nc) { return new Range(this, r, c, nr === undefined ? 1 : nr, nc === undefined ? 1 : nc); }
  setFrozenRows() { return this; }
  getMaxColumns() { return this.maxCols; }
  getMaxRows() { return this.maxRows; }
  deleteColumns() { return this; }
  setColumnWidths() { return this; }
  autoResizeColumns() { return this; }
}

function same(a, b) {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

class Spreadsheet {
  constructor() { this.sheets = []; this.nextId = -1; this.deleted = []; }
  insertSheet(name) {
    const s = new Sheet(name, this.nextId--);
    s.isNew = true;
    this.sheets.push(s);
    return s;
  }
  getSheetByName(n) { return this.sheets.filter(s => s.name === n)[0] || null; }
  deleteSheet(s) {
    this.sheets = this.sheets.filter(x => x !== s);
    if (!s.isNew) this.deleted.push(s);
  }
  getSheets() { return this.sheets; }
  getUrl() { return google.spreadsheetUrl(); }
}

// ------------------------------------------------------------------- the host

function createHost() {
  const ss = new Spreadsheet();

  return {
    spreadsheet: ss,

    /** The SpreadsheetApp stand-in handed to the sandbox. */
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
      newDataValidation: () => {
        const b = {
          requireValueInList: () => b,
          setAllowInvalid: () => b,
          build: () => ({})
        };
        return b;
      }
    },

    /** Column type per tab, keyed by position, worked out during load. */
    columnTypes: {},

    /**
     * Fills the grid from the live spreadsheet.
     *
     * `schemaTypes` maps tab -> { columnName: type } and comes from DB.SCHEMA —
     * the single source of truth — never from a copy kept here. Types are then
     * matched against each tab's actual header row, so a human reordering
     * columns in the sheet cannot corrupt date handling.
     */
    async load(schemaTypes) {
      const meta = await google.getMetadata();
      const titles = meta.map(m => m.title).filter(t => t !== SYSTEM_TAB);
      const values = await google.batchGet(titles);

      ss.sheets = [];
      this.columnTypes = {};

      meta.forEach(m => {
        if (m.title === SYSTEM_TAB) return;
        const sh = new Sheet(m.title, m.sheetId);
        sh.maxRows = m.rows;
        sh.maxCols = m.columns;

        const rows = values[m.title] || [];
        const byName = schemaTypes[m.title] || null;
        const header = rows[0] || [];
        const types = header.map(h => (byName ? byName[String(h).trim()] : null) || 'text');
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
            range: quoteTitle(sh.name) + '!A1:' + colLetter(width) + rows.length,
            values: rows.map(r => encodeRow(r, width, types))
          });
          return;
        }
        if (!sh.dirty.size) return;

        const width = Math.max(sh.getLastColumn(), 1);
        runs([...sh.dirty].sort((a, b) => a - b)).forEach(run => {
          const values = [];
          for (let r = run.start; r <= run.end; r++) values.push(encodeRow(sh.grid[r - 1] || [], width, types));
          data.push({
            range: quoteTitle(sh.name) + '!A' + run.start + ':' + colLetter(width) + run.end,
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

/** Groups sorted row numbers into contiguous [start,end] runs. */
function runs(sorted) {
  const out = [];
  let start = null, prev = null;
  sorted.forEach(r => {
    if (start === null) { start = prev = r; return; }
    if (r === prev + 1) { prev = r; return; }
    out.push({ start, end: prev });
    start = prev = r;
  });
  if (start !== null) out.push({ start, end: prev });
  return out;
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
  _internals: { colLetter, runs, serialToDate, dateToSheetString, needsTextGuard, encodeRow }
};
