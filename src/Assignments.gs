/**
 * Assignments.gs — assign / return / transfer.
 * The Assignments tab is append-only except for closing an open row
 * (setting returned_on + condition_in). Exactly one open row per asset.
 */

var Assignments = (function () {

  /** The open assignment for an asset: matching asset_id with empty returned_on. */
  function openFor(assetId) {
    var rows = DB.read('Assignments');
    var key = Utils.norm(assetId);
    for (var i = rows.length - 1; i >= 0; i--) {
      if (Utils.norm(rows[i].asset_id) === key && Utils.isBlank(rows[i].returned_on)) return rows[i];
    }
    return null;
  }

  function historyFor(assetId) {
    var key = Utils.norm(assetId);
    return DB.read('Assignments').filter(function (r) { return Utils.norm(r.asset_id) === key; });
  }

  /**
   * Closes the open assignment row, if there is one. Internal helper —
   * callers hold the script lock. Does not touch the asset row.
   */
  function closeOpen(assetId, user, remarks, conditionIn, whenDate) {
    var open = openFor(assetId);
    if (!open) return null;
    var merged = {};
    DB.SCHEMA.Assignments.cols.forEach(function (c) { merged[c[0]] = open[c[0]]; });
    merged.returned_on = whenDate || Utils.today();
    merged.condition_in = conditionIn || open.condition_out || '';
    merged.remarks = [Utils.trim(open.remarks), Utils.trim(remarks)].filter(String).join(' | ');
    DB.updateRows('Assignments', [{ _row: open._row, obj: merged }]);
    return merged;
  }

  function requireEmployee(empId) {
    var emp = DB.findById('Employees', empId);
    if (!emp) throw new Error('Employee not found: ' + empId);
    if (Utils.trim(emp.status) === 'Exited') {
      throw new Error(emp.full_name + ' is marked Exited — assign to an active employee.');
    }
    return emp;
  }

  function requireLocation(locId) {
    var loc = DB.findById('Locations', locId);
    if (!loc) throw new Error('Location not found: ' + locId);
    return loc;
  }

  function newRow(p) {
    return {
      assignment_id: Utils.nextId('ASG'),
      asset_id: p.asset_id,
      emp_id: p.emp_id || '',
      from_location_id: p.from_location_id || '',
      to_location_id: p.to_location_id || '',
      action: p.action,
      assigned_on: p.assigned_on || Utils.today(),
      returned_on: p.returned_on || '',
      condition_out: p.condition_out || '',
      condition_in: p.condition_in || '',
      acknowledged: p.acknowledged === true,
      remarks: Utils.trim(p.remarks),
      created_at: new Date(),
      created_by: p.user
    };
  }

  /** p: { asset_id, emp_id, location_id, condition_out, assigned_on, acknowledged, remarks } */
  function assign(p, user) {
    var asset = DB.findById('Assets', p.asset_id);
    if (!asset) throw new Error('Asset not found: ' + p.asset_id);
    if (asset.status !== 'In Stock') {
      throw new Error('Only In Stock assets can be assigned. ' + asset.asset_id + ' is ' + asset.status + '.');
    }
    var emp = requireEmployee(p.emp_id);
    var locId = Utils.trim(p.location_id) || emp.location_id || asset.location_id;
    requireLocation(locId);
    var when = p.assigned_on ? Utils.parseDate(p.assigned_on) : Utils.today();

    return Utils.withLock(function () {
      if (openFor(asset.asset_id)) {
        throw new Error('This asset already has an open assignment. Return it first.');
      }
      var row = newRow({
        asset_id: asset.asset_id, emp_id: emp.emp_id,
        from_location_id: asset.location_id, to_location_id: locId,
        action: 'Assign', assigned_on: when,
        condition_out: p.condition_out || asset.condition,
        acknowledged: p.acknowledged, remarks: p.remarks, user: user
      });
      DB.append('Assignments', [row]);

      var res = Assets.patch(asset.asset_id, {
        status: 'Assigned',
        assigned_to_emp_id: emp.emp_id,
        assigned_on: when,
        location_id: locId,
        condition: p.condition_out || asset.condition
      }, user);

      Audit.write(Audit.buildMany(user, [
        { entity: 'Assignment', entityId: row.assignment_id, action: 'Create', changes: [] },
        { entity: 'Asset', entityId: asset.asset_id, action: 'Update', changes: res.changes }
      ], 'UI'));

      return Assets.decorate(res.row, Assets.context());
    });
  }

  /** p: { asset_id, condition_in, returned_on, location_id, remarks } */
  function returnAsset(p, user) {
    var asset = DB.findById('Assets', p.asset_id);
    if (!asset) throw new Error('Asset not found: ' + p.asset_id);
    if (asset.status !== 'Assigned') {
      throw new Error('Only Assigned assets can be returned. ' + asset.asset_id + ' is ' + asset.status + '.');
    }
    var locId = Utils.trim(p.location_id) || asset.location_id;
    requireLocation(locId);
    var when = p.returned_on ? Utils.parseDate(p.returned_on) : Utils.today();
    var cond = Utils.trim(p.condition_in) || asset.condition;

    return Utils.withLock(function () {
      var closed = closeOpen(asset.asset_id, user, p.remarks, cond, when);
      var row = newRow({
        asset_id: asset.asset_id, emp_id: asset.assigned_to_emp_id,
        from_location_id: asset.location_id, to_location_id: locId,
        action: 'Return', assigned_on: closed ? closed.assigned_on : asset.assigned_on,
        returned_on: when, condition_out: closed ? closed.condition_out : asset.condition,
        condition_in: cond, remarks: p.remarks, user: user
      });
      DB.append('Assignments', [row]);

      var res = Assets.patch(asset.asset_id, {
        status: 'In Stock',
        assigned_to_emp_id: '',
        assigned_on: '',
        location_id: locId,
        condition: cond
      }, user);

      Audit.write(Audit.buildMany(user, [
        { entity: 'Assignment', entityId: row.assignment_id, action: 'Create', changes: [] },
        { entity: 'Asset', entityId: asset.asset_id, action: 'Update', changes: res.changes }
      ], 'UI'));

      return Assets.decorate(res.row, Assets.context());
    });
  }

  /**
   * Moves an asset to a different employee and/or location in one step.
   * Writes a Return + Assign pair. p: { asset_id, emp_id, location_id,
   * condition_in, condition_out, remarks }
   */
  function transfer(p, user) {
    var asset = DB.findById('Assets', p.asset_id);
    if (!asset) throw new Error('Asset not found: ' + p.asset_id);
    if (asset.status !== 'Assigned') {
      throw new Error('Only Assigned assets can be transferred. ' + asset.asset_id + ' is ' + asset.status + '.');
    }
    var emp = requireEmployee(Utils.trim(p.emp_id) || asset.assigned_to_emp_id);
    var locId = Utils.trim(p.location_id) || emp.location_id || asset.location_id;
    requireLocation(locId);
    if (emp.emp_id === asset.assigned_to_emp_id && locId === asset.location_id) {
      throw new Error('Nothing to transfer — same employee and same location.');
    }
    var when = Utils.today();
    var condIn = Utils.trim(p.condition_in) || asset.condition;
    var condOut = Utils.trim(p.condition_out) || condIn;

    return Utils.withLock(function () {
      var closed = closeOpen(asset.asset_id, user, 'Transferred: ' + Utils.trim(p.remarks), condIn, when);

      var retRow = newRow({
        asset_id: asset.asset_id, emp_id: asset.assigned_to_emp_id,
        from_location_id: asset.location_id, to_location_id: locId,
        action: 'Return', assigned_on: closed ? closed.assigned_on : asset.assigned_on,
        returned_on: when, condition_out: closed ? closed.condition_out : asset.condition,
        condition_in: condIn, remarks: 'Leg 1 of transfer. ' + Utils.trim(p.remarks), user: user
      });
      var asgRow = newRow({
        asset_id: asset.asset_id, emp_id: emp.emp_id,
        from_location_id: asset.location_id, to_location_id: locId,
        action: 'Assign', assigned_on: when, condition_out: condOut,
        remarks: 'Leg 2 of transfer. ' + Utils.trim(p.remarks), user: user
      });
      // Mint the second id after the first is materialised.
      asgRow.assignment_id = Utils.nextIds('ASG', 2)[1];
      DB.append('Assignments', [retRow, asgRow]);

      var res = Assets.patch(asset.asset_id, {
        status: 'Assigned',
        assigned_to_emp_id: emp.emp_id,
        assigned_on: when,
        location_id: locId,
        condition: condOut
      }, user);

      Audit.write(Audit.buildMany(user, [
        { entity: 'Assignment', entityId: retRow.assignment_id, action: 'Create', changes: [] },
        { entity: 'Assignment', entityId: asgRow.assignment_id, action: 'Create', changes: [] },
        { entity: 'Asset', entityId: asset.asset_id, action: 'Update', changes: res.changes }
      ], 'UI'));

      return Assets.decorate(res.row, Assets.context());
    });
  }

  return {
    openFor: openFor,
    historyFor: historyFor,
    closeOpen: closeOpen,
    assign: assign,
    returnAsset: returnAsset,
    transfer: transfer
  };
})();
