/**
 * http-transport.js — points the client at the Netlify Functions backend.
 *
 * Same App.transport seam the demo build uses; only the other side differs.
 * Auth is a cookie set by the sign-in redirect, so there is no token handling
 * here and nothing sensitive in page scripts.
 */

(function () {

  App.state.mode = 'http';

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

  function showSignIn() {
    var content = document.getElementById('content');
    if (!content) return;
    var back = encodeURIComponent('/' + (location.hash || ''));
    content.className = '';
    content.innerHTML =
      '<div style="max-width:420px;margin:80px auto;text-align:center">' +
        '<h1>Asset Tracker</h1>' +
        '<p class="sub">Sign in with your work Google account to continue.</p>' +
        '<p><a class="btn primary" href="/api/auth/login?returnTo=' + back + '">Sign in with Google</a></p>' +
      '</div>';
    var side = document.getElementById('sidebar');
    if (side) side.style.visibility = 'hidden';
    var bar = document.getElementById('demobar');
    if (bar) bar.style.display = 'none';
  }

  App.showSignIn = showSignIn;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { App.start(); });
  } else {
    App.start();
  }
})();
