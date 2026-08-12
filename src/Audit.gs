/**
 * Audit.gs — append-only change log. One row per changed field on an update,
 * a single row with field '*' on a create.
 */

var Audit = (function () {

  function stamp(v) {
    if (v === null || v === undefined || v === '') return '';
    if (v instanceof Date) return Utils.isoDate(v);
    return String(v);
  }

  /** Builds log row objects without writing them — caller batches the append. */
  function build(user, entity, entityId, action, changes, source) {
    var ids = Utils.nextIds('LOG', Math.max(changes.length, 1));
    var now = new Date();
    var rows = [];
    var list = changes.length ? changes : [{ field: '*', old: '', now: '' }];
    for (var i = 0; i < list.length; i++) {
      rows.push({
        log_id: ids[i],
        timestamp: now,
        user_email: user,
        entity: entity,
        entity_id: entityId,
        action: action,
        field: list[i].field,
        old_value: stamp(list[i].old),
        new_value: stamp(list[i].now),
        source: source || 'UI'
      });
    }
    return rows;
  }

  /** Writes log rows immediately. Prefer buildMany + writeMany for bulk paths. */
  function log(user, entity, entityId, action, changes, source) {
    var rows = build(user, entity, entityId, action, changes || [], source);
    DB.append('AuditLog', rows);
    return rows.length;
  }

  /**
   * Builds rows for many entities at once, minting a contiguous id block so a
   * bulk import writes the log in a single append.
   */
  function buildMany(user, items, source) {
    var total = 0;
    items.forEach(function (it) { total += Math.max((it.changes || []).length, 1); });
    if (!total) return [];
    var ids = Utils.nextIds('LOG', total);
    var now = new Date();
    var rows = [], p = 0;
    items.forEach(function (it) {
      var list = (it.changes && it.changes.length) ? it.changes : [{ field: '*', old: '', now: '' }];
      list.forEach(function (ch) {
        rows.push({
          log_id: ids[p++],
          timestamp: now,
          user_email: user,
          entity: it.entity,
          entity_id: it.entityId,
          action: it.action,
          field: ch.field,
          old_value: stamp(ch.old),
          new_value: stamp(ch.now),
          source: source || 'UI'
        });
      });
    });
    return rows;
  }

  function write(rows) {
    if (rows && rows.length) DB.append('AuditLog', rows);
    return rows ? rows.length : 0;
  }

  /** Field-level diff between two records, restricted to `fields`. */
  function diff(before, after, fields) {
    var out = [];
    fields.forEach(function (f) {
      var a = before ? before[f] : '';
      var b = after[f];
      if (stamp(a) !== stamp(b)) out.push({ field: f, old: a, now: b });
    });
    return out;
  }

  return { log: log, build: build, buildMany: buildMany, write: write, diff: diff, stamp: stamp };
})();
