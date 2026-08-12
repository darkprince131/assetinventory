/**
 * auth-logout.js — clears the session cookie.
 * Nothing is stored server-side, so expiring the cookie is the whole operation.
 */

const session = require('./_lib/session');

exports.handler = async function () {
  return {
    statusCode: 302,
    headers: {
      location: '/',
      'set-cookie': session.clearHeader(),
      'cache-control': 'no-store'
    },
    body: ''
  };
};
