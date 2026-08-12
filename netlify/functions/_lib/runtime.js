/**
 * runtime.js — runs the shared business logic for one request.
 *
 *   acquire lock (writes only) → load the spreadsheet → call the function
 *   synchronously → flush what changed → release
 *
 * The logic is compiled once per container and executed in a *fresh* context per
 * request, so no state leaks between users on a warm container.
 *
 * Time zones: serial numbers become Dates in the server's local zone and are
 * written back the same way, and Utilities.formatDate below deliberately formats
 * in that same zone. The pair round-trips regardless of where the container runs.
 */

const vm = require('vm');
const bundle = require('./logic-bundle');
const sheetsHost = require('./sheets-host');

/** Functions that may write. Everything else must leave the sheet untouched. */
const MUTATING = new Set([
  'api_saveAsset', 'api_assign', 'api_return', 'api_transfer', 'api_retire',
  'api_openMaintenance', 'api_closeMaintenance', 'api_importCommit',
  'api_masterSave', 'api_masterToggle', 'api_configSave',
  // Both write an AuditLog row recording the export.
  'api_getReport', 'api_reportToTab'
]);

const READING = new Set([
  'api_bootstrap', 'api_getAssets', 'api_getAsset', 'api_validateAsset',
  'api_importTemplate', 'api_importColumns', 'api_importValidate',
  'api_getDashboard', 'api_getAudit', 'api_masterList'
]);

/** Setup helpers, callable before the sheet has any Users rows. */
const ADMIN = new Set(['setupSpreadsheet', 'applyValidation', 'seedDemoData']);

let script = null;
function compiled() {
  if (!script) script = new vm.Script(bundle.source, { filename: 'asset-tracker-logic.js' });
  return script;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function pad(n, w) { let s = String(n); while (s.length < w) s = '0' + s; return s; }

function createSandbox(user, host) {
  const props = {};
  const cache = {};

  const sandbox = {
    console,
    JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error, isNaN, parseInt, parseFloat,

    SpreadsheetApp: host.SpreadsheetApp,

    // Per request. The version key still invalidates DB's cache within a
    // request, which is what makes read-modify-write correct.
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: k => (props[k] === undefined ? null : props[k]),
        setProperty: (k, v) => { props[k] = String(v); },
        deleteProperty: k => { delete props[k]; }
      })
    },

    // Request-scoped: DB.read is called many times per request and this is what
    // keeps that from re-parsing the whole grid every time.
    CacheService: {
      getScriptCache: () => ({
        get: k => (cache[k] === undefined ? null : cache[k]),
        put: (k, v) => { cache[k] = v; },
        putAll: map => { Object.keys(map).forEach(k => { cache[k] = map[k]; }); }
      })
    },

    // The real mutex is taken at the edge of the request, before the sheet is
    // even loaded, so this is a formality inside the logic.
    LockService: {
      getScriptLock: () => ({
        tryLock: () => true,
        releaseLock: () => {},
        hasLock: () => true
      })
    },

    Session: {
      getActiveUser: () => ({ getEmail: () => user.email }),
      getEffectiveUser: () => ({ getEmail: () => user.email }),
      getScriptTimeZone: () => 'server-local'
    },

    Utilities: {
      formatDate: (d, tz, pattern) => {
        // Park the quoted literal so the field substitutions cannot touch it.
        let out = pattern.replace("'T'", " LIT ");
        out = out
          .replace(/yyyy/, d.getFullYear())
          .replace(/MMM/, MONTHS[d.getMonth()])
          .replace(/MM/, pad(d.getMonth() + 1, 2))
          .replace(/dd/, pad(d.getDate(), 2))
          .replace(/HH/, pad(d.getHours(), 2))
          .replace(/mm/, pad(d.getMinutes(), 2))
          .replace(/ss/, pad(d.getSeconds(), 2));
        return out.replace(" LIT ", "T");
      }
    },

    // Only referenced inside doGet, which never runs here.
    HtmlService: {
      createTemplateFromFile: () => { throw new Error('HtmlService is not available on this backend.'); },
      createHtmlOutputFromFile: () => { throw new Error('HtmlService is not available on this backend.'); }
    }
  };

  vm.createContext(sandbox);
  compiled().runInContext(sandbox, { timeout: 20000 });
  return sandbox;
}

/** { tab: { columnName: type } } read straight off DB.SCHEMA. */
function schemaTypes(sandbox) {
  const out = {};
  const schema = sandbox.DB && sandbox.DB.SCHEMA;
  if (!schema) throw new Error('The logic bundle did not define DB.SCHEMA.');
  Object.keys(schema).forEach(tab => {
    out[tab] = {};
    schema[tab].cols.forEach(c => { out[tab][c[0]] = c[1]; });
  });
  return out;
}

/**
 * Runs one API call.
 * user: { email, name } — already authenticated. Role is checked by Auth inside
 * the logic, against the Users tab, exactly as it is on Apps Script.
 */
async function run(fn, args, user) {
  if (typeof fn !== 'string' || !(MUTATING.has(fn) || READING.has(fn) || ADMIN.has(fn))) {
    throw Object.assign(new Error('Unknown or disallowed function: ' + fn), { status: 400 });
  }

  const host = sheetsHost.createHost();
  const sandbox = createSandbox(user, host);
  const target = sandbox[fn];
  if (typeof target !== 'function') {
    throw Object.assign(new Error('Function not found in the logic bundle: ' + fn), { status: 400 });
  }

  const mutating = MUTATING.has(fn) || ADMIN.has(fn);
  let release = null;
  const started = Date.now();

  try {
    if (mutating) release = await sheetsHost.acquireLock(user.email + ' · ' + fn);

    await host.load(schemaTypes(sandbox));

    if (ADMIN.has(fn)) requireAdminOrFirstRun(sandbox, fn);

    const result = target.apply(null, Array.isArray(args) ? args : []);

    let flushed = null;
    if (host.hasChanges()) {
      if (!mutating) {
        console.warn('[asset-tracker] ' + fn + ' modified the sheet but is not marked as a write. ' +
          'Flushing anyway, without a lock held.');
      }
      flushed = await host.flush();
    }

    console.log('[asset-tracker] ' + fn + ' by ' + user.email + ' in ' + (Date.now() - started) + 'ms' +
      (flushed ? ' — wrote ' + flushed.cells + ' cells across ' + flushed.ranges + ' ranges' : ''));

    return result;
  } finally {
    if (release) {
      try { await release(); }
      catch (e) { console.error('[asset-tracker] failed to release the write lock: ' + e.message); }
    }
  }
}

/**
 * Setup functions need Admin — except on a brand new spreadsheet, where there is
 * no Users tab to grant it. That is the same bootstrap rule Auth.gs uses.
 */
function requireAdminOrFirstRun(sandbox, fn) {
  let users = [];
  try { users = sandbox.DB.read('Users'); } catch (e) { users = []; }
  if (!users.length) return;
  sandbox.Auth.require('Admin');
}

module.exports = { run, MUTATING, READING, ADMIN, _createSandbox: createSandbox, _schemaTypes: schemaTypes };
