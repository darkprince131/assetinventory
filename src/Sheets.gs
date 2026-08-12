/**
 * Sheets.gs — the ONLY file that touches SpreadsheetApp.
 * Everything else goes through DB.* . Keep it that way: this is the seam that
 * would be swapped if the data store ever moves off Google Sheets.
 */

var DB = (function () {

  var CACHE_SECONDS = 60;
  var CHUNK_CHARS = 90000;
  var MAX_CHUNKS = 20;
  var VERSION_KEY = 'db_version';

  /**
   * Authoritative schema. Column order here is the column order in the sheet.
   * Types drive coercion on read, revival after caching, and formatting on write.
   */
  var SCHEMA = {
    Assets: {
      id: 'asset_id',
      cols: [
        ['asset_id', 'text'], ['asset_tag', 'text'], ['category', 'text'], ['subcategory', 'text'],
        ['make', 'text'], ['model', 'text'], ['serial_number', 'text'], ['status', 'text'],
        ['condition', 'text'], ['ownership', 'text'], ['rental_vendor_id', 'text'],
        ['rental_start', 'date'], ['rental_end', 'date'], ['assigned_to_emp_id', 'text'],
        ['assigned_on', 'date'], ['location_id', 'text'], ['purchase_date', 'date'],
        ['purchase_cost', 'number'], ['currency', 'text'], ['po_number', 'text'],
        ['invoice_number', 'text'], ['vendor_id', 'text'], ['warranty_start', 'date'],
        ['warranty_end', 'date'], ['amc_vendor_id', 'text'], ['amc_start', 'date'],
        ['amc_end', 'date'], ['specs', 'text'], ['notes', 'text'],
        ['created_at', 'datetime'], ['created_by', 'text'], ['updated_at', 'datetime'], ['updated_by', 'text']
      ],
      enums: { category: 'category', status: 'status', condition: 'condition', ownership: 'ownership' }
    },
    Assignments: {
      id: 'assignment_id',
      cols: [
        ['assignment_id', 'text'], ['asset_id', 'text'], ['emp_id', 'text'],
        ['from_location_id', 'text'], ['to_location_id', 'text'], ['action', 'text'],
        ['assigned_on', 'date'], ['returned_on', 'date'], ['condition_out', 'text'],
        ['condition_in', 'text'], ['acknowledged', 'bool'], ['remarks', 'text'],
        ['created_at', 'datetime'], ['created_by', 'text']
      ],
      enums: { condition_out: 'condition', condition_in: 'condition' }
    },
    Maintenance: {
      id: 'maintenance_id',
      cols: [
        ['maintenance_id', 'text'], ['asset_id', 'text'], ['type', 'text'],
        ['reported_on', 'date'], ['reported_by', 'text'], ['issue', 'text'],
        ['vendor_id', 'text'], ['sent_on', 'date'], ['returned_on', 'date'],
        ['resolution', 'text'], ['cost', 'number'], ['under_warranty', 'bool'],
        ['status', 'text'], ['created_at', 'datetime'], ['created_by', 'text']
      ],
      enums: { type: 'maintenance_type', status: 'maintenance_status' }
    },
    Employees: {
      id: 'emp_id',
      cols: [
        ['emp_id', 'text'], ['full_name', 'text'], ['email', 'text'], ['department', 'text'],
        ['designation', 'text'], ['location_id', 'text'], ['manager_email', 'text'],
        ['status', 'text'], ['date_joined', 'date'], ['date_exited', 'date']
      ],
      enums: { department: 'department' }
    },
    Locations: {
      id: 'location_id',
      cols: [
        ['location_id', 'text'], ['name', 'text'], ['type', 'text'], ['city', 'text'],
        ['state', 'text'], ['country', 'text'], ['address', 'text'], ['active', 'bool']
      ],
      enums: { type: 'location_type' }
    },
    Vendors: {
      id: 'vendor_id',
      cols: [
        ['vendor_id', 'text'], ['name', 'text'], ['type', 'text'], ['contact_person', 'text'],
        ['email', 'text'], ['phone', 'text'], ['gstin', 'text'], ['address', 'text'],
        ['notes', 'text'], ['active', 'bool']
      ],
      enums: {}
    },
    Users: {
      id: 'email',
      cols: [['email', 'text'], ['name', 'text'], ['role', 'text'], ['active', 'bool']],
      enums: {}
    },
    AuditLog: {
      id: 'log_id',
      cols: [
        ['log_id', 'text'], ['timestamp', 'datetime'], ['user_email', 'text'], ['entity', 'text'],
        ['entity_id', 'text'], ['action', 'text'], ['field', 'text'], ['old_value', 'text'],
        ['new_value', 'text'], ['source', 'text']
      ],
      enums: {}
    },
    Config: {
      id: null,
      cols: [['key', 'text'], ['value', 'text']],
      enums: {}
    }
  };

  var TABS = ['Assets', 'Assignments', 'Maintenance', 'Employees', 'Locations', 'Vendors', 'Users', 'AuditLog', 'Config'];

  var CONFIG_SEED = {
    category: ['Laptop', 'Desktop', 'Mobile', 'Tablet', 'Monitor', 'Headset', 'Accessory', 'Printer',
      'Scanner', 'Router', 'Switch', 'Firewall', 'Access Point', 'Server', 'Storage', 'UPS',
      'Projector', 'Furniture', 'Office Equipment', 'Consumable', 'Other'],
    status: ['In Stock', 'Assigned', 'In Repair', 'Retired', 'Lost', 'Returned to Vendor'],
    condition: ['New', 'Good', 'Fair', 'Damaged'],
    ownership: ['Owned', 'Rented', 'Leased'],
    maintenance_type: ['Repair', 'Preventive', 'Upgrade', 'Replacement', 'AMC Service'],
    maintenance_status: ['Open', 'In Progress', 'Closed', 'Cancelled'],
    location_type: ['Office', 'Warehouse', 'Remote', 'Client Site'],
    vendor_type: ['Supplier', 'Rental', 'AMC', 'Service'],
    department: ['Engineering', 'Sales', 'Marketing', 'Support', 'Finance', 'HR', 'IT', 'Operations', 'Legal', 'Admin'],
    currency: ['INR', 'USD', 'EUR', 'GBP', 'SGD', 'AED']
  };

  // ---------------------------------------------------------------- internals

  function ss() {
    var s = SpreadsheetApp.getActiveSpreadsheet();
    if (!s) throw new Error('No bound spreadsheet. Open the script from the Sheet it belongs to.');
    return s;
  }

  function sheet(tab) {
    var sh = ss().getSheetByName(tab);
    if (!sh) throw new Error('Missing tab "' + tab + '". Run setupSpreadsheet() once from the Apps Script editor.');
    return sh;
  }

  function headers(tab) {
    return SCHEMA[tab].cols.map(function (c) { return c[0]; });
  }

  function typeOf(tab, col) {
    var cols = SCHEMA[tab].cols;
    for (var i = 0; i < cols.length; i++) if (cols[i][0] === col) return cols[i][1];
    return 'text';
  }

  function props() { return PropertiesService.getScriptProperties(); }

  function version() {
    var v = props().getProperty(VERSION_KEY);
    if (!v) { v = '1'; props().setProperty(VERSION_KEY, v); }
    return v;
  }

  function bumpVersion() {
    var v = String(Number(version() || 0) + 1);
    props().setProperty(VERSION_KEY, v);
    return v;
  }

  function cacheKey(tab) { return 'tbl:' + tab + ':v' + version(); }

  function cacheGet(tab) {
    try {
      var c = CacheService.getScriptCache();
      var key = cacheKey(tab);
      var head = c.get(key);
      if (!head) return null;
      var meta = JSON.parse(head);
      var parts = [];
      for (var i = 0; i < meta.chunks; i++) {
        var part = c.get(key + ':' + i);
        if (part === null) return null; // partial eviction — treat as a miss
        parts.push(part);
      }
      return revive(tab, JSON.parse(parts.join('')));
    } catch (e) {
      return null;
    }
  }

  function cachePut(tab, rows) {
    try {
      var json = JSON.stringify(rows);
      var chunks = Math.ceil(json.length / CHUNK_CHARS);
      if (chunks > MAX_CHUNKS) return; // too big to cache; read straight through
      var c = CacheService.getScriptCache();
      var key = cacheKey(tab);
      var map = { };
      map[key] = JSON.stringify({ chunks: chunks });
      for (var i = 0; i < chunks; i++) {
        map[key + ':' + i] = json.substr(i * CHUNK_CHARS, CHUNK_CHARS);
      }
      c.putAll(map, CACHE_SECONDS);
    } catch (e) {
      // caching is best-effort only
    }
  }

  /** Dates come back from JSON as ISO strings — turn them into Dates again. */
  function revive(tab, rows) {
    var cols = SCHEMA[tab].cols;
    for (var i = 0; i < rows.length; i++) {
      for (var j = 0; j < cols.length; j++) {
        var name = cols[j][0], type = cols[j][1];
        if ((type === 'date' || type === 'datetime') && typeof rows[i][name] === 'string' && rows[i][name]) {
          rows[i][name] = new Date(rows[i][name]);
        }
      }
    }
    return rows;
  }

  function coerce(type, v) {
    if (v === null || v === undefined || v === '') return '';
    if (type === 'date' || type === 'datetime') {
      if (v instanceof Date) return v;
      try { return Utils.parseDate(v); } catch (e) { return ''; }
    }
    if (type === 'number') {
      if (typeof v === 'number') return v;
      var n = Number(String(v).replace(/,/g, ''));
      return isNaN(n) ? '' : n;
    }
    if (type === 'bool') {
      if (v === true || v === false) return v;
      var s = String(v).trim().toLowerCase();
      if (s === 'true' || s === 'yes' || s === '1') return true;
      if (s === 'false' || s === 'no' || s === '0') return false;
      return '';
    }
    return typeof v === 'string' ? v.trim() : v;
  }

  // -------------------------------------------------------------------- reads

  /**
   * Whole tab as array-of-objects keyed by header. Each row carries a hidden
   * `_row` (1-based sheet row number) used for targeted updates.
   */
  function read(tab) {
    if (!SCHEMA[tab]) throw new Error('Unknown tab: ' + tab);
    var cached = cacheGet(tab);
    if (cached) return cached;

    var values = sheet(tab).getDataRange().getValues();
    var rows = [];
    if (values.length < 2) { cachePut(tab, rows); return rows; }

    var head = values[0].map(function (h) { return String(h).trim(); });
    var cols = SCHEMA[tab].cols;
    for (var r = 1; r < values.length; r++) {
      var raw = values[r];
      if (raw.join('') === '') continue;
      var obj = { _row: r + 1 };
      for (var c = 0; c < cols.length; c++) {
        var name = cols[c][0];
        var idx = head.indexOf(name);
        obj[name] = idx < 0 ? '' : coerce(cols[c][1], raw[idx]);
      }
      rows.push(obj);
    }
    cachePut(tab, rows);
    return rows;
  }

  function findBy(tab, col, value) {
    var rows = read(tab);
    var key = Utils.norm(value);
    for (var i = 0; i < rows.length; i++) {
      if (Utils.norm(rows[i][col]) === key) return rows[i];
    }
    return null;
  }

  function findById(tab, id) {
    return findBy(tab, SCHEMA[tab].id, id);
  }

  /** Config as { key: [values...] }. */
  function config() {
    var rows = read('Config');
    var out = {};
    for (var i = 0; i < rows.length; i++) {
      var k = Utils.trim(rows[i].key);
      if (!k) continue;
      if (!out[k]) out[k] = [];
      var v = Utils.trim(rows[i].value);
      if (v) out[k].push(v);
    }
    return out;
  }

  // ------------------------------------------------------------------- writes

  function objToRow(tab, obj) {
    return SCHEMA[tab].cols.map(function (c) {
      var v = obj[c[0]];
      if (v === null || v === undefined) return '';
      if ((c[1] === 'date' || c[1] === 'datetime') && !(v instanceof Date) && v !== '') {
        try { v = Utils.parseDate(v); } catch (e) { v = ''; }
      }
      return v === null ? '' : v;
    });
  }

  /** Appends objects in one setValues() call. Returns the objects unchanged. */
  function append(tab, objs) {
    if (!objs || !objs.length) return [];
    var sh = sheet(tab);
    var rows = objs.map(function (o) { return objToRow(tab, o); });
    var start = sh.getLastRow() + 1;
    sh.getRange(start, 1, rows.length, SCHEMA[tab].cols.length).setValues(rows);
    bumpVersion();
    return objs;
  }

  /** Replaces whole rows. updates = [{ _row: n, obj: {...} }] */
  function updateRows(tab, updates) {
    if (!updates || !updates.length) return 0;
    var sh = sheet(tab);
    var width = SCHEMA[tab].cols.length;
    for (var i = 0; i < updates.length; i++) {
      sh.getRange(updates[i]._row, 1, 1, width).setValues([objToRow(tab, updates[i].obj)]);
    }
    bumpVersion();
    return updates.length;
  }

  function updateById(tab, id, obj) {
    var existing = findById(tab, id);
    if (!existing) throw new Error(tab + ' record not found: ' + id);
    var merged = {};
    SCHEMA[tab].cols.forEach(function (c) {
      merged[c[0]] = Object.prototype.hasOwnProperty.call(obj, c[0]) ? obj[c[0]] : existing[c[0]];
    });
    updateRows(tab, [{ _row: existing._row, obj: merged }]);
    return merged;
  }

  /** Writes a report to a fresh tab in the bound sheet. */
  function writeTab(name, headerRow, dataRows) {
    var s = ss();
    var existing = s.getSheetByName(name);
    if (existing) s.deleteSheet(existing);
    var sh = s.insertSheet(name);
    var all = [headerRow].concat(dataRows);
    if (all.length) sh.getRange(1, 1, all.length, headerRow.length).setValues(all);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, headerRow.length).setFontWeight('bold');
    sh.autoResizeColumns(1, headerRow.length);
    return s.getUrl() + '#gid=' + sh.getSheetId();
  }

  function spreadsheetUrl() {
    return ss().getUrl();
  }

  return {
    SCHEMA: SCHEMA,
    TABS: TABS,
    CONFIG_SEED: CONFIG_SEED,
    headers: headers,
    typeOf: typeOf,
    read: read,
    findBy: findBy,
    findById: findById,
    config: config,
    append: append,
    updateRows: updateRows,
    updateById: updateById,
    writeTab: writeTab,
    bumpVersion: bumpVersion,
    spreadsheetUrl: spreadsheetUrl,
    _sheet: sheet,
    _ss: ss
  };
})();


/**
 * One-time (idempotent) setup. Run from the Apps Script editor.
 * Creates the nine tabs, freezes headers, seeds Config, applies enum validation,
 * and makes whoever runs it the first Admin.
 */
function setupSpreadsheet() {
  var s = SpreadsheetApp.getActiveSpreadsheet();

  DB.TABS.forEach(function (tab) {
    var sh = s.getSheetByName(tab);
    if (!sh) sh = s.insertSheet(tab);
    var head = DB.headers(tab);
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
    sh.setFrozenRows(1);
    if (sh.getMaxColumns() > head.length) {
      sh.deleteColumns(head.length + 1, sh.getMaxColumns() - head.length);
    }
  });

  // Seed Config only if empty, so re-running never clobbers customised lists.
  var cfgSheet = s.getSheetByName('Config');
  if (cfgSheet.getLastRow() < 2) {
    var rows = [];
    Object.keys(DB.CONFIG_SEED).forEach(function (key) {
      DB.CONFIG_SEED[key].forEach(function (v) { rows.push([key, v]); });
    });
    cfgSheet.getRange(2, 1, rows.length, 2).setValues(rows);
  }

  DB.bumpVersion();
  applyValidation();

  // Bootstrap access: the person running setup becomes Admin.
  var email = Session.getEffectiveUser().getEmail();
  if (email && !DB.findBy('Users', 'email', email)) {
    DB.append('Users', [{ email: email, name: email.split('@')[0], role: 'Admin', active: true }]);
  }

  // Default column widths — dense, readable.
  var assets = s.getSheetByName('Assets');
  assets.setColumnWidths(1, DB.headers('Assets').length, 110);

  var first = s.getSheets()[0];
  if (first.getName() === 'Sheet1' && first.getLastRow() === 0) s.deleteSheet(first);

  return 'Setup complete. ' + DB.TABS.length + ' tabs ready. Admin: ' + email;
}

/** Re-applies dropdown validation on enum columns from Config. Safe to re-run. */
function applyValidation() {
  var s = SpreadsheetApp.getActiveSpreadsheet();
  var cfg = DB.config();
  DB.TABS.forEach(function (tab) {
    var spec = DB.SCHEMA[tab];
    if (!spec.enums) return;
    var sh = s.getSheetByName(tab);
    if (!sh) return;
    var head = DB.headers(tab);
    Object.keys(spec.enums).forEach(function (col) {
      var list = cfg[spec.enums[col]] || [];
      if (!list.length) return;
      var idx = head.indexOf(col) + 1;
      if (idx < 1) return;
      var rule = SpreadsheetApp.newDataValidation()
        .requireValueInList(list, true).setAllowInvalid(true).build();
      sh.getRange(2, idx, Math.max(sh.getMaxRows() - 1, 1), 1).setDataValidation(rule);
    });
  });
  return 'Validation applied.';
}

/**
 * Generates ~80 sample assets plus supporting masters so the app can be demoed
 * before real data lands. Refuses to run if Assets already has rows.
 */
function seedDemoData() {
  if (DB.read('Assets').length) {
    throw new Error('Assets tab is not empty — refusing to seed demo data over real records.');
  }
  var now = new Date();
  var me = Session.getEffectiveUser().getEmail() || 'setup@example.com';
  var domain = (me.split('@')[1] || 'example.com');

  var locations = [
    ['LOC-001', 'Bengaluru HQ — 4th Floor', 'Office', 'Bengaluru', 'Karnataka', 'India'],
    ['LOC-002', 'Bengaluru HQ — 5th Floor', 'Office', 'Bengaluru', 'Karnataka', 'India'],
    ['LOC-003', 'Mumbai Sales Office', 'Office', 'Mumbai', 'Maharashtra', 'India'],
    ['LOC-004', 'Central Warehouse', 'Warehouse', 'Bengaluru', 'Karnataka', 'India'],
    ['LOC-005', 'Remote — India', 'Remote', '', '', 'India']
  ].map(function (l) {
    return { location_id: l[0], name: l[1], type: l[2], city: l[3], state: l[4], country: l[5], address: '', active: true };
  });
  DB.append('Locations', locations);

  var vendors = [
    ['VEN-001', 'Redington India', 'Supplier', 'Supply desk'],
    ['VEN-002', 'Ingram Micro', 'Supplier', 'Accounts'],
    ['VEN-003', 'Rentomojo Business', 'Rental', 'Leasing desk'],
    ['VEN-004', 'CompuCare Services', 'AMC, Service', 'Service manager'],
    ['VEN-005', 'Dell Enterprise', 'Supplier, AMC', 'Enterprise sales']
  ].map(function (v) {
    return {
      vendor_id: v[0], name: v[1], type: v[2], contact_person: v[3],
      email: 'contact@' + v[1].toLowerCase().replace(/[^a-z]/g, '') + '.com',
      phone: '+91 80 4000 0000', gstin: '29AAACR0000A1Z' + v[0].slice(-1),
      address: 'Bengaluru, India', notes: '', active: true
    };
  });
  DB.append('Vendors', vendors);

  var firstNames = ['Aarav', 'Diya', 'Rohan', 'Meera', 'Karthik', 'Ananya', 'Vikram', 'Sneha', 'Arjun', 'Priya',
    'Rahul', 'Nisha', 'Sanjay', 'Kavya', 'Imran', 'Tara', 'Nikhil', 'Divya', 'Farah', 'Manish'];
  var lastNames = ['Sharma', 'Iyer', 'Reddy', 'Nair', 'Gupta', 'Menon', 'Rao', 'Desai', 'Khan', 'Bose'];
  var depts = DB.CONFIG_SEED.department;
  var employees = [];
  for (var i = 0; i < 20; i++) {
    var fn = firstNames[i], ln = lastNames[i % lastNames.length];
    var exited = (i % 10 === 7);
    employees.push({
      emp_id: 'EMP-' + Utils.pad(i + 1, 4),
      full_name: fn + ' ' + ln,
      email: (fn + '.' + ln).toLowerCase() + '@' + domain,
      department: depts[i % depts.length],
      designation: ['Engineer', 'Senior Engineer', 'Manager', 'Analyst', 'Executive'][i % 5],
      location_id: locations[i % locations.length].location_id,
      manager_email: 'manager@' + domain,
      status: exited ? 'Exited' : 'Active',
      date_joined: new Date(2021 + (i % 4), i % 12, 1 + (i % 27)),
      date_exited: exited ? new Date(now.getFullYear(), now.getMonth() - 1, 15) : ''
    });
  }
  DB.append('Employees', employees);

  var models = [
    ['Laptop', 'Ultrabook', 'Dell', 'Latitude 5440', 'i7-1355U / 16GB / 512GB NVMe', 92000],
    ['Laptop', 'Ultrabook', 'Lenovo', 'ThinkPad T14', 'i5-1345U / 16GB / 512GB NVMe', 84000],
    ['Laptop', 'Notebook', 'Apple', 'MacBook Air M2', 'M2 / 16GB / 512GB', 134000],
    ['Desktop', 'Tower', 'HP', 'ProDesk 400 G9', 'i5-12500 / 16GB / 512GB', 56000],
    ['Monitor', '24-inch IPS', 'Dell', 'P2422H', '24" 1920x1080 IPS', 13500],
    ['Monitor', '27-inch IPS', 'LG', '27UP550', '27" 3840x2160 IPS', 31000],
    ['Mobile', 'Smartphone', 'Samsung', 'Galaxy A54', '8GB / 128GB', 32000],
    ['Headset', 'USB Headset', 'Jabra', 'Evolve2 40', 'Wired USB-C', 9500],
    ['Router', 'Edge Router', 'Cisco', 'ISR 1111', 'Dual WAN', 78000],
    ['Switch', 'Access Switch', 'Cisco', 'CBS350-24T', '24-port GbE', 62000],
    ['Firewall', 'NGFW', 'Fortinet', 'FortiGate 60F', '10x GE RJ45', 96000],
    ['Access Point', 'Wi-Fi 6 AP', 'Ubiquiti', 'U6-Pro', 'Wi-Fi 6 4x4', 21000],
    ['Server', 'Rack Server', 'Dell', 'PowerEdge R650', 'Xeon Silver / 128GB', 480000],
    ['UPS', 'Line Interactive', 'APC', 'Smart-UPS 3000', '3kVA', 74000],
    ['Printer', 'Laser MFP', 'HP', 'LaserJet M428fdw', 'Mono MFP', 34000],
    ['Furniture', 'Ergonomic chair', 'Featherlite', 'Optima', 'Mesh back', 12000],
    ['Office Equipment', 'Shredder', 'Kores', 'Easy Shred', 'Cross-cut', 8500],
    ['Tablet', 'Tablet', 'Apple', 'iPad 10th gen', '64GB Wi-Fi', 39000],
    ['Projector', 'Meeting room', 'Epson', 'EB-X51', '3800 lumens', 42000],
    ['Storage', 'NAS', 'Synology', 'DS1522+', '5-bay', 118000]
  ];
  var statuses = ['Assigned', 'Assigned', 'Assigned', 'In Stock', 'In Stock', 'In Repair', 'Retired'];
  var assets = [], assignments = [], maint = [];
  var asgSeq = 1, mntSeq = 1;

  for (var n = 0; n < 84; n++) {
    var m = models[n % models.length];
    var status = statuses[n % statuses.length];
    var noSerial = ['Furniture', 'Office Equipment', 'Consumable'].indexOf(m[0]) >= 0;
    var purchase = new Date(now.getFullYear() - (n % 4), (n * 5) % 12, 1 + (n % 27));
    var warrantyEnd = new Date(purchase.getFullYear() + 3, purchase.getMonth(), purchase.getDate());
    if (n % 9 === 0) warrantyEnd = new Date(now.getTime() + (10 + (n % 20)) * 86400000); // expiring soon
    var ownership = (n % 11 === 0) ? 'Rented' : (n % 17 === 0 ? 'Leased' : 'Owned');
    var emp = employees[n % employees.length];
    var assigned = status === 'Assigned';
    var id = 'AST-' + Utils.pad(n + 1, 5);
    var loc = assigned ? emp.location_id : (status === 'In Stock' ? 'LOC-004' : locations[n % locations.length].location_id);

    var a = {
      asset_id: id,
      asset_tag: id,
      category: m[0], subcategory: m[1], make: m[2], model: m[3],
      serial_number: noSerial ? '' : (m[2].slice(0, 2).toUpperCase() + Utils.pad(1000 + n * 7, 6) + (n % 10)),
      status: status,
      condition: ['New', 'Good', 'Good', 'Fair', 'Damaged'][n % 5],
      ownership: ownership,
      rental_vendor_id: ownership === 'Owned' ? '' : 'VEN-003',
      rental_start: ownership === 'Owned' ? '' : purchase,
      rental_end: ownership === 'Owned' ? '' : new Date(now.getTime() + ((n % 40) - 5) * 86400000),
      assigned_to_emp_id: assigned ? emp.emp_id : '',
      assigned_on: assigned ? new Date(purchase.getTime() + 86400000 * 30) : '',
      location_id: loc,
      purchase_date: purchase,
      purchase_cost: m[5],
      currency: 'INR',
      po_number: 'PO-' + (2400 + n),
      invoice_number: 'INV-' + (9100 + n),
      vendor_id: vendors[n % 2].vendor_id,
      warranty_start: purchase,
      warranty_end: warrantyEnd,
      amc_vendor_id: (n % 6 === 0) ? 'VEN-004' : '',
      amc_start: (n % 6 === 0) ? purchase : '',
      amc_end: (n % 6 === 0) ? new Date(now.getTime() + ((n % 50) - 10) * 86400000) : '',
      specs: m[4],
      notes: status === 'Retired' ? 'Retired: end of life' : '',
      created_at: now, created_by: me, updated_at: now, updated_by: me
    };
    assets.push(a);

    if (assigned) {
      assignments.push({
        assignment_id: 'ASG-' + Utils.pad(asgSeq++, 5),
        asset_id: id, emp_id: emp.emp_id,
        from_location_id: 'LOC-004', to_location_id: loc,
        action: 'Assign', assigned_on: a.assigned_on, returned_on: '',
        condition_out: a.condition, condition_in: '', acknowledged: (n % 3 !== 0),
        remarks: 'Demo data', created_at: now, created_by: me
      });
    }
    if (status === 'In Repair') {
      maint.push({
        maintenance_id: 'MNT-' + Utils.pad(mntSeq++, 5),
        asset_id: id, type: 'Repair',
        reported_on: new Date(now.getTime() - (n % 30) * 86400000),
        reported_by: me, issue: 'Device not powering on', vendor_id: 'VEN-004',
        sent_on: new Date(now.getTime() - (n % 25) * 86400000), returned_on: '',
        resolution: '', cost: '', under_warranty: (n % 2 === 0), status: 'In Progress',
        created_at: now, created_by: me
      });
    }
  }

  DB.append('Assets', assets);
  DB.append('Assignments', assignments);
  DB.append('Maintenance', maint);

  return 'Seeded ' + assets.length + ' assets, ' + employees.length + ' employees, ' +
    locations.length + ' locations, ' + vendors.length + ' vendors.';
}
