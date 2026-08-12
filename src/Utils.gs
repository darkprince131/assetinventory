/**
 * Utils.gs — ids, dates, validation helpers. No SpreadsheetApp calls in here.
 */

var Utils = (function () {

  var ID_SPEC = {
    AST: { tab: 'Assets',      col: 'asset_id',      pad: 5 },
    ASG: { tab: 'Assignments', col: 'assignment_id', pad: 5 },
    MNT: { tab: 'Maintenance', col: 'maintenance_id', pad: 5 },
    EMP: { tab: 'Employees',   col: 'emp_id',        pad: 4 },
    LOC: { tab: 'Locations',   col: 'location_id',   pad: 3 },
    VEN: { tab: 'Vendors',     col: 'vendor_id',     pad: 3 },
    LOG: { tab: 'AuditLog',    col: 'log_id',        pad: 6 }
  };

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /** Runs fn inside the script lock. Every id mint + append must be wrapped. */
  function withLock(fn) {
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(30000)) {
      throw new Error('The system is busy with another update. Try again in a moment.');
    }
    try {
      return fn();
    } finally {
      lock.releaseLock();
    }
  }

  /** Next n ids for a prefix, based on the max existing numeric suffix. */
  function nextIds(prefix, n) {
    var spec = ID_SPEC[prefix];
    if (!spec) throw new Error('Unknown id prefix: ' + prefix);
    var rows = DB.read(spec.tab);
    var max = 0;
    for (var i = 0; i < rows.length; i++) {
      var v = String(rows[i][spec.col] || '');
      var m = v.match(/^([A-Z]+)-(\d+)$/);
      if (m && m[1] === prefix) {
        var num = parseInt(m[2], 10);
        if (num > max) max = num;
      }
    }
    var out = [];
    for (var k = 1; k <= (n || 1); k++) {
      out.push(prefix + '-' + pad(max + k, spec.pad));
    }
    return out;
  }

  function nextId(prefix) {
    return nextIds(prefix, 1)[0];
  }

  function pad(num, width) {
    var s = String(num);
    while (s.length < width) s = '0' + s;
    return s;
  }

  function isBlank(v) {
    return v === null || v === undefined || String(v).trim() === '';
  }

  /** Trimmed, lower-cased comparison key. */
  function norm(v) {
    return String(v === null || v === undefined ? '' : v).trim().toLowerCase();
  }

  function trim(v) {
    return String(v === null || v === undefined ? '' : v).trim();
  }

  /**
   * Parses DD-MM-YYYY, YYYY-MM-DD, DD/MM/YYYY, ISO strings and Date objects.
   * Ambiguity resolves day-first. Returns a Date or null. Throws on garbage.
   */
  function parseDate(v) {
    if (v === null || v === undefined || v === '') return null;
    if (v instanceof Date) return isNaN(v.getTime()) ? null : startOfDay(v);
    if (typeof v === 'number') return startOfDay(new Date(v));

    var s = String(v).trim();
    if (!s) return null;

    var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/);
    if (m) return mk(m[1], m[2], m[3]);

    m = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})$/);
    if (m) return mk(m[3], m[2], m[1]); // day-first

    m = s.match(/^(\d{1,2})[-\/](([A-Za-z]{3})[a-z]*)[-\/](\d{4})$/);
    if (m) {
      var mi = MONTHS.map(function (x) { return x.toLowerCase(); }).indexOf(m[3].toLowerCase());
      if (mi < 0) throw new Error('Unrecognised month in date: ' + s);
      return mk(m[4], mi + 1, m[1]);
    }

    throw new Error('Unrecognised date: ' + s);

    function mk(y, mo, d) {
      y = parseInt(y, 10); mo = parseInt(mo, 10); d = parseInt(d, 10);
      if (mo < 1 || mo > 12 || d < 1 || d > 31) throw new Error('Impossible date: ' + s);
      var dt = new Date(y, mo - 1, d);
      if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) {
        throw new Error('Impossible date: ' + s);
      }
      return dt;
    }
  }

  function startOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  function today() {
    return startOfDay(new Date());
  }

  /** DD-MMM-YYYY for display. */
  function fmtDate(v) {
    var d = (v instanceof Date) ? v : (v ? parseDate(v) : null);
    if (!d) return '';
    return pad(d.getDate(), 2) + '-' + MONTHS[d.getMonth()] + '-' + d.getFullYear();
  }

  function isoDate(v) {
    var d = (v instanceof Date) ? v : (v ? parseDate(v) : null);
    if (!d) return '';
    return d.getFullYear() + '-' + pad(d.getMonth() + 1, 2) + '-' + pad(d.getDate(), 2);
  }

  /** Whole days from today to d. Negative = in the past. */
  function daysUntil(v) {
    var d = (v instanceof Date) ? v : (v ? parseDate(v) : null);
    if (!d) return null;
    return Math.round((startOfDay(d).getTime() - today().getTime()) / 86400000);
  }

  function toNumber(v) {
    if (v === null || v === undefined || v === '') return '';
    if (typeof v === 'number') return v;
    var s = String(v).replace(/[, ]/g, '').replace(/^(INR|Rs\.?|₹|\$)/i, '');
    if (s === '') return '';
    var n = Number(s);
    if (isNaN(n)) throw new Error('Not a number: ' + v);
    return n;
  }

  function toBool(v) {
    if (v === true || v === false) return v;
    var s = norm(v);
    if (s === '') return '';
    if (['true', 'yes', 'y', '1'].indexOf(s) >= 0) return true;
    if (['false', 'no', 'n', '0'].indexOf(s) >= 0) return false;
    throw new Error('Not a yes/no value: ' + v);
  }

  /** Indian financial year start (1 April) for a given date. */
  function fyStart(d) {
    d = d || new Date();
    var y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
    return new Date(y, 3, 1);
  }

  /**
   * Deep-converts Dates to local-wall-clock strings ("2024-05-14T00:00:00") so
   * values survive google.script.run without a timezone shifting the day.
   */
  function plain(v) {
    if (v === null || v === undefined) return v;
    if (v instanceof Date) {
      if (isNaN(v.getTime())) return '';
      return Utilities.formatDate(v, Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss");
    }
    if (Array.isArray(v)) return v.map(plain);
    if (typeof v === 'object') {
      var out = {};
      for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) out[k] = plain(v[k]);
      return out;
    }
    return v;
  }

  function now() {
    return new Date();
  }

  /** Groups an array of objects into a map keyed by obj[key] (lower-cased). */
  function indexBy(rows, key) {
    var map = {};
    for (var i = 0; i < rows.length; i++) {
      var k = norm(rows[i][key]);
      if (k) map[k] = rows[i];
    }
    return map;
  }

  function uniq(arr) {
    var seen = {}, out = [];
    for (var i = 0; i < arr.length; i++) {
      var k = String(arr[i]);
      if (!seen[k]) { seen[k] = true; out.push(arr[i]); }
    }
    return out;
  }

  return {
    withLock: withLock,
    nextId: nextId,
    nextIds: nextIds,
    pad: pad,
    isBlank: isBlank,
    norm: norm,
    trim: trim,
    parseDate: parseDate,
    startOfDay: startOfDay,
    today: today,
    fmtDate: fmtDate,
    isoDate: isoDate,
    daysUntil: daysUntil,
    toNumber: toNumber,
    toBool: toBool,
    fyStart: fyStart,
    plain: plain,
    now: now,
    indexBy: indexBy,
    uniq: uniq
  };
})();
