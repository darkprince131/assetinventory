/**
 * Maintenance.gs — repair / service / AMC events.
 * Opening a record puts the asset In Repair; closing restores a status the
 * user picks (Assigned / In Stock / Retired).
 */

var Maintenance = (function () {

  var OPEN_STATUSES = ['Open', 'In Progress'];

  function historyFor(assetId) {
    var key = Utils.norm(assetId);
    return DB.read('Maintenance').filter(function (r) { return Utils.norm(r.asset_id) === key; });
  }

  function openFor(assetId) {
    var rows = historyFor(assetId);
    for (var i = rows.length - 1; i >= 0; i--) {
      if (OPEN_STATUSES.indexOf(Utils.trim(rows[i].status)) >= 0) return rows[i];
    }
    return null;
  }

  /**
   * p: { asset_id, type, reported_on, issue, vendor_id, sent_on, under_warranty,
   *      cost, status }
   */
  function open(p, user) {
    var asset = DB.findById('Assets', p.asset_id);
    if (!asset) throw new Error('Asset not found: ' + p.asset_id);
    if (!Assets.isActive(asset.status)) {
      throw new Error('Cannot log maintenance on a ' + asset.status + ' asset.');
    }
    var cfg = DB.config();
    var type = Utils.trim(p.type);
    if ((cfg.maintenance_type || []).indexOf(type) < 0) {
      throw new Error('Maintenance type "' + type + '" is not valid.');
    }
    if (!Utils.trim(p.issue)) throw new Error('Describe the issue.');
    if (Utils.trim(p.vendor_id) && !DB.findById('Vendors', p.vendor_id)) {
      throw new Error('Vendor not found: ' + p.vendor_id);
    }
    var status = Utils.trim(p.status) || 'Open';
    if ((cfg.maintenance_status || []).indexOf(status) < 0) {
      throw new Error('Maintenance status "' + status + '" is not valid.');
    }

    return Utils.withLock(function () {
      if (openFor(asset.asset_id)) {
        throw new Error('This asset already has an open maintenance record. Close it first.');
      }
      var row = {
        maintenance_id: Utils.nextId('MNT'),
        asset_id: asset.asset_id,
        type: type,
        reported_on: p.reported_on ? Utils.parseDate(p.reported_on) : Utils.today(),
        reported_by: user,
        issue: Utils.trim(p.issue),
        vendor_id: Utils.trim(p.vendor_id),
        sent_on: p.sent_on ? Utils.parseDate(p.sent_on) : '',
        returned_on: '',
        resolution: '',
        cost: p.cost === '' || p.cost === undefined ? '' : Utils.toNumber(p.cost),
        under_warranty: p.under_warranty === true || Utils.norm(p.under_warranty) === 'true',
        status: status,
        created_at: new Date(),
        created_by: user
      };
      DB.append('Maintenance', [row]);

      // Remember what to restore to, so the close dialog can default sensibly.
      PropertiesService.getScriptProperties()
        .setProperty('prev_status:' + asset.asset_id, asset.status);

      var res = Assets.patch(asset.asset_id, { status: 'In Repair' }, user);

      Audit.write(Audit.buildMany(user, [
        { entity: 'Maintenance', entityId: row.maintenance_id, action: 'Create', changes: [] },
        { entity: 'Asset', entityId: asset.asset_id, action: 'Update', changes: res.changes }
      ], 'UI'));

      return { maintenance: Utils.plain(row), asset: Assets.decorate(res.row, Assets.context()) };
    });
  }

  /**
   * p: { maintenance_id, resolution, cost, returned_on, status ('Closed'|'Cancelled'),
   *      restore_status, condition }
   */
  function close(p, user) {
    var rec = DB.findById('Maintenance', p.maintenance_id);
    if (!rec) throw new Error('Maintenance record not found: ' + p.maintenance_id);
    if (OPEN_STATUSES.indexOf(Utils.trim(rec.status)) < 0) {
      throw new Error('That maintenance record is already ' + rec.status + '.');
    }
    var asset = DB.findById('Assets', rec.asset_id);
    if (!asset) throw new Error('Asset not found: ' + rec.asset_id);

    var closeStatus = Utils.trim(p.status) || 'Closed';
    if (['Closed', 'Cancelled'].indexOf(closeStatus) < 0) {
      throw new Error('Close status must be Closed or Cancelled.');
    }
    var restore = Utils.trim(p.restore_status);
    if (['Assigned', 'In Stock', 'Retired'].indexOf(restore) < 0) {
      throw new Error('Pick the status to restore: Assigned, In Stock or Retired.');
    }
    if (restore === 'Assigned' && !Utils.trim(asset.assigned_to_emp_id)) {
      throw new Error('This asset has no assignee — restore it to In Stock instead.');
    }
    if (!Utils.trim(p.resolution) && closeStatus === 'Closed') {
      throw new Error('Record what was done before closing.');
    }

    return Utils.withLock(function () {
      var merged = {};
      DB.SCHEMA.Maintenance.cols.forEach(function (c) { merged[c[0]] = rec[c[0]]; });
      merged.resolution = Utils.trim(p.resolution);
      merged.cost = (p.cost === '' || p.cost === undefined) ? rec.cost : Utils.toNumber(p.cost);
      merged.returned_on = p.returned_on ? Utils.parseDate(p.returned_on) : Utils.today();
      merged.status = closeStatus;
      var mChanges = Audit.diff(rec, merged, ['resolution', 'cost', 'returned_on', 'status']);
      DB.updateRows('Maintenance', [{ _row: rec._row, obj: merged }]);

      var patchFields = { status: restore };
      if (Utils.trim(p.condition)) patchFields.condition = Utils.trim(p.condition);
      if (restore === 'In Stock' || restore === 'Retired') {
        Assignments.closeOpen(asset.asset_id, user, 'Closed by maintenance ' + rec.maintenance_id, patchFields.condition || asset.condition);
        patchFields.assigned_to_emp_id = '';
        patchFields.assigned_on = '';
      }
      var res = Assets.patch(asset.asset_id, patchFields, user);

      Audit.write(Audit.buildMany(user, [
        { entity: 'Maintenance', entityId: rec.maintenance_id, action: 'Update', changes: mChanges },
        { entity: 'Asset', entityId: asset.asset_id, action: 'Update', changes: res.changes }
      ], 'UI'));

      PropertiesService.getScriptProperties().deleteProperty('prev_status:' + asset.asset_id);
      return { maintenance: Utils.plain(merged), asset: Assets.decorate(res.row, Assets.context()) };
    });
  }

  function previousStatus(assetId) {
    return PropertiesService.getScriptProperties().getProperty('prev_status:' + assetId) || 'In Stock';
  }

  return {
    OPEN_STATUSES: OPEN_STATUSES,
    historyFor: historyFor,
    openFor: openFor,
    open: open,
    close: close,
    previousStatus: previousStatus
  };
})();
