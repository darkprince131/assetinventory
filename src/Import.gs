/**
 * Import.gs — bulk CSV import: template, validate/preview, commit.
 * The client parses the CSV and sends rows in chunks of 200.
 */

var Importer = (function () {

  var CLEAR = '--CLEAR--';

  var ENTITIES = {
    Assets: {
      tab: 'Assets', prefix: 'AST', idCol: 'asset_id',
      matchCol: 'serial_number', altMatchCol: 'asset_id',
      // Built lazily: file load order across .gs files is not guaranteed.
      colsFn: function () { return ['asset_id'].concat(Assets.FORM_FIELDS); },
      required: ['category', 'make', 'model', 'status', 'ownership', 'location_id'],
      enums: { category: 'category', status: 'status', condition: 'condition', ownership: 'ownership', currency: 'currency' },
      fks: {
        location_id: { tab: 'Locations', idCol: 'location_id', nameCol: 'name', label: 'Location', master: 'Locations' },
        vendor_id: { tab: 'Vendors', idCol: 'vendor_id', nameCol: 'name', label: 'Vendor', master: 'Vendors' },
        rental_vendor_id: { tab: 'Vendors', idCol: 'vendor_id', nameCol: 'name', label: 'Rental vendor', master: 'Vendors' },
        amc_vendor_id: { tab: 'Vendors', idCol: 'vendor_id', nameCol: 'name', label: 'AMC vendor', master: 'Vendors' }
      },
      example: [
        {
          asset_id: '', asset_tag: 'AST-00001', category: 'Laptop', subcategory: 'Ultrabook', make: 'Dell',
          model: 'Latitude 5440', serial_number: 'DL1234567', status: 'In Stock', condition: 'New',
          ownership: 'Owned', location_id: 'LOC-001', purchase_date: '14-05-2024', purchase_cost: '92000',
          currency: 'INR', po_number: 'PO-2401', invoice_number: 'INV-9101', vendor_id: 'Redington India',
          warranty_start: '14-05-2024', warranty_end: '13-05-2027', specs: 'i7-1355U / 16GB / 512GB NVMe'
        },
        {
          asset_id: '', asset_tag: '', category: 'Monitor', subcategory: '24-inch IPS', make: 'Dell',
          model: 'P2422H', serial_number: 'DL7654321', status: 'In Stock', condition: 'Good',
          ownership: 'Rented', rental_vendor_id: 'VEN-003', rental_start: '01-04-2025', rental_end: '31-03-2026',
          location_id: 'Bengaluru HQ — 4th Floor', currency: 'INR'
        }
      ]
    },
    Employees: {
      tab: 'Employees', prefix: 'EMP', idCol: 'emp_id',
      matchCol: 'emp_id', altMatchCol: 'email',
      cols: ['emp_id', 'full_name', 'email', 'department', 'designation', 'location_id', 'manager_email', 'status', 'date_joined', 'date_exited'],
      required: ['full_name', 'email'],
      enums: { department: 'department' },
      fks: { location_id: { tab: 'Locations', idCol: 'location_id', nameCol: 'name', label: 'Location', master: 'Locations' } },
      example: [
        { emp_id: 'EMP-0001', full_name: 'Aarav Sharma', email: 'aarav.sharma@example.com', department: 'IT', designation: 'Engineer', location_id: 'LOC-001', manager_email: 'manager@example.com', status: 'Active', date_joined: '01-04-2023', date_exited: '' },
        { emp_id: '', full_name: 'Diya Iyer', email: 'diya.iyer@example.com', department: 'Finance', designation: 'Analyst', location_id: 'Bengaluru HQ — 4th Floor', manager_email: '', status: 'Active', date_joined: '15-07-2024', date_exited: '' }
      ]
    },
    Locations: {
      tab: 'Locations', prefix: 'LOC', idCol: 'location_id',
      matchCol: 'location_id', altMatchCol: 'name',
      cols: ['location_id', 'name', 'type', 'city', 'state', 'country', 'address', 'active'],
      required: ['name', 'type'],
      enums: { type: 'location_type' },
      fks: {},
      example: [
        { location_id: 'LOC-001', name: 'Bengaluru HQ — 4th Floor', type: 'Office', city: 'Bengaluru', state: 'Karnataka', country: 'India', address: '4th Floor, Tower B', active: 'TRUE' },
        { location_id: '', name: 'Central Warehouse', type: 'Warehouse', city: 'Bengaluru', state: 'Karnataka', country: 'India', address: '', active: 'TRUE' }
      ]
    },
    Vendors: {
      tab: 'Vendors', prefix: 'VEN', idCol: 'vendor_id',
      matchCol: 'vendor_id', altMatchCol: 'name',
      cols: ['vendor_id', 'name', 'type', 'contact_person', 'email', 'phone', 'gstin', 'address', 'notes', 'active'],
      required: ['name'],
      enums: {},
      fks: {},
      example: [
        { vendor_id: 'VEN-001', name: 'Redington India', type: 'Supplier', contact_person: 'Supply desk', email: 'contact@redington.com', phone: '+91 80 4000 0000', gstin: '29AAACR0000A1Z1', address: 'Bengaluru', notes: '', active: 'TRUE' },
        { vendor_id: '', name: 'CompuCare Services', type: 'AMC, Service', contact_person: 'Service manager', email: 'help@compucare.com', phone: '+91 80 4000 1111', gstin: '', address: 'Bengaluru', notes: '', active: 'TRUE' }
      ]
    }
  };

  function spec(entity) {
    var s = ENTITIES[entity];
    if (!s) throw new Error('Unknown import entity: ' + entity);
    if (!s.cols && s.colsFn) s.cols = s.colsFn();
    return s;
  }

  // ------------------------------------------------------------------ template

  function template(entity) {
    var s = spec(entity);
    var cfg = DB.config();
    var lines = [];

    var notes = [];
    Object.keys(s.enums).forEach(function (col) {
      notes.push(col + ' = ' + (cfg[s.enums[col]] || []).join(' | '));
    });
    Object.keys(s.fks).forEach(function (col) {
      notes.push(col + ' accepts the ID or the exact name from the ' + s.fks[col].master + ' master');
    });
    lines.push('# ' + entity + ' import template. Dates: DD-MM-YYYY, YYYY-MM-DD or DD/MM/YYYY (day first).');
    lines.push('# On an update row an empty cell means "leave unchanged". Type ' + CLEAR + ' to clear a field.');
    if (entity === 'Assets') {
      lines.push('# Rows are matched on serial_number first, then asset_id. Assignment is not importable — use the Assign action.');
    }
    notes.forEach(function (n) { lines.push('# ' + n); });

    lines.push(s.cols.map(csvCell).join(','));
    s.example.forEach(function (ex) {
      lines.push(s.cols.map(function (c) { return csvCell(ex[c] === undefined ? '' : ex[c]); }).join(','));
    });
    return { filename: entity.toLowerCase() + '_import_template.csv', csv: lines.join('\r\n') };
  }

  function csvCell(v) {
    var s = (v === null || v === undefined) ? '' : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  // ------------------------------------------------------------------ validate

  function lookups(entity) {
    var s = spec(entity);
    var L = { cfg: DB.config(), fk: {}, existing: DB.read(s.tab) };
    Object.keys(s.fks).forEach(function (col) {
      var f = s.fks[col];
      var rows = DB.read(f.tab);
      var byId = {}, byName = {}, dupName = {};
      rows.forEach(function (r) {
        byId[Utils.norm(r[f.idCol])] = r[f.idCol];
        var n = Utils.norm(r[f.nameCol]);
        if (n) {
          if (byName[n] !== undefined) dupName[n] = true;
          byName[n] = r[f.idCol];
        }
      });
      L.fk[col] = { byId: byId, byName: byName, dupName: dupName, label: f.label, master: f.master };
    });
    L.byMatch = {};
    L.byAlt = {};
    L.existing.forEach(function (r) {
      var m = Utils.norm(r[s.matchCol]);
      if (m) L.byMatch[m] = r;
      var a = Utils.norm(r[s.altMatchCol]);
      if (a) L.byAlt[a] = r;
    });
    return L;
  }

  /**
   * p: { entity, rows: [{col: value}], startIndex, dupKeys: [normalised keys
   * that appear more than once in the file] }
   * Returns { results: [{ i, verdict, reason, id, diff }] }
   */
  function validateChunk(p) {
    var s = spec(p.entity);
    var L = lookups(p.entity);
    var dup = {};
    (p.dupKeys || []).forEach(function (k) { dup[k] = true; });
    var start = p.startIndex || 0;
    var results = [];

    (p.rows || []).forEach(function (raw, n) {
      var idx = start + n;
      var errors = [];
      var clean = {};

      // Coerce every known column
      s.cols.forEach(function (col) {
        var v = raw[col];
        if (v === undefined) { clean[col] = undefined; return; }
        var str = Utils.trim(v);
        if (str === '') { clean[col] = ''; return; }
        if (str === CLEAR) { clean[col] = CLEAR; return; }
        var t = DB.typeOf(s.tab, col);
        try {
          if (t === 'date') clean[col] = Utils.parseDate(str);
          else if (t === 'number') clean[col] = Utils.toNumber(str);
          else if (t === 'bool') clean[col] = Utils.toBool(str);
          else clean[col] = str;
        } catch (e) {
          errors.push(col + ': ' + e.message);
          clean[col] = '';
        }
      });

      // Enums
      Object.keys(s.enums).forEach(function (col) {
        var v = clean[col];
        if (!v || v === CLEAR) return;
        var list = L.cfg[s.enums[col]] || [];
        if (list.length && list.indexOf(v) < 0) {
          errors.push(col + ': "' + v + '" is not a valid value (' + list.join(', ') + ')');
        }
      });

      // FKs — accept the ID or the exact master name
      Object.keys(s.fks).forEach(function (col) {
        var v = clean[col];
        if (!v || v === CLEAR) return;
        var m = L.fk[col];
        var key = Utils.norm(v);
        if (m.byId[key]) { clean[col] = m.byId[key]; return; }
        if (m.dupName[key]) { errors.push(col + ': "' + v + '" matches more than one ' + m.master + ' record'); return; }
        if (m.byName[key] !== undefined) { clean[col] = m.byName[key]; return; }
        errors.push(col + ': unknown ' + m.label + ' "' + v + '". Load it into the ' + m.master + ' master first.');
      });

      // Match against existing data
      var matchKey = Utils.norm(clean[s.matchCol]);
      var altKey = Utils.norm(clean[s.altMatchCol]);
      var existing = null;
      if (matchKey && matchKey !== Utils.norm(CLEAR)) existing = L.byMatch[matchKey] || null;
      if (!existing && altKey) existing = L.byAlt[altKey] || null;

      if (matchKey && dup[matchKey]) {
        errors.push(s.matchCol + ': "' + clean[s.matchCol] + '" appears more than once in this file');
      }

      // Required fields — only enforced on CREATE (blank on update = unchanged)
      if (!existing) {
        s.required.forEach(function (col) {
          if (Utils.isBlank(clean[col]) || clean[col] === CLEAR) errors.push(col + ' is required');
        });
        if (p.entity === 'Assets') {
          if (Utils.isBlank(clean.serial_number) && Assets.serialRequired(clean.category)) {
            errors.push('serial_number is required for category ' + (clean.category || '(blank)'));
          }
          if (clean.ownership && clean.ownership !== 'Owned' && Utils.isBlank(clean.rental_vendor_id)) {
            errors.push('rental_vendor_id is required when ownership is ' + clean.ownership);
          }
          if (clean.status === 'Assigned') {
            errors.push('status Assigned cannot be imported — import as In Stock and use the Assign action');
          }
        }
        if (p.entity === 'Employees' && clean.status && ['Active', 'Exited'].indexOf(clean.status) < 0) {
          errors.push('status must be Active or Exited');
        }
        if (p.entity === 'Employees' && clean.email) {
          var mail = Utils.norm(clean.email);
          for (var i = 0; i < L.existing.length; i++) {
            if (Utils.norm(L.existing[i].email) === mail) { errors.push('email already exists on ' + L.existing[i].emp_id); break; }
          }
        }
      } else if (p.entity === 'Assets' && clean.status === 'Assigned' && existing.status !== 'Assigned') {
        errors.push('status Assigned cannot be set by import — use the Assign action');
      }

      // Field-level diff for updates
      var diff = [];
      if (existing) {
        s.cols.forEach(function (col) {
          if (col === s.idCol) return;
          var v = clean[col];
          if (v === undefined || v === '') return; // leave unchanged
          var nv = (v === CLEAR) ? '' : v;
          if (Audit.stamp(existing[col]) !== Audit.stamp(nv)) {
            diff.push({ field: col, old: Audit.stamp(existing[col]), now: Audit.stamp(nv) });
          }
        });
      }

      results.push({
        i: idx,
        verdict: errors.length ? 'ERROR' : (existing ? 'UPDATE' : 'CREATE'),
        reason: errors.join('; '),
        id: existing ? existing[s.idCol] : '',
        diff: diff
      });
    });

    return { results: results };
  }

  // -------------------------------------------------------------------- commit

  /**
   * p: { entity, rows, skipErrors, dupKeys }
   * Commits one chunk. Returns { created, updated, skipped, ids }.
   */
  function commitChunk(p, user) {
    var s = spec(p.entity);
    return Utils.withLock(function () {
      var verdicts = validateChunk({ entity: p.entity, rows: p.rows, startIndex: 0, dupKeys: p.dupKeys }).results;
      var L = lookups(p.entity);

      var toCreate = [], toUpdate = [], auditItems = [], skipped = 0, ids = [];
      var newIdCount = 0;
      verdicts.forEach(function (v) { if (v.verdict === 'CREATE') newIdCount++; });
      var newIds = newIdCount ? Utils.nextIds(s.prefix, newIdCount) : [];
      var idp = 0;
      var now = new Date();

      verdicts.forEach(function (v, n) {
        var raw = p.rows[n];
        if (v.verdict === 'ERROR') {
          if (!p.skipErrors) throw new Error('Row ' + (n + 1) + ': ' + v.reason);
          skipped++;
          return;
        }
        var clean = cleanRow(s, raw, L);

        if (v.verdict === 'CREATE') {
          var row = {};
          DB.SCHEMA[s.tab].cols.forEach(function (c) { row[c[0]] = ''; });
          s.cols.forEach(function (col) {
            var val = clean[col];
            row[col] = (val === undefined || val === CLEAR) ? '' : val;
          });
          row[s.idCol] = Utils.trim(row[s.idCol]) || newIds[idp++];
          if (s.tab === 'Assets') {
            if (!row.asset_tag) row.asset_tag = row[s.idCol];
            if (!row.currency) row.currency = 'INR';
            if (!row.status) row.status = 'In Stock';
            row.assigned_to_emp_id = ''; row.assigned_on = '';
            row.created_at = now; row.created_by = user;
            row.updated_at = now; row.updated_by = user;
          }
          if (s.tab === 'Employees' && !row.status) row.status = 'Active';
          if ((s.tab === 'Locations' || s.tab === 'Vendors') && row.active === '') row.active = true;
          toCreate.push(row);
          ids.push(row[s.idCol]);
          auditItems.push({ entity: entityLabel(s.tab), entityId: row[s.idCol], action: 'Import', changes: [] });

        } else { // UPDATE
          var existing = DB.findById(s.tab, v.id);
          if (!existing) { skipped++; return; }
          var merged = {};
          DB.SCHEMA[s.tab].cols.forEach(function (c) { merged[c[0]] = existing[c[0]]; });
          var changes = [];
          s.cols.forEach(function (col) {
            if (col === s.idCol) return;
            var val = clean[col];
            if (val === undefined || val === '') return;
            var nv = (val === CLEAR) ? '' : val;
            if (Audit.stamp(existing[col]) !== Audit.stamp(nv)) {
              merged[col] = nv;
              changes.push({ field: col, old: existing[col], now: nv });
            }
          });
          if (!changes.length) { skipped++; return; }
          if (s.tab === 'Assets') { merged.updated_at = now; merged.updated_by = user; }
          toUpdate.push({ _row: existing._row, obj: merged });
          ids.push(v.id);
          auditItems.push({ entity: entityLabel(s.tab), entityId: v.id, action: 'Import', changes: changes });
        }
      });

      if (toCreate.length) DB.append(s.tab, toCreate);
      if (toUpdate.length) DB.updateRows(s.tab, toUpdate);
      if (auditItems.length) Audit.write(Audit.buildMany(user, auditItems, 'Bulk Import'));

      return { created: toCreate.length, updated: toUpdate.length, skipped: skipped, ids: ids };
    });
  }

  function cleanRow(s, raw, L) {
    var clean = {};
    s.cols.forEach(function (col) {
      var v = raw[col];
      if (v === undefined) { clean[col] = undefined; return; }
      var str = Utils.trim(v);
      if (str === '' || str === CLEAR) { clean[col] = str; return; }
      var t = DB.typeOf(s.tab, col);
      try {
        if (t === 'date') clean[col] = Utils.parseDate(str);
        else if (t === 'number') clean[col] = Utils.toNumber(str);
        else if (t === 'bool') clean[col] = Utils.toBool(str);
        else clean[col] = str;
      } catch (e) { clean[col] = ''; }
    });
    Object.keys(s.fks).forEach(function (col) {
      var v = clean[col];
      if (!v || v === CLEAR) return;
      var m = L.fk[col], key = Utils.norm(v);
      if (m.byId[key]) clean[col] = m.byId[key];
      else if (m.byName[key] !== undefined && !m.dupName[key]) clean[col] = m.byName[key];
    });
    return clean;
  }

  function entityLabel(tab) {
    return { Assets: 'Asset', Employees: 'Employee', Locations: 'Location', Vendors: 'Vendor' }[tab] || tab;
  }

  function columns(entity) {
    return spec(entity).cols;
  }

  function matchColumn(entity) {
    return spec(entity).matchCol;
  }

  return {
    CLEAR: CLEAR,
    ENTITIES: Object.keys(ENTITIES),
    template: template,
    validateChunk: validateChunk,
    commitChunk: commitChunk,
    columns: columns,
    matchColumn: matchColumn
  };
})();
