/**
 * local-transport.js — wires the client's App.transport seam to the server code
 * running in this same page, on top of host-browser.js.
 *
 * Load order matters: host-browser.js → backend/*.js → app.js → pages → this file.
 */

(function () {

  // 1. Restore the demo spreadsheet, or build one on first visit.
  var restored = Host.load();
  if (!restored) {
    setupSpreadsheet();
    seedDemoData();
    Host.save();
  } else if (!DB.read('Users').length) {
    // Storage survived but access rows did not — re-run the idempotent setup.
    setupSpreadsheet();
    Host.save();
  }

  App.state.mode = 'local';

  /**
   * Calls the server function directly. Kept asynchronous on purpose: the
   * Apps Script build is async, and code that assumed otherwise would break
   * the moment this is pointed at a real HTTP backend.
   */
  App.transport = function (name, args) {
    return new Promise(function (resolve, reject) {
      setTimeout(function () {
        var fn = window[name];
        if (typeof fn !== 'function') return reject(new Error('Unknown server function: ' + name));
        try {
          var result = fn.apply(null, args);
          Host.save();
          resolve(result);
        } catch (e) {
          reject(new Error(e.message || String(e)));
        }
      }, 0);
    });
  };

  // 2. Demo bar.
  document.addEventListener('DOMContentLoaded', wireDemoBar);
  if (document.readyState !== 'loading') wireDemoBar();

  var wired = false;
  function wireDemoBar() {
    if (wired) return;
    var bar = document.getElementById('demobar');
    if (!bar) return;
    wired = true;

    document.getElementById('demoUser').textContent = Host.user();

    var roleSel = document.getElementById('demoRole');
    roleSel.value = currentRole();
    roleSel.onchange = function () {
      DB.updateById('Users', Host.user(), { role: roleSel.value });
      Host.save();
      App.start();
    };

    document.getElementById('demoReset').onclick = function () {
      if (!window.confirm('Reset the demo data? Everything you have changed in this browser will be discarded and the sample assets rebuilt.')) return;
      Host.reset();
      location.reload();
    };
  }

  function currentRole() {
    var row = DB.findBy('Users', 'email', Host.user());
    return row ? row.role : 'Admin';
  }

  // 3. Start.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { App.start(); });
  } else {
    App.start();
  }
})();
