/**
 * host-browser.js — a browser implementation of the Apps Script host objects
 * the server code depends on: SpreadsheetApp, PropertiesService, CacheService,
 * LockService, Session and Utilities.
 *
 * This is what lets the *same* .gs business logic run in a static build with no
 * Google account behind it. The spreadsheet lives in localStorage.
 *
 * It is a demo/preview backend. Data is per-browser and per-device: nothing is
 * shared between users, and clearing site data wipes it.
 */

var Host = (function () {

  var KEY = 'asset_tracker_demo_v1';
  var USER_KEY = 'asset_tracker_demo_user';
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function pad(n, w) { var s = String(n); while (s.length < w) s = '0' + s; return s; }

  // ------------------------------------------------------------ spreadsheet

  function Range(sheet, r, c, nr, nc) {
    this.sh = sheet; this.r = r; this.c = c; this.nr = nr; this.nc = nc;
  }
  Range.prototype.getValues = function () {
    var out = [];
    for (var i = 0; i < this.nr; i++) {
      var row = [];
      for (var j = 0; j < this.nc; j++) row.push(this.sh.cell(this.r + i, this.c + j));
      out.push(row);
    }
    return out;
  };
  Range.prototype.setValues = function (vals) {
    for (var i = 0; i < vals.length; i++) {
      for (var j = 0; j < vals[i].length; j++) this.sh.set(this.r + i, this.c + j, vals[i][j]);
    }
    return this;
  };
  Range.prototype.clearContent = function () {
    for (var i = 0; i < this.nr; i++) for (var j = 0; j < this.nc; j++) this.sh.set(this.r + i, this.c + j, '');
    return this;
  };
  Range.prototype.setFontWeight = function () { return this; };
  Range.prototype.setDataValidation = function () { return this; };

  function Sheet(name, id) {
    this.name = name; this.id = id; this.grid = []; this.maxCols = 40; this.maxRows = 2000;
  }
  Sheet.prototype.getName = function () { return this.name; };
  Sheet.prototype.getSheetId = function () { return this.id; };
  Sheet.prototype.cell = function (r, c) {
    var row = this.grid[r - 1];
    var v = row ? row[c - 1] : '';
    return v === undefined ? '' : v;
  };
  Sheet.prototype.set = function (r, c, v) {
    while (this.grid.length < r) this.grid.push([]);
    var row = this.grid[r - 1];
    while (row.length < c) row.push('');
    row[c - 1] = (v === undefined || v === null) ? '' : v;
  };
  Sheet.prototype.getLastRow = function () {
    var last = 0;
    for (var i = 0; i < this.grid.length; i++) {
      var row = this.grid[i];
      if (row && row.some(function (v) { return v !== '' && v !== undefined && v !== null; })) last = i + 1;
    }
    return last;
  };
  Sheet.prototype.getLastColumn = function () {
    var m = 0;
    this.grid.forEach(function (r) { if (r && r.length > m) m = r.length; });
    return m;
  };
  Sheet.prototype.getDataRange = function () {
    return new Range(this, 1, 1, Math.max(this.getLastRow(), 1), Math.max(this.getLastColumn(), 1));
  };
  Sheet.prototype.getRange = function (r, c, nr, nc) {
    return new Range(this, r, c, nr === undefined ? 1 : nr, nc === undefined ? 1 : nc);
  };
  Sheet.prototype.setFrozenRows = function () { return this; };
  Sheet.prototype.getMaxColumns = function () { return this.maxCols; };
  Sheet.prototype.getMaxRows = function () { return this.maxRows; };
  Sheet.prototype.deleteColumns = function (start, n) { this.maxCols -= n; return this; };
  Sheet.prototype.setColumnWidths = function () { return this; };
  Sheet.prototype.autoResizeColumns = function () { return this; };

  function Spreadsheet() { this.sheets = []; this.seq = 1; }
  Spreadsheet.prototype.insertSheet = function (name) {
    var s = new Sheet(name, this.seq++);
    this.sheets.push(s);
    return s;
  };
  Spreadsheet.prototype.getSheetByName = function (n) {
    return this.sheets.filter(function (s) { return s.name === n; })[0] || null;
  };
  Spreadsheet.prototype.deleteSheet = function (s) {
    this.sheets = this.sheets.filter(function (x) { return x !== s; });
  };
  Spreadsheet.prototype.getSheets = function () { return this.sheets; };
  Spreadsheet.prototype.getUrl = function () { return 'about:blank#demo-spreadsheet'; };

  var SS = new Spreadsheet();
  var props = {};

  // ------------------------------------------------------------ persistence

  function encode(v) {
    if (v instanceof Date) return { __d: v.getTime() };
    return v;
  }
  function decode(v) {
    if (v && typeof v === 'object' && v.__d !== undefined) return new Date(v.__d);
    return v;
  }

  function serialise() {
    return {
      seq: SS.seq,
      props: props,
      sheets: SS.sheets.map(function (sh) {
        return {
          name: sh.name, id: sh.id, maxCols: sh.maxCols, maxRows: sh.maxRows,
          grid: sh.grid.map(function (row) { return (row || []).map(encode); })
        };
      })
    };
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(serialise()));
      return true;
    } catch (e) {
      // Quota exceeded — keep working in memory rather than losing the session.
      console.warn('Demo data could not be saved to localStorage: ' + e.message);
      return false;
    }
  }

  function load() {
    var raw = null;
    try { raw = localStorage.getItem(KEY); } catch (e) { raw = null; }
    if (!raw) return false;
    try {
      var data = JSON.parse(raw);
      SS.sheets = [];
      SS.seq = data.seq || 1;
      props = data.props || {};
      (data.sheets || []).forEach(function (s) {
        var sh = new Sheet(s.name, s.id);
        sh.maxCols = s.maxCols; sh.maxRows = s.maxRows;
        sh.grid = (s.grid || []).map(function (row) { return (row || []).map(decode); });
        SS.sheets.push(sh);
      });
      return SS.sheets.length > 0;
    } catch (e) {
      console.warn('Stored demo data was unreadable, starting fresh: ' + e.message);
      return false;
    }
  }

  function reset() {
    try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
    SS.sheets = []; SS.seq = 1; props = {};
  }

  function user() {
    try { return localStorage.getItem(USER_KEY) || 'demo@asset-tracker.local'; }
    catch (e) { return 'demo@asset-tracker.local'; }
  }
  function setUser(email) {
    try { localStorage.setItem(USER_KEY, email); } catch (e) { /* ignore */ }
  }

  // -------------------------------------------------------------- host APIs

  window.SpreadsheetApp = {
    getActiveSpreadsheet: function () { return SS; },
    newDataValidation: function () {
      var b = {
        requireValueInList: function () { return b; },
        setAllowInvalid: function () { return b; },
        build: function () { return {}; }
      };
      return b;
    }
  };

  window.PropertiesService = {
    getScriptProperties: function () {
      return {
        getProperty: function (k) { return props[k] === undefined ? null : props[k]; },
        setProperty: function (k, v) { props[k] = String(v); },
        deleteProperty: function (k) { delete props[k]; }
      };
    }
  };

  var cache = {};
  window.CacheService = {
    getScriptCache: function () {
      return {
        get: function (k) {
          var e = cache[k];
          if (!e) return null;
          if (e.exp < Date.now()) { delete cache[k]; return null; }
          return e.v;
        },
        put: function (k, v, secs) { cache[k] = { v: v, exp: Date.now() + (secs || 60) * 1000 }; },
        putAll: function (map, secs) {
          Object.keys(map).forEach(function (k) { cache[k] = { v: map[k], exp: Date.now() + (secs || 60) * 1000 }; });
        }
      };
    }
  };

  // The browser is single-threaded, so the lock is a formality — but the server
  // code relies on tryLock/releaseLock existing and behaving sanely.
  var held = false;
  window.LockService = {
    getScriptLock: function () {
      return {
        tryLock: function () { held = true; return true; },
        releaseLock: function () { held = false; },
        hasLock: function () { return held; }
      };
    }
  };

  window.Session = {
    getActiveUser: function () { return { getEmail: function () { return user(); } }; },
    getEffectiveUser: function () { return { getEmail: function () { return user(); } }; },
    getScriptTimeZone: function () {
      try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata'; }
      catch (e) { return 'Asia/Kolkata'; }
    }
  };

  window.Utilities = {
    /** Supports the patterns the server code actually uses. */
    formatDate: function (d, tz, pattern) {
      var out = pattern.replace("'T'", " LIT ");
      out = out
        .replace(/yyyy/, d.getFullYear())
        .replace(/MMM/, MON[d.getMonth()])
        .replace(/MM/, pad(d.getMonth() + 1, 2))
        .replace(/dd/, pad(d.getDate(), 2))
        .replace(/HH/, pad(d.getHours(), 2))
        .replace(/mm/, pad(d.getMinutes(), 2))
        .replace(/ss/, pad(d.getSeconds(), 2));
      return out.replace(" LIT ", "T");
    }
  };

  return { save: save, load: load, reset: reset, user: user, setUser: setUser, spreadsheet: SS };
})();
