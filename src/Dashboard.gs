/**
 * Dashboard.gs — metric aggregation. Pure reads, no writes.
 */

var Dashboard = (function () {

  function build() {
    var ctx = Assets.context();
    var all = DB.read('Assets');
    var live = all.filter(function (a) { return a.status !== 'Retired'; });
    var fy = Utils.fyStart();

    var cards = {
      total: live.length,
      assigned: count(live, 'status', 'Assigned'),
      inStock: count(live, 'status', 'In Stock'),
      inRepair: count(live, 'status', 'In Repair'),
      rented: live.filter(function (a) { return a.ownership === 'Rented' || a.ownership === 'Leased'; }).length,
      retiredFy: all.filter(function (a) {
        return a.status === 'Retired' && a.updated_at instanceof Date && a.updated_at >= fy;
      }).length
    };

    var value = { total: 0, owned: 0, rented: 0 };
    live.forEach(function (a) {
      var c = typeof a.purchase_cost === 'number' ? a.purchase_cost : 0;
      value.total += c;
      if (a.ownership === 'Owned') value.owned += c; else value.rented += c;
    });

    return Utils.plain({
      cards: cards,
      value: value,
      attention: attention(live, ctx),
      byCategory: byCategory(live),
      byLocation: byLocation(live, ctx),
      recent: recent(),
      generatedAt: new Date()
    });
  }

  function count(rows, field, value) {
    return rows.filter(function (r) { return r[field] === value; }).length;
  }

  /** One list, most urgent first. Each item: { severity, kind, asset_id, text, days } */
  function attention(live, ctx) {
    var items = [];

    live.forEach(function (a) {
      var name = a.asset_id + ' · ' + [a.make, a.model].filter(String).join(' ');

      var w = a.warranty_end ? Utils.daysUntil(a.warranty_end) : null;
      if (w !== null && w >= 0 && w <= 90) {
        items.push(item(w <= 30 ? 1 : (w <= 60 ? 2 : 3), 'Warranty', a.asset_id,
          name + ' — warranty ends ' + Utils.fmtDate(a.warranty_end) + ' (' + w + 'd)', w));
      }
      var m = a.amc_end ? Utils.daysUntil(a.amc_end) : null;
      if (m !== null && m >= 0 && m <= 30) {
        items.push(item(1, 'AMC', a.asset_id, name + ' — AMC ends ' + Utils.fmtDate(a.amc_end) + ' (' + m + 'd)', m));
      }
      var r = (a.ownership !== 'Owned' && a.rental_end) ? Utils.daysUntil(a.rental_end) : null;
      if (r !== null && r <= 30) {
        items.push(item(r < 0 ? 0 : 1, 'Rental', a.asset_id,
          name + ' — ' + a.ownership.toLowerCase() + ' ends ' + Utils.fmtDate(a.rental_end) +
          (r < 0 ? ' (' + Math.abs(r) + 'd overdue)' : ' (' + r + 'd)'), r));
      }
      if (a.assigned_to_emp_id) {
        var emp = ctx.empById[Utils.norm(a.assigned_to_emp_id)];
        if (emp && Utils.trim(emp.status) === 'Exited') {
          items.push(item(0, 'Exited employee', a.asset_id,
            name + ' — still assigned to ' + emp.full_name + ' (exited ' + Utils.fmtDate(emp.date_exited) + ')', -1));
        }
      }
    });

    // Out for repair more than 14 days
    DB.read('Maintenance').forEach(function (m) {
      if (Maintenance.OPEN_STATUSES.indexOf(Utils.trim(m.status)) < 0) return;
      var since = m.sent_on || m.reported_on;
      if (!(since instanceof Date)) return;
      var days = -Utils.daysUntil(since);
      if (days > 14) {
        items.push(item(0, 'Long repair', m.asset_id,
          m.asset_id + ' — out for repair ' + days + ' days (' + m.maintenance_id + ')', -days));
      }
    });

    items.sort(function (a, b) {
      if (a.severity !== b.severity) return a.severity - b.severity;
      return (a.days === null ? 0 : a.days) - (b.days === null ? 0 : b.days);
    });
    return items.slice(0, 60);
  }

  function item(severity, kind, assetId, text, days) {
    return { severity: severity, kind: kind, asset_id: assetId, text: text, days: days };
  }

  function byCategory(live) {
    var map = {};
    live.forEach(function (a) {
      var k = Utils.trim(a.category) || '(blank)';
      map[k] = (map[k] || 0) + 1;
    });
    var total = live.length || 1;
    return Object.keys(map).map(function (k) {
      return { name: k, count: map[k], pct: Math.round((map[k] / total) * 1000) / 10 };
    }).sort(function (a, b) { return b.count - a.count; });
  }

  function byLocation(live, ctx) {
    var map = {};
    live.forEach(function (a) {
      var id = Utils.trim(a.location_id) || '(none)';
      if (!map[id]) map[id] = { location_id: id, name: '', total: 0, assigned: 0, inStock: 0, inRepair: 0 };
      map[id].total++;
      if (a.status === 'Assigned') map[id].assigned++;
      else if (a.status === 'In Stock') map[id].inStock++;
      else if (a.status === 'In Repair') map[id].inRepair++;
    });
    return Object.keys(map).map(function (id) {
      var loc = ctx.locById[Utils.norm(id)];
      map[id].name = loc ? loc.name : id;
      return map[id];
    }).sort(function (a, b) { return b.total - a.total; });
  }

  function recent() {
    var rows = DB.read('AuditLog');
    return rows.slice(-15).reverse().map(function (r) {
      var what = r.field && r.field !== '*' ? (r.field + ': ' + trunc(r.old_value) + ' → ' + trunc(r.new_value)) : '';
      return {
        timestamp: r.timestamp,
        text: r.action + ' ' + r.entity + ' ' + r.entity_id + (what ? ' — ' + what : '') +
          ' · ' + (r.user_email || '') + (r.source === 'Bulk Import' ? ' (import)' : ''),
        entity: r.entity,
        entity_id: r.entity_id
      };
    });
  }

  function trunc(v) {
    var s = String(v === null || v === undefined ? '' : v);
    return s.length > 40 ? s.slice(0, 40) + '…' : (s || '(blank)');
  }

  return { build: build };
})();
