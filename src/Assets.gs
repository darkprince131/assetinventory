/**
 * Assets.gs — CRUD, validation and search over the Assets tab.
 */

var Assets = (function () {

  var SERIAL_OPTIONAL = ['Furniture', 'Office Equipment', 'Consumable'];

  // Fields the Add/Edit form owns. Assignment fields are owned by Assignments.gs.
  var FORM_FIELDS = [
    'asset_tag', 'category', 'subcategory', 'make', 'model', 'serial_number', 'status',
    'condition', 'ownership', 'rental_vendor_id', 'rental_start', 'rental_end', 'location_id',
    'purchase_date', 'purchase_cost', 'currency', 'po_number', 'invoice_number', 'vendor_id',
    'warranty_start', 'warranty_end', 'amc_vendor_id', 'amc_start', 'amc_end', 'specs', 'notes'
  ];

  var REQUIRED = ['category', 'make', 'model', 'status', 'ownership', 'location_id'];

  var ACTIVE_STATUSES = ['In Stock', 'Assigned', 'In Repair'];

  function serialRequired(category) {
    return SERIAL_OPTIONAL.indexOf(Utils.trim(category)) < 0;
  }

  function isActive(status) {
    return ACTIVE_STATUSES.indexOf(Utils.trim(status)) >= 0;
  }

  /** Lookup maps used by validation and joins. Built once per request. */
  function context() {
    var cfg = DB.config();
    return {
      cfg: cfg,
      employees: DB.read('Employees'),
      locations: DB.read('Locations'),
      vendors: DB.read('Vendors'),
      empById: Utils.indexBy(DB.read('Employees'), 'emp_id'),
      locById: Utils.indexBy(DB.read('Locations'), 'location_id'),
      venById: Utils.indexBy(DB.read('Vendors'), 'vendor_id')
    };
  }

  /**
   * Server-side validation. Returns { errors: [strings], clean: {field: value} }.
   * `existing` is the current row when updating, null on create.
   * `serialIndex` maps normalised serial -> asset_id for uniqueness checks.
   */
  function validate(input, existing, ctx, serialIndex) {
    ctx = ctx || context();
    var errors = [];
    var clean = {};

    FORM_FIELDS.forEach(function (f) {
      var t = DB.typeOf('Assets', f);
      var v = input[f];
      if (v === undefined) { clean[f] = existing ? existing[f] : ''; return; }
      if (t === 'date') {
        try { clean[f] = Utils.parseDate(v) || ''; }
        catch (e) { errors.push(label(f) + ': ' + e.message); clean[f] = ''; }
      } else if (t === 'number') {
        try { clean[f] = Utils.toNumber(v); }
        catch (e) { errors.push(label(f) + ': ' + e.message); clean[f] = ''; }
      } else {
        clean[f] = Utils.trim(v);
      }
    });

    REQUIRED.forEach(function (f) {
      if (Utils.isBlank(clean[f])) errors.push(label(f) + ' is required.');
    });

    // Enums
    checkEnum('category', 'category');
    checkEnum('status', 'status');
    checkEnum('condition', 'condition');
    checkEnum('ownership', 'ownership');
    if (!Utils.isBlank(clean.currency) && (ctx.cfg.currency || []).length &&
        (ctx.cfg.currency || []).indexOf(clean.currency) < 0) {
      errors.push('Currency "' + clean.currency + '" is not in Config.');
    }
    if (Utils.isBlank(clean.currency)) clean.currency = 'INR';

    // Serial
    var serial = Utils.trim(clean.serial_number);
    if (!serial && serialRequired(clean.category)) {
      errors.push('Serial number is required for category ' + clean.category + '.');
    }
    if (serial && serialIndex) {
      var owner = serialIndex[Utils.norm(serial)];
      if (owner && (!existing || owner !== existing.asset_id)) {
        errors.push('Serial number "' + serial + '" already exists on ' + owner + '.');
      }
    }

    // Asset tag uniqueness (only when present)
    var tag = Utils.trim(clean.asset_tag);
    if (tag) {
      var rows = DB.read('Assets');
      for (var i = 0; i < rows.length; i++) {
        if (Utils.norm(rows[i].asset_tag) === Utils.norm(tag) &&
            (!existing || rows[i].asset_id !== existing.asset_id)) {
          errors.push('Asset tag "' + tag + '" already exists on ' + rows[i].asset_id + '.');
          break;
        }
      }
    }

    // Foreign keys
    fk('location_id', ctx.locById, 'Location');
    fk('vendor_id', ctx.venById, 'Vendor');
    fk('rental_vendor_id', ctx.venById, 'Rental vendor');
    fk('amc_vendor_id', ctx.venById, 'AMC vendor');

    // Ownership / rental block
    if (clean.ownership && clean.ownership !== 'Owned' && Utils.isBlank(clean.rental_vendor_id)) {
      errors.push('Rental vendor is required when ownership is ' + clean.ownership + '.');
    }
    if (clean.ownership === 'Owned') {
      clean.rental_vendor_id = ''; clean.rental_start = ''; clean.rental_end = '';
    }

    // Date sanity
    pair('warranty_start', 'warranty_end', 'Warranty');
    pair('amc_start', 'amc_end', 'AMC');
    pair('rental_start', 'rental_end', 'Rental');

    // Status transitions the form is not allowed to make
    if (existing) {
      if (existing.status === 'Assigned' && clean.status !== 'Assigned') {
        errors.push('Use Return, Transfer or Retire to move this asset out of Assigned.');
      }
      if (existing.status !== 'Assigned' && clean.status === 'Assigned') {
        errors.push('Use the Assign action to put this asset into Assigned.');
      }
      if (existing.status === 'In Repair' && clean.status !== 'In Repair') {
        errors.push('Close the open maintenance record to change status from In Repair.');
      }
    } else if (clean.status === 'Assigned') {
      errors.push('Create the asset as In Stock, then use Assign.');
    }

    return { errors: errors, clean: clean };

    function checkEnum(field, cfgKey) {
      var list = ctx.cfg[cfgKey] || [];
      var v = clean[field];
      if (Utils.isBlank(v)) return;
      if (list.length && list.indexOf(v) < 0) {
        errors.push(label(field) + ' "' + v + '" is not a valid value. Allowed: ' + list.join(', ') + '.');
      }
    }

    function fk(field, map, name) {
      var v = Utils.trim(clean[field]);
      if (!v) return;
      if (!map[Utils.norm(v)]) errors.push(name + ' "' + v + '" does not exist.');
    }

    function pair(a, b, name) {
      if (clean[a] instanceof Date && clean[b] instanceof Date && clean[b] < clean[a]) {
        errors.push(name + ' end date is before its start date.');
      }
    }
  }

  function label(f) {
    return f.replace(/_id$/, '').replace(/_/g, ' ').replace(/^./, function (c) { return c.toUpperCase(); });
  }

  function serialIndex(rows) {
    var map = {};
    (rows || DB.read('Assets')).forEach(function (a) {
      var s = Utils.norm(a.serial_number);
      if (s) map[s] = a.asset_id;
    });
    return map;
  }

  /** Assets joined with employee/location names, ready for the client table. */
  function list(includeRetired) {
    var ctx = context();
    var rows = DB.read('Assets');
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var a = rows[i];
      if (!includeRetired && a.status === 'Retired') continue;
      out.push(decorate(a, ctx));
    }
    return out;
  }

  function decorate(a, ctx) {
    ctx = ctx || context();
    var emp = a.assigned_to_emp_id ? ctx.empById[Utils.norm(a.assigned_to_emp_id)] : null;
    var loc = a.location_id ? ctx.locById[Utils.norm(a.location_id)] : null;
    var o = {};
    DB.SCHEMA.Assets.cols.forEach(function (c) { o[c[0]] = a[c[0]]; });
    o.assigned_to_name = emp ? emp.full_name : '';
    o.assigned_to_email = emp ? emp.email : '';
    o.department = emp ? emp.department : '';
    o.employee_status = emp ? emp.status : '';
    o.location_name = loc ? loc.name : '';
    o.vendor_name = a.vendor_id && ctx.venById[Utils.norm(a.vendor_id)] ? ctx.venById[Utils.norm(a.vendor_id)].name : '';
    o.rental_vendor_name = a.rental_vendor_id && ctx.venById[Utils.norm(a.rental_vendor_id)] ? ctx.venById[Utils.norm(a.rental_vendor_id)].name : '';
    o.amc_vendor_name = a.amc_vendor_id && ctx.venById[Utils.norm(a.amc_vendor_id)] ? ctx.venById[Utils.norm(a.amc_vendor_id)].name : '';
    o.warranty_days = a.warranty_end ? Utils.daysUntil(a.warranty_end) : null;
    o.amc_days = a.amc_end ? Utils.daysUntil(a.amc_end) : null;
    o.rental_days = a.rental_end ? Utils.daysUntil(a.rental_end) : null;
    return o;
  }

  function get(id) {
    var a = DB.findById('Assets', id);
    if (!a) throw new Error('Asset not found: ' + id);
    return decorate(a, context());
  }

  function create(input, user) {
    var ctx = context();
    var v = validate(input, null, ctx, serialIndex());
    if (v.errors.length) throw new Error(v.errors.join('\n'));

    return Utils.withLock(function () {
      // Re-check uniqueness inside the lock — another user may have just written.
      var v2 = validate(input, null, ctx, serialIndex());
      if (v2.errors.length) throw new Error(v2.errors.join('\n'));

      var now = new Date();
      var row = { asset_id: Utils.nextId('AST') };
      FORM_FIELDS.forEach(function (f) { row[f] = v2.clean[f]; });
      if (!row.asset_tag) row.asset_tag = row.asset_id;
      row.assigned_to_emp_id = '';
      row.assigned_on = '';
      row.created_at = now; row.created_by = user;
      row.updated_at = now; row.updated_by = user;

      DB.append('Assets', [row]);
      Audit.log(user, 'Asset', row.asset_id, 'Create', [], 'UI');
      return decorate(row, context());
    });
  }

  function update(id, input, user) {
    var existing = DB.findById('Assets', id);
    if (!existing) throw new Error('Asset not found: ' + id);

    var ctx = context();
    var v = validate(input, existing, ctx, serialIndex());
    if (v.errors.length) throw new Error(v.errors.join('\n'));

    return Utils.withLock(function () {
      var cur = DB.findById('Assets', id);
      var changes = Audit.diff(cur, v.clean, FORM_FIELDS);
      if (!changes.length) return decorate(cur, ctx);

      var merged = {};
      DB.SCHEMA.Assets.cols.forEach(function (c) { merged[c[0]] = cur[c[0]]; });
      FORM_FIELDS.forEach(function (f) { merged[f] = v.clean[f]; });
      merged.updated_at = new Date();
      merged.updated_by = user;

      DB.updateRows('Assets', [{ _row: cur._row, obj: merged }]);
      Audit.log(user, 'Asset', id, 'Update', changes, 'UI');
      return decorate(merged, context());
    });
  }

  /** Applies a patch straight to the row (lifecycle paths use this). */
  function patch(id, fields, user, source, action) {
    var cur = DB.findById('Assets', id);
    if (!cur) throw new Error('Asset not found: ' + id);
    var merged = {};
    DB.SCHEMA.Assets.cols.forEach(function (c) { merged[c[0]] = cur[c[0]]; });
    var keys = Object.keys(fields);
    keys.forEach(function (k) { merged[k] = fields[k]; });
    merged.updated_at = new Date();
    merged.updated_by = user;
    var changes = Audit.diff(cur, merged, keys);
    DB.updateRows('Assets', [{ _row: cur._row, obj: merged }]);
    return { row: merged, changes: changes };
  }

  function retire(id, reason, user) {
    var asset = DB.findById('Assets', id);
    if (!asset) throw new Error('Asset not found: ' + id);
    if (asset.status === 'Retired') throw new Error(id + ' is already retired.');
    if (!Utils.trim(reason)) throw new Error('A reason is required to retire an asset.');

    return Utils.withLock(function () {
      var stampText = 'Retired ' + Utils.fmtDate(new Date()) + ' by ' + user + ': ' + Utils.trim(reason);
      var notes = Utils.trim(asset.notes) ? asset.notes + '\n' + stampText : stampText;

      // Close any open assignment first.
      Assignments.closeOpen(id, user, 'Asset retired', asset.condition);

      var res = patch(id, {
        status: 'Retired',
        assigned_to_emp_id: '',
        assigned_on: '',
        notes: notes
      }, user);
      Audit.log(user, 'Asset', id, 'Update', res.changes, 'UI');
      return decorate(res.row, context());
    });
  }

  return {
    FORM_FIELDS: FORM_FIELDS,
    SERIAL_OPTIONAL: SERIAL_OPTIONAL,
    serialRequired: serialRequired,
    isActive: isActive,
    context: context,
    validate: validate,
    serialIndex: serialIndex,
    list: list,
    get: get,
    decorate: decorate,
    create: create,
    update: update,
    patch: patch,
    retire: retire,
    label: label
  };
})();
