'use strict';
const crypto = require('node:crypto');
const { get, run } = require('./db');
const { fail } = require('./util');

const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

function createSession(userId, userAgent) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  run('INSERT INTO sessions (token_hash, user_id, user_agent, created_at, last_seen) VALUES (?, ?, ?, ?, ?)',
    hashToken(token), userId, String(userAgent || '').slice(0, 300), now, now);
  return token;
}

function userFromToken(token) {
  if (!token || typeof token !== 'string') return null;
  const th = hashToken(token);
  const s = get('SELECT user_id, last_seen FROM sessions WHERE token_hash = ?', th);
  if (!s) return null;
  if (Date.now() - s.last_seen > 3600_000) run('UPDATE sessions SET last_seen = ? WHERE token_hash = ?', Date.now(), th);
  const user = get('SELECT * FROM users WHERE id = ?', s.user_id);
  if (user) user.token_hash = th;
  return user || null;
}

function bearer(req) {
  const a = req.headers.authorization || '';
  return a.startsWith('Bearer ') ? a.slice(7) : null;
}

function requireAuth(req, _res, next) {
  const user = userFromToken(bearer(req));
  if (!user) return next(Object.assign(new Error('Not logged in.'), { status: 401 }));
  req.user = user;
  next();
}

function destroySession(tokenHash) {
  run('DELETE FROM sessions WHERE token_hash = ?', tokenHash);
}

const USERNAME_RE = /^[a-z0-9_.]{2,32}$/;
function validateUsername(u) {
  if (typeof u !== 'string') fail(400, 'Username is required.');
  u = u.trim().toLowerCase();
  if (!USERNAME_RE.test(u)) fail(400, 'Usernames are 2–32 characters: letters, numbers, underscores and periods.');
  if (u.includes('..')) fail(400, 'Usernames cannot contain consecutive periods.');
  return u;
}

module.exports = { createSession, userFromToken, requireAuth, destroySession, hashToken, validateUsername, bearer };
