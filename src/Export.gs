/**
 * Export.gs — canned reports. Each returns { name, title, headers, rows }.
 * The client turns that into a CSV download; writeToTab() puts it in the Sheet.
 */

var Reports = (function () {

  var LIST = [
    { id: 'asset_register', title: 'Full asset register' },
    { id: 'assets_by_employee', title: 'Assets by employee' },
    { id: 'assets_by_location', title: 'Assets by location' },
    { id: 'warranty_expiry', title: 'Warranty expiry (next 90 days)' },
    { id: 'amc_expiry', title: 'AMC expiry (next 90 days)' },
    { id: 'rented_assets', title: 'Rented / leased assets and return dates' },
    { id: 'maintenance_cost', title: 'Maintenance cost (by asset / vendor / month)' },
    { id: 'assignment_history', title: 'Assignment history (date range)' },
    { id: 'audit_log', title: 'Audit log (date range)' }
  ];

  function build(id, params) {
    params = params || {};
    switch (id) {
      case 'asset_register': return assetRegister(params);
      case 'assets_by_employee': return assetsByEmployee(params);
      case 'assets_by_location': return assetsByLocation(params);
      case 'warranty_expiry': return expiry('warranty_end', 'Warranty expiry (next 90 days)', 'warranty_expiry', params);
      case 'amc_expiry': return expiry('amc_end', 'AMC expiry (next 90 days)', 'amc_expiry', params);
      case 'rented_assets': return rented(params);
      case 'maintenance_cost': return maintenanceCost(params);
      case 'assignment_history': return assignmentHistory(params);
      case 'audit_log': return auditLog(params);
      default: throw new Error('Unknown report: ' + id);
    }
  }

  function cell(v) {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return Utils.fmtDate(v);
    return v;
  }

  function assetRegister(p) {
    var ctx = Assets.context();
    var cols = DB.SCHEMA.Assets.cols.map(function (c) { return c[0]; });
    var headers = cols.concat(['assigned_to_name', 'assigned_to_email', 'department', 'location_name', 'vendor_name']);
    var rows = DB.read('Assets')
      .filter(function (a) { return p.includeRetired ? true : a.status !== 'Retired'; })
      .map(function (a) {
        var d = Assets.decorate(a, ctx);
        return headers.map(function (h) { return cell(d[h]); });
      });
    return { name: 'asset_register', title: 'Full asset register', headers: headers, rows: rows };
  }

  function assetsByEmployee(p) {
    var ctx = Assets.context();
    var headers = ['emp_id', 'full_name', 'email', 'department', 'employee_status', 'asset_id', 'category', 'make', 'model', 'serial_number', 'assigned_on', 'location_name', 'condition'];
    var rows = [];
    DB.read('Assets').filter(function (a) { return a.assigned_to_emp_id; }).forEach(function (a) {
      var d = Assets.decorate(a, ctx);
      var emp = ctx.empById[Utils.norm(a.assigned_to_emp_id)] || {};
      rows.push([a.assigned_to_emp_id, emp.full_name || '', emp.email || '', emp.department || '', emp.status || '',
        a.asset_id, a.category, a.make, a.model, a.serial_number, cell(a.assigned_on), d.location_name, a.condition]);
    });
    rows.sort(function (x, y) { return String(x[1]).localeCompare(String(y[1])); });
    return { name: 'assets_by_employee', title: 'Assets by employee', headers: headers, rows: rows };
  }

  function assetsByLocation(p) {
    var ctx = Assets.context();
    var headers = ['location_id', 'location_name', 'asset_id', 'category', 'make', 'model', 'serial_number', 'status', 'assigned_to_name'];
    var rows = DB.read('Assets')
      .filter(function (a) { return a.status !== 'Retired'; })
      .map(function (a) {
        var d = Assets.decorate(a, ctx);
        return [a.location_id, d.location_name, a.asset_id, a.category, a.make, a.model, a.serial_number, a.status, d.assigned_to_name];
      });
    rows.sort(function (x, y) { return String(x[1]).localeCompare(String(y[1])); });
    return { name: 'assets_by_location', title: 'Assets by location', headers: headers, rows: rows };
  }

  function expiry(field, title, name, p) {
    var window = p.days || 90;
    var ctx = Assets.context();
    var headers = ['asset_id', 'category', 'make', 'model', 'serial_number', 'status', 'assigned_to_name', 'location_name', field, 'days_remaining', 'vendor_name'];
    var rows = [];
    DB.read('Assets').forEach(function (a) {
      if (a.status === 'Retired' || !(a[field] instanceof Date)) return;
      var days = Utils.daysUntil(a[field]);
      if (days < 0 || days > window) return;
      var d = Assets.decorate(a, ctx);
      rows.push([a.asset_id, a.category, a.make, a.model, a.serial_number, a.status, d.assigned_to_name,
        d.location_name, cell(a[field]), days, field === 'amc_end' ? d.amc_vendor_name : d.vendor_name]);
    });
    rows.sort(function (x, y) { return x[9] - y[9]; });
    return { name: name, title: title, headers: headers, rows: rows };
  }

  function rented(p) {
    var ctx = Assets.context();
    var headers = ['asset_id', 'category', 'make', 'model', 'serial_number', 'ownership', 'rental_vendor_name', 'rental_start', 'rental_end', 'days_remaining', 'assigned_to_name', 'location_name'];
    var rows = [];
    DB.read('Assets').forEach(function (a) {
      if (a.ownership === 'Owned' || a.status === 'Retired') return;
      var d = Assets.decorate(a, ctx);
      rows.push([a.asset_id, a.category, a.make, a.model, a.serial_number, a.ownership, d.rental_vendor_name,
        cell(a.rental_start), cell(a.rental_end), a.rental_end ? Utils.daysUntil(a.rental_end) : '',
        d.assigned_to_name, d.location_name]);
    });
    rows.sort(function (x, y) { return (x[9] === '' ? 1e9 : x[9]) - (y[9] === '' ? 1e9 : y[9]); });
    return { name: 'rented_assets', title: 'Rented / leased assets', headers: headers, rows: rows };
  }

  function maintenanceCost(p) {
    var groupBy = p.groupBy || 'asset';
    var ctx = Assets.context();
    var assets = Utils.indexBy(DB.read('Assets'), 'asset_id');
    var map = {};
    DB.read('Maintenance').forEach(function (m) {
      if (Utils.trim(m.status) === 'Cancelled') return;
      var key, label;
      if (groupBy === 'vendor') {
        key = Utils.trim(m.vendor_id) || '(none)';
        var v = ctx.venById[Utils.norm(key)];
        label = v ? v.name : key;
      } else if (groupBy === 'month') {
        var d = m.reported_on instanceof Date ? m.reported_on : null;
        key = d ? d.getFullYear() + '-' + Utils.pad(d.getMonth() + 1, 2) : '(no date)';
        label = key;
      } else {
        key = Utils.trim(m.asset_id);
        var a = assets[Utils.norm(key)];
        label = a ? [a.make, a.model].filter(String).join(' ') : '';
      }
      if (!map[key]) map[key] = { key: key, label: label, events: 0, cost: 0, open: 0 };
      map[key].events++;
      map[key].cost += (typeof m.cost === 'number' ? m.cost : 0);
      if (Maintenance.OPEN_STATUSES.indexOf(Utils.trim(m.status)) >= 0) map[key].open++;
    });
    var headers = [groupBy, 'label', 'events', 'open_events', 'total_cost'];
    var rows = Object.keys(map).map(function (k) {
      return [map[k].key, map[k].label, map[k].events, map[k].open, map[k].cost];
    }).sort(function (x, y) { return y[4] - x[4]; });
    return { name: 'maintenance_cost_by_' + groupBy, title: 'Maintenance cost by ' + groupBy, headers: headers, rows: rows };
  }

  function inRange(d, from, to) {
    if (!(d instanceof Date)) return false;
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  }

  function assignmentHistory(p) {
    var from = p.from ? Utils.parseDate(p.from) : null;
    var to = p.to ? Utils.parseDate(p.to) : null;
    if (to) to = new Date(to.getTime() + 86399000);
    var ctx = Assets.context();
    var headers = ['assignment_id', 'asset_id', 'make', 'model', 'action', 'emp_id', 'employee', 'from_location', 'to_location', 'assigned_on', 'returned_on', 'condition_out', 'condition_in', 'acknowledged', 'remarks', 'created_by'];
    var assets = Utils.indexBy(DB.read('Assets'), 'asset_id');
    var rows = [];
    DB.read('Assignments').forEach(function (r) {
      var when = r.assigned_on || r.created_at;
      if ((from || to) && !inRange(when, from, to)) return;
      var a = assets[Utils.norm(r.asset_id)] || {};
      var emp = ctx.empById[Utils.norm(r.emp_id)];
      var fl = ctx.locById[Utils.norm(r.from_location_id)];
      var tl = ctx.locById[Utils.norm(r.to_location_id)];
      rows.push([r.assignment_id, r.asset_id, a.make || '', a.model || '', r.action, r.emp_id,
        emp ? emp.full_name : '', fl ? fl.name : r.from_location_id, tl ? tl.name : r.to_location_id,
        cell(r.assigned_on), cell(r.returned_on), r.condition_out, r.condition_in,
        r.acknowledged === true ? 'Yes' : 'No', r.remarks, r.created_by]);
    });
    return { name: 'assignment_history', title: 'Assignment history', headers: headers, rows: rows };
  }

  function auditLog(p) {
    var from = p.from ? Utils.parseDate(p.from) : null;
    var to = p.to ? Utils.parseDate(p.to) : null;
    if (to) to = new Date(to.getTime() + 86399000);
    var headers = DB.SCHEMA.AuditLog.cols.map(function (c) { return c[0]; });
    var rows = DB.read('AuditLog').filter(function (r) {
      if (p.entity && r.entity !== p.entity) return false;
      if (p.entityId && Utils.norm(r.entity_id) !== Utils.norm(p.entityId)) return false;
      if (p.user && Utils.norm(r.user_email).indexOf(Utils.norm(p.user)) < 0) return false;
      if ((from || to) && !inRange(r.timestamp, from, to)) return false;
      return true;
    }).map(function (r) {
      return headers.map(function (h) {
        return h === 'timestamp' ? (r.timestamp instanceof Date ? Utilities.formatDate(r.timestamp, Session.getScriptTimeZone(), 'dd-MMM-yyyy HH:mm') : '') : cell(r[h]);
      });
    }).reverse();
    return { name: 'audit_log', title: 'Audit log', headers: headers, rows: rows };
  }

  /** Writes a built report to a new tab in the bound spreadsheet. */
  function toTab(id, params) {
    var rep = build(id, params);
    var tabName = rep.name.slice(0, 80) + ' ' + Utils.isoDate(new Date());
    var url = DB.writeTab(tabName, rep.headers, rep.rows);
    return { tab: tabName, url: url, rows: rep.rows.length };
  }

  return { LIST: LIST, build: build, toTab: toTab };
})();
