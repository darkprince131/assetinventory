/**
 * Code.gs — doGet, HTML include helper, and the API surface the client calls
 * through google.script.run. Every entry point starts with an Auth guard.
 */

function doGet() {
  var user = Auth.currentUser();
  if (!user.hasAccess) {
    var denied = HtmlService.createTemplateFromFile('ui/Index');
    denied.NO_ACCESS = true;
    denied.USER = user;
    return denied.evaluate()
      .setTitle('Asset Tracker')
      .addMetaTag('viewport', 'width=1280');
  }
  var t = HtmlService.createTemplateFromFile('ui/Index');
  t.NO_ACCESS = false;
  t.USER = user;
  return t.evaluate()
    .setTitle('Asset Tracker')
    .addMetaTag('viewport', 'width=1280');
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// ---------------------------------------------------------------- bootstrap

function api_bootstrap() {
  var user = Auth.require('Viewer');
  return Utils.plain({
    user: user,
    config: DB.config(),
    employees: DB.read('Employees').map(strip),
    locations: DB.read('Locations').map(strip),
    vendors: DB.read('Vendors').map(strip),
    reports: Reports.LIST,
    importEntities: Importer.ENTITIES,
    sheetUrl: DB.spreadsheetUrl()
  });
}

function strip(row) {
  var o = {};
  for (var k in row) if (k !== '_row') o[k] = row[k];
  return o;
}

// ------------------------------------------------------------------- assets

function api_getAssets(includeRetired) {
  Auth.require('Viewer');
  return Utils.plain(Assets.list(includeRetired === true));
}

function api_getAsset(id) {
  Auth.require('Viewer');
  var asset = Assets.get(id);
  var ctx = Assets.context();
  var assignments = Assignments.historyFor(id).map(function (r) {
    var o = strip(r);
    var emp = ctx.empById[Utils.norm(r.emp_id)];
    o.employee_name = emp ? emp.full_name : '';
    var fl = ctx.locById[Utils.norm(r.from_location_id)];
    var tl = ctx.locById[Utils.norm(r.to_location_id)];
    o.from_location_name = fl ? fl.name : r.from_location_id;
    o.to_location_name = tl ? tl.name : r.to_location_id;
    return o;
  });
  var maint = Maintenance.historyFor(id).map(function (r) {
    var o = strip(r);
    var v = ctx.venById[Utils.norm(r.vendor_id)];
    o.vendor_name = v ? v.name : r.vendor_id;
    return o;
  });
  var audit = DB.read('AuditLog').filter(function (r) {
    return Utils.norm(r.entity_id) === Utils.norm(id);
  }).reverse().map(strip);

  return Utils.plain({
    asset: asset,
    assignments: assignments,
    maintenance: maint,
    openMaintenance: Maintenance.openFor(id) ? strip(Maintenance.openFor(id)) : null,
    openAssignment: Assignments.openFor(id) ? strip(Assignments.openFor(id)) : null,
    previousStatus: Maintenance.previousStatus(id),
    audit: audit
  });
}

function api_saveAsset(payload) {
  var user = Auth.require('Editor');
  var id = Utils.trim(payload && payload.asset_id);
  var fields = (payload && payload.fields) || {};
  return Utils.plain(id ? Assets.update(id, fields, user.email) : Assets.create(fields, user.email));
}

function api_validateAsset(payload) {
  Auth.require('Viewer');
  var id = Utils.trim(payload && payload.asset_id);
  var existing = id ? DB.findById('Assets', id) : null;
  var res = Assets.validate((payload && payload.fields) || {}, existing, Assets.context(), Assets.serialIndex());
  return { errors: res.errors };
}

// ---------------------------------------------------------------- lifecycle

function api_assign(p) {
  var user = Auth.require('Editor');
  return Utils.plain(Assignments.assign(p, user.email));
}

function api_return(p) {
  var user = Auth.require('Editor');
  return Utils.plain(Assignments.returnAsset(p, user.email));
}

function api_transfer(p) {
  var user = Auth.require('Editor');
  return Utils.plain(Assignments.transfer(p, user.email));
}

function api_retire(p) {
  var user = Auth.require('Editor');
  return Utils.plain(Assets.retire(p.asset_id, p.reason, user.email));
}

function api_openMaintenance(p) {
  var user = Auth.require('Editor');
  return Utils.plain(Maintenance.open(p, user.email));
}

function api_closeMaintenance(p) {
  var user = Auth.require('Editor');
  return Utils.plain(Maintenance.close(p, user.email));
}

// -------------------------------------------------------------------- import

function api_importTemplate(entity) {
  Auth.require('Viewer');
  return Importer.template(entity);
}

function api_importColumns(entity) {
  Auth.require('Viewer');
  return { columns: Importer.columns(entity), matchColumn: Importer.matchColumn(entity) };
}

function api_importValidate(p) {
  Auth.require('Editor');
  return Importer.validateChunk(p);
}

function api_importCommit(p) {
  var user = Auth.require('Editor');
  return Importer.commitChunk(p, user.email);
}

// ---------------------------------------------------------------- dashboard

function api_getDashboard() {
  Auth.require('Viewer');
  return Dashboard.build();
}

function api_getReport(id, params) {
  Auth.require('Viewer');
  var rep = Reports.build(id, params || {});
  // Logging an export must never block the export itself (a Viewer may not
  // hold write access to the sheet).
  try { Audit.log(Auth.currentUser().email, 'Asset', rep.name, 'Export', [], 'UI'); } catch (e) { /* ignore */ }
  return Utils.plain(rep);
}

function api_reportToTab(id, params) {
  Auth.require('Editor');
  var res = Reports.toTab(id, params || {});
  Audit.log(Auth.currentUser().email, 'Asset', id, 'Export', [], 'UI');
  return res;
}

function api_getAudit(filters) {
  Auth.require('Viewer');
  filters = filters || {};
  var rep = Reports.build('audit_log', filters);
  var limit = filters.limit || 500;
  return Utils.plain({ headers: rep.headers, rows: rep.rows.slice(0, limit), total: rep.rows.length });
}

// -------------------------------------------------------------------- masters

var MASTERS = {
  Employees: { tab: 'Employees', prefix: 'EMP', idCol: 'emp_id', label: 'Employee', required: ['full_name', 'email'], activeCol: 'status' },
  Locations: { tab: 'Locations', prefix: 'LOC', idCol: 'location_id', label: 'Location', required: ['name', 'type'], activeCol: 'active' },
  Vendors:   { tab: 'Vendors',   prefix: 'VEN', idCol: 'vendor_id',  label: 'Vendor',   required: ['name'], activeCol: 'active' },
  Users:     { tab: 'Users',     prefix: null,  idCol: 'email',      label: 'User',     required: ['email', 'role'], activeCol: 'active' }
};

function api_masterList(entity) {
  Auth.require('Viewer');
  var m = MASTERS[entity];
  if (!m) throw new Error('Unknown master: ' + entity);
  return Utils.plain(DB.read(m.tab).map(strip));
}

function api_masterSave(entity, obj) {
  var user = Auth.require('Admin');
  var m = MASTERS[entity];
  if (!m) throw new Error('Unknown master: ' + entity);
  var cfg = DB.config();
  var cols = DB.SCHEMA[m.tab].cols;

  var clean = {};
  cols.forEach(function (c) {
    var name = c[0], t = c[1], v = obj[name];
    if (v === undefined) { clean[name] = ''; return; }
    if (t === 'date') { try { clean[name] = Utils.parseDate(v) || ''; } catch (e) { throw new Error(name + ': ' + e.message); } }
    else if (t === 'number') clean[name] = Utils.toNumber(v);
    else if (t === 'bool') clean[name] = (v === '' ? true : Utils.toBool(v));
    else clean[name] = Utils.trim(v);
  });

  m.required.forEach(function (f) {
    if (Utils.isBlank(clean[f])) throw new Error(Assets.label(f) + ' is required.');
  });

  if (entity === 'Users') {
    if (['Admin', 'Editor', 'Viewer'].indexOf(clean.role) < 0) throw new Error('Role must be Admin, Editor or Viewer.');
    if (!/^[^@\s]+@[^@\s]+$/.test(clean.email)) throw new Error('Enter a valid email address.');
  }
  if (entity === 'Employees') {
    if (!/^[^@\s]+@[^@\s]+$/.test(clean.email)) throw new Error('Enter a valid email address.');
    if (clean.status && ['Active', 'Exited'].indexOf(clean.status) < 0) throw new Error('Employee status must be Active or Exited.');
    if (!clean.status) clean.status = 'Active';
    if (clean.department && (cfg.department || []).length && cfg.department.indexOf(clean.department) < 0) {
      throw new Error('Department "' + clean.department + '" is not in Config.');
    }
    if (clean.location_id && !DB.findById('Locations', clean.location_id)) throw new Error('Location not found: ' + clean.location_id);
  }
  if (entity === 'Locations' && (cfg.location_type || []).indexOf(clean.type) < 0) {
    throw new Error('Location type must be one of: ' + (cfg.location_type || []).join(', ') + '.');
  }

  return Utils.withLock(function () {
    var existing = Utils.trim(clean[m.idCol]) ? DB.findById(m.tab, clean[m.idCol]) : null;

    // Uniqueness on email for employees and users
    if (entity === 'Employees' || entity === 'Users') {
      var dupe = DB.findBy(m.tab, 'email', clean.email);
      if (dupe && (!existing || dupe[m.idCol] !== existing[m.idCol])) {
        throw new Error('That email is already on ' + dupe[m.idCol] + '.');
      }
    }

    if (existing) {
      var merged = {};
      DB.SCHEMA[m.tab].cols.forEach(function (c) { merged[c[0]] = clean[c[0]]; });
      var changes = Audit.diff(existing, merged, DB.SCHEMA[m.tab].cols.map(function (c) { return c[0]; }));
      if (!changes.length) return { saved: strip(existing), flagged: [] };
      DB.updateRows(m.tab, [{ _row: existing._row, obj: merged }]);
      Audit.log(user.email, m.label, merged[m.idCol], 'Update', changes, 'UI');
      return Utils.plain({ saved: merged, flagged: flagExited(entity, merged) });
    }

    if (!Utils.trim(clean[m.idCol])) {
      if (!m.prefix) throw new Error('An id is required for ' + entity + '.');
      clean[m.idCol] = Utils.nextId(m.prefix);
    } else if (DB.findById(m.tab, clean[m.idCol])) {
      throw new Error(m.label + ' ' + clean[m.idCol] + ' already exists.');
    }
    DB.append(m.tab, [clean]);
    Audit.log(user.email, m.label, clean[m.idCol], 'Create', [], 'UI');
    return Utils.plain({ saved: clean, flagged: flagExited(entity, clean) });
  });
}

/** On exit, report the assets still held. Never auto-returns them. */
function flagExited(entity, row) {
  if (entity !== 'Employees' || Utils.trim(row.status) !== 'Exited') return [];
  return DB.read('Assets')
    .filter(function (a) { return Utils.norm(a.assigned_to_emp_id) === Utils.norm(row.emp_id) && a.status !== 'Retired'; })
    .map(function (a) { return { asset_id: a.asset_id, description: [a.make, a.model].filter(String).join(' ') }; });
}

/** Soft-deactivate only — masters are never deleted. */
function api_masterToggle(entity, id, active) {
  var user = Auth.require('Admin');
  var m = MASTERS[entity];
  if (!m) throw new Error('Unknown master: ' + entity);
  var row = DB.findById(m.tab, id);
  if (!row) throw new Error(m.label + ' not found: ' + id);

  var patch = {};
  if (m.activeCol === 'status') patch.status = active ? 'Active' : 'Exited';
  else patch.active = !!active;

  var merged = DB.updateById(m.tab, id, patch);
  Audit.log(user.email, m.label, id, 'Update',
    [{ field: m.activeCol, old: row[m.activeCol], now: merged[m.activeCol] }], 'UI');
  return Utils.plain({ saved: merged, flagged: flagExited(entity, merged) });
}

// -------------------------------------------------------------------- config

function api_configSave(rows) {
  var user = Auth.require('Admin');
  if (!Array.isArray(rows) || !rows.length) throw new Error('Nothing to save.');
  return Utils.withLock(function () {
    var sh = DB._sheet('Config');
    var out = rows.filter(function (r) { return Utils.trim(r.key) && Utils.trim(r.value); })
      .map(function (r) { return [Utils.trim(r.key), Utils.trim(r.value)]; });
    var last = sh.getLastRow();
    if (last > 1) sh.getRange(2, 1, last - 1, 2).clearContent();
    if (out.length) sh.getRange(2, 1, out.length, 2).setValues(out);
    DB.bumpVersion();
    applyValidation();
    Audit.log(user.email, 'Asset', 'Config', 'Update', [{ field: 'Config', old: '', now: out.length + ' rows' }], 'UI');
    return { rows: out.length };
  });
}
