/**
 * http-transport.js — points the client at the Netlify Functions backend.
 *
 * Same App.transport seam the demo build uses; only the other side differs.
 * Auth is a cookie set by the server, so there is no token handling here and
 * nothing sensitive in page scripts. The server tells us which sign-in screen
 * to show: Google (Sheets backend) or password (Supabase backend).
 */

(function () {

  App.state.mode = 'http';
  App.state.authMode = 'google';

  App.transport = function (name, args) {
    return fetch('/api', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fn: name, args: args || [] })
    }).then(function (res) {
      return res.json().catch(function () {
        throw new Error('The server returned an unreadable response (' + res.status + ').');
      }).then(function (body) {
        if (res.status === 401 || (body && body.needsAuth)) {
          if (body && body.authMode) App.state.authMode = body.authMode;
          showSignIn();
          // Marked so App.start does not paint a generic failure over the
          // sign-in screen we just rendered.
          var err = new Error('Sign in to continue.');
          err.needsAuth = true;
          throw err;
        }
        if (!res.ok || !body.ok) {
          throw new Error((body && body.error) || 'Request failed (' + res.status + ').');
        }
        return body.result;
      });
    }, function () {
      throw new Error('Could not reach the server. Check your connection and try again.');
    });
  };

  function post(payload) {
    return fetch('/api/auth/password', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok || !body.ok) throw new Error(body.error || 'Request failed (' + res.status + ').');
        return body;
      });
    });
  }

  function chrome(inner) {
    var content = document.getElementById('content');
    if (!content) return null;
    content.className = '';
    content.innerHTML =
      '<div style="max-width:360px;margin:70px auto">' +
        '<h1>Asset Tracker</h1>' + inner +
      '</div>';
    var side = document.getElementById('sidebar');
    if (side) side.style.visibility = 'hidden';
    return content;
  }

  function showSignIn() {
    if (App.state.authMode === 'password') return showPasswordForm();
    var back = encodeURIComponent('/' + (location.hash || ''));
    chrome(
      '<p class="sub">Sign in with your work Google account to continue.</p>' +
      '<p><a class="btn primary" href="/api/auth/login?returnTo=' + back + '">Sign in with Google</a></p>'
    );
  }

  function showPasswordForm() {
    var content = chrome(
      '<p class="sub">Sign in to continue.</p>' +
      '<div id="authErr" class="mb8" style="display:none;color:var(--red)"></div>' +
      UI.field('Email', '<input id="authEmail" type="email" autocomplete="username">') +
      UI.field('Password', '<input id="authPass" type="password" autocomplete="current-password">') +
      '<p><button class="primary" id="authGo" style="width:100%">Sign in</button></p>' +
      '<p class="muted" style="font-size:11px">No account? An administrator sets one up for you.</p>'
    );
    if (!content) return;

    var go = content.querySelector('#authGo');
    var email = content.querySelector('#authEmail');
    var pass = content.querySelector('#authPass');

    function fail(msg) {
      var box = content.querySelector('#authErr');
      box.textContent = msg;
      box.style.display = '';
    }

    function submit() {
      if (!email.value.trim() || !pass.value) return fail('Enter your email and password.');
      content.querySelector('#authErr').style.display = 'none';
      UI.busy(go, 'Signing in…', post({ action: 'login', email: email.value.trim(), password: pass.value }))
        .then(function (res) {
          if (res.mustChange) return showChangePassword(pass.value);
          var side = document.getElementById('sidebar');
          if (side) side.style.visibility = '';
          App.start();
        })
        .catch(function (e) { fail(e.message); });
    }

    go.onclick = submit;
    [email, pass].forEach(function (el) {
      el.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
    });
    email.focus();
  }

  function showChangePassword(currentPassword) {
    var content = chrome(
      '<p class="sub">Choose a new password before continuing.</p>' +
      '<div id="authErr" class="mb8" style="display:none;color:var(--red)"></div>' +
      UI.field('New password', '<input id="pwNew" type="password" autocomplete="new-password">') +
      UI.field('Repeat it', '<input id="pwNew2" type="password" autocomplete="new-password">') +
      '<p><button class="primary" id="pwGo" style="width:100%">Save and continue</button></p>' +
      '<p class="muted" style="font-size:11px">At least 10 characters.</p>'
    );
    if (!content) return;

    var go = content.querySelector('#pwGo');
    function fail(msg) {
      var box = content.querySelector('#authErr');
      box.textContent = msg;
      box.style.display = '';
    }

    go.onclick = function () {
      var a = content.querySelector('#pwNew').value;
      var b = content.querySelector('#pwNew2').value;
      if (a !== b) return fail('Those two do not match.');
      if (a.length < 10) return fail('Use at least 10 characters.');
      UI.busy(go, 'Saving…', post({ action: 'change', currentPassword: currentPassword, newPassword: a }))
        .then(function () {
          var side = document.getElementById('sidebar');
          if (side) side.style.visibility = '';
          UI.ok('Password updated.');
          App.start();
        })
        .catch(function (e) { fail(e.message); });
    };
    content.querySelector('#pwNew').focus();
  }

  App.showSignIn = showSignIn;
  App.showChangePassword = showChangePassword;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { App.start(); });
  } else {
    App.start();
  }
})();
