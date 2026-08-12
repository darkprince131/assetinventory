/**
 * supabase-host.js — fills the shared grid from Postgres and writes changes back.
 *
 * Same contract as sheets-host.js, so runtime.js can swap between them and the
 * business logic in /src cannot tell the difference:
 *
 *   load(schemaCols) → run the logic synchronously → flush()
 *
 * Each tab maps to a lower-cased table with identical column names. The grid's
 * row order is `row_id` order, which is insertion order, which is what makes
 * "append a row" mean the same thing it means in a spreadsheet.
 */

const grid = require('./grid');
const db = require('./supabase');
const env = require('./env');

const LOCK_STALE_MS = 30000;

function decode(value, type) {
  if (value === null || value === undefined) return '';
  if (type === 'date') return grid.parseDateOnly(value) || '';
  if (type === 'datetime') {
    const d = new Date(value);
    return isNaN(d.getTime()) ? '' : d;
  }
  if (type === 'number') return value === '' ? '' : Number(value);
  if (type === 'bool') return value === true || value === 'true';
  return String(value);
}

function encode(value, type) {
  if (value === '' || value === null || value === undefined) return null;
  if (value instanceof Date) {
    return type === 'datetime' ? value.toISOString() : grid.dateOnlyString(value);
  }
  if (type === 'number') {
    const n = typeof value === 'number' ? value : Number(String(value).replace(/,/g, ''));
    return isNaN(n) ? null : n;
  }
  if (type === 'bool') {
    if (typeof value === 'boolean') return value;
    const s = String(value).trim().toLowerCase();
    if (['true', 'yes', '1'].indexOf(s) >= 0) return true;
    if (['false', 'no', '0'].indexOf(s) >= 0) return false;
    return null;
  }
  return String(value);
}

function tableFor(tab) { return tab.toLowerCase(); }

function createHost() {
  const ss = new grid.Spreadsheet('');
  let columns = {}; // tab -> [[name,type], …]

  const app = grid.spreadsheetApp(ss);
  // Postgres has no ad-hoc tabs: the schema is fixed and generated.
  ss.insertSheet = function (name) {
    throw new Error('"' + name + '" cannot be created on the Supabase backend. ' +
      'Writing a report to a new tab is a Google Sheets feature — download the CSV instead.');
  };
  ss.deleteSheet = function () {
    throw new Error('Tables cannot be dropped from the app on the Supabase backend.');
  };

  return {
    spreadsheet: ss,
    SpreadsheetApp: app,
    columnTypes: {},

    /** schemaCols: { tab: [[columnName, type], …] } straight from DB.SCHEMA. */
    async load(schemaCols) {
      columns = schemaCols;
      await db.checkSchema();

      const tabs = Object.keys(schemaCols);
      const loaded = await Promise.all(tabs.map(async tab => {
        const cols = schemaCols[tab];
        const rows = await db.selectAll(tableFor(tab), 'row_id,' + cols.map(c => c[0]).join(','));
        return { tab, cols, rows };
      }));

      ss.sheets = [];
      this.columnTypes = {};

      loaded.forEach(({ tab, cols, rows }) => {
        const sh = new grid.Sheet(tab, 0);
        sh.grid = [cols.map(c => c[0])];              // row 1: headers
        rows.forEach((r, i) => {
          sh.grid.push(cols.map(c => decode(r[c[0]], c[1])));
          sh.keys[i + 2] = r.row_id;                  // grid row -> row_id
        });
        sh.dirty.clear();
        this.columnTypes[tab] = cols.map(c => c[1]);
        ss.sheets.push(sh);
      });

      return ss.sheets.length;
    },

    hasChanges() {
      return ss.sheets.some(s => [...s.dirty].some(r => r > 1));
    },

    /** Writes back only the rows the logic touched. */
    async flush() {
      let inserted = 0, updated = 0;

      for (const sh of ss.sheets) {
        const cols = columns[sh.name];
        if (!cols) continue;

        const dirtyRows = [...sh.dirty].filter(r => r > 1).sort((a, b) => a - b);
        if (!dirtyRows.length) continue;

        const inserts = [];
        const updates = [];
        dirtyRows.forEach(r => {
          const row = sh.grid[r - 1] || [];
          const record = {};
          cols.forEach((c, i) => { record[c[0]] = encode(row[i], c[1]); });
          if (sh.keys[r]) updates.push({ row_id: sh.keys[r], record });
          else inserts.push(record);
        });

        if (inserts.length) {
          const created = await db.insert(tableFor(sh.name), inserts);
          inserted += inserts.length;
          // Keep the grid consistent if anything runs after the flush.
          created.forEach((rec, i) => {
            const gridRow = dirtyRows.filter(r => !sh.keys[r])[i];
            if (gridRow) sh.keys[gridRow] = rec.row_id;
          });
        }

        for (const u of updates) {
          await db.update(tableFor(sh.name), 'row_id=eq.' + u.row_id, u.record, { returning: false });
          updated++;
        }
      }

      ss.sheets.forEach(s => s.dirty.clear());
      return { ranges: inserted + updated, cells: inserted + updated, inserted, updated };
    }
  };
}

/**
 * The write mutex, as a single conditional UPDATE. Postgres evaluates the
 * predicate and the write atomically, so whoever's UPDATE affects the row wins
 * and everyone else gets an empty result and retries. A lock older than 30
 * seconds is treated as abandoned.
 */
async function acquireLock(label) {
  const token = require('crypto').randomUUID();
  const deadline = Date.now() + env.lockTimeoutMs();

  while (Date.now() < deadline) {
    const stale = new Date(Date.now() - LOCK_STALE_MS).toISOString();
    const claimed = await db.update(
      '_system',
      'id=eq.1&or=(token.is.null,locked_at.lt.' + stale + ')',
      { token, locked_at: new Date().toISOString(), label: String(label || '').slice(0, 200) }
    );

    if (Array.isArray(claimed) && claimed.length && claimed[0].token === token) {
      return async () => {
        await db.update('_system', 'id=eq.1&token=eq.' + token,
          { token: null, locked_at: null, label: null }, { returning: false });
      };
    }
    await sleep(120 + Math.floor(Math.random() * 180));
  }
  throw new Error('The system is busy with another update. Try again in a moment.');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { createHost, acquireLock, _internals: { decode, encode, tableFor } };
