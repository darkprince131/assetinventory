/**
 * grid.js — the in-memory spreadsheet the business logic runs against.
 *
 * Shared by both backends. sheets-host.js fills it from the Google Sheets API,
 * supabase-host.js fills it from Postgres. Neither knows about the other, and
 * the logic in /src knows about neither.
 *
 * Rows are 1-based, like a spreadsheet. Row 1 is always the header.
 */

function colLetter(n) { // 1 -> A
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function same(a, b) {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
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

function pad(n, w) { let s = String(n); while (s.length < w) s = '0' + s; return s; }

function dateOnlyString(d) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1, 2) + '-' + pad(d.getDate(), 2);
}

function dateTimeString(d) {
  return dateOnlyString(d) + ' ' + pad(d.getHours(), 2) + ':' + pad(d.getMinutes(), 2) + ':' + pad(d.getSeconds(), 2);
}

/** 'YYYY-MM-DD' -> a Date at local midnight, with no timezone shift. */
function parseDateOnly(s) {
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3]);
}

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
    /** Backend row key per grid row, e.g. a Postgres row_id. Sparse. */
    this.keys = {};
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

class Spreadsheet {
  constructor(url) { this.sheets = []; this.nextId = -1; this.deleted = []; this.url = url || ''; }
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
  getUrl() { return this.url; }
}

/** The SpreadsheetApp stand-in every backend hands to the sandbox. */
function spreadsheetApp(ss) {
  return {
    getActiveSpreadsheet: () => ss,
    newDataValidation: () => {
      const b = {
        requireValueInList: () => b,
        setAllowInvalid: () => b,
        build: () => ({})
      };
      return b;
    }
  };
}

module.exports = {
  Range, Sheet, Spreadsheet, spreadsheetApp,
  colLetter, same, runs, pad,
  dateOnlyString, dateTimeString, parseDateOnly
};
