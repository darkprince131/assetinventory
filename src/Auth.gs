/**
 * Auth.gs — role lookup and permission guards.
 * Every server entry point starts with Auth.require('Viewer'|'Editor'|'Admin').
 */

var Auth = (function () {

  var RANK = { Viewer: 1, Editor: 2, Admin: 3 };

  function activeEmail() {
    var e = Session.getActiveUser().getEmail();
    if (!e) e = Session.getEffectiveUser().getEmail();
    return e || '';
  }

  /** Returns { email, name, role, active, hasAccess }. Never throws. */
  function currentUser() {
    var email = activeEmail();
    if (!email) return { email: '', name: '', role: '', active: false, hasAccess: false };

    var users = DB.read('Users');
    // Bootstrap: an empty Users tab means the first person in is the Admin.
    if (!users.length) {
      return { email: email, name: email.split('@')[0], role: 'Admin', active: true, hasAccess: true, bootstrap: true };
    }

    var row = null, key = Utils.norm(email);
    for (var i = 0; i < users.length; i++) {
      if (Utils.norm(users[i].email) === key) { row = users[i]; break; }
    }
    if (!row) return { email: email, name: '', role: '', active: false, hasAccess: false };

    var active = row.active === true || Utils.norm(row.active) === 'true';
    var role = Utils.trim(row.role) || 'Viewer';
    if (!RANK[role]) role = 'Viewer';
    return { email: email, name: Utils.trim(row.name) || email.split('@')[0], role: role, active: active, hasAccess: active };
  }

  /** Throws unless the caller has at least `role`. Returns the user object. */
  function require(role) {
    var u = currentUser();
    if (!u.email) throw new Error('Could not identify you. Sign in with your work Google account.');
    if (!u.hasAccess) throw new Error('No access — contact your IT admin.');
    if (RANK[u.role] < RANK[role]) {
      throw new Error('You need ' + role + ' access for this. Your role is ' + u.role + '.');
    }
    return u;
  }

  function can(role) {
    var u = currentUser();
    return u.hasAccess && RANK[u.role] >= RANK[role];
  }

  return { currentUser: currentUser, require: require, can: can, RANK: RANK };
})();
