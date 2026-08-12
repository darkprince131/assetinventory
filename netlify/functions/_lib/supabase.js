/**
 * supabase.js — a thin PostgREST client. No SDK.
 *
 * Every call uses the service-role key, which bypasses RLS. That key never
 * leaves the function environment: the browser talks only to /api, and the
 * generated schema enables RLS with no policies so the public anon key can
 * read nothing even if it leaks.
 */

const env = require('./env');

function base() {
  return env.supabaseUrl().replace(/\/$/, '') + '/rest/v1';
}

function headers(extra) {
  const key = env.supabaseServiceKey();
  return Object.assign({
    apikey: key,
    authorization: 'Bearer ' + key,
    'content-type': 'application/json'
  }, extra || {});
}

async function request(pathAndQuery, options) {
  const res = await fetch(base() + pathAndQuery, Object.assign({}, options, {
    headers: headers((options && options.headers) || {})
  }));

  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (e) { body = { raw: text }; }

  if (!res.ok) {
    const msg = (body && (body.message || body.hint || body.raw)) || res.statusText;
    if (res.status === 401 || res.status === 403) {
      throw new Error('Supabase refused the request (' + res.status + '): ' + msg +
        '. Check SUPABASE_SERVICE_ROLE_KEY.');
    }
    if (res.status === 404) {
      throw new Error('Table not found in Supabase: ' + msg +
        '. Run supabase/schema.sql in the SQL editor first.');
    }
    throw new Error('Supabase error (' + res.status + '): ' + msg);
  }
  return body;
}

/** All rows of a table, oldest first. Paged, because PostgREST caps at 1000. */
async function selectAll(table, columns) {
  const out = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const rows = await request(
      '/' + table + '?select=' + (columns || '*') + '&order=row_id.asc',
      { method: 'GET', headers: { range: from + '-' + (from + pageSize - 1), 'range-unit': 'items' } }
    );
    if (!rows || !rows.length) break;
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out;
}

async function selectWhere(table, query) {
  return request('/' + table + '?' + query, { method: 'GET' }) || [];
}

async function insert(table, rows) {
  if (!rows.length) return [];
  return request('/' + table, {
    method: 'POST',
    headers: { prefer: 'return=representation' },
    body: JSON.stringify(rows)
  }) || [];
}

async function update(table, query, patch, options) {
  return request('/' + table + '?' + query, {
    method: 'PATCH',
    headers: { prefer: (options && options.returning === false) ? 'return=minimal' : 'return=representation' },
    body: JSON.stringify(patch)
  });
}

async function upsert(table, rows, onConflict) {
  if (!rows.length) return [];
  return request('/' + table + (onConflict ? '?on_conflict=' + onConflict : ''), {
    method: 'POST',
    headers: { prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(rows)
  }) || [];
}

/** Confirms the schema is present, with a message that says what to do if not. */
async function checkSchema() {
  try {
    await request('/_system?select=id&limit=1', { method: 'GET' });
    return true;
  } catch (e) {
    throw new Error('Supabase is reachable but the schema is missing (' + e.message +
      '). Open the Supabase SQL editor and run supabase/schema.sql.');
  }
}

module.exports = { request, selectAll, selectWhere, insert, update, upsert, checkSchema, base };
