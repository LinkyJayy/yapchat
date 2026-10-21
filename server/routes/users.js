'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { get, all, run, newId, tx } = require('../db');
const { h, fail, str, toId, rateLimit, parseJSON, COLOR_RE, isEmoji } = require('../util');
const { createSession, requireAuth, destroySession, validateUsername } = require('../auth');
const ser = require('../serialize');
const gateway = require('../gateway');
const push = require('../push');
const uploads = require('../uploads');
const config = require('../config');
const presence = require('../presence');

const r = express.Router();

// ---------- Auth ----------
r.post('/auth/register', h(async (req, res) => {
  if (!config.registrationOpen) fail(403, 'Registration is currently closed on this Yapper instance.');
  rateLimit(`register:${req.ip}`, 10, 3600_000);
  const username = validateUsername(req.body.username);
  const password = str(req.body.password, { min: 8, max: 128, name: 'Password', trim: false });
  const display = str(req.body.display_name, { max: 32, name: 'Display name' }) || null;
  const email = str(req.body.email, { max: 200, name: 'Email' }) || null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'That email address does not look right.');
  if (get('SELECT 1 FROM users WHERE username = ?', username)) fail(409, 'That username is taken.');
  const hash = await bcrypt.hash(password, 11);
  const id = newId();
  run('INSERT INTO users (id, username, display_name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    id, username, display, email, hash, Date.now());
  res.json({ token: createSession(id, req.headers['user-agent']) });
}));

r.post('/auth/login', h(async (req, res) => {
  rateLimit(`login:${req.ip}`, 20, 900_000);
  const login = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  rateLimit(`login-user:${login}`, 10, 900_000);
  const u = get('SELECT * FROM users WHERE username = ? OR (email IS NOT NULL AND lower(email) = ?)', login, login);
  if (!u || !(await bcrypt.compare(password, u.password_hash))) fail(401, 'Wrong username or password.');
  res.json({ token: createSession(u.id, req.headers['user-agent']) });
}));

r.use(requireAuth);

r.post('/auth/logout', h((req, res) => {
  if (req.body?.endpoint) push.unsubscribe(req.body.endpoint);
  destroySession(req.user.token_hash);
  gateway.closeSession(req.user.token_hash);
  res.json({ ok: true });
}));

r.get('/auth/sessions', h((req, res) => {
  res.json(all('SELECT token_hash, user_agent, created_at, last_seen FROM sessions WHERE user_id = ? ORDER BY last_seen DESC', req.user.id)
    .map((s) => ({ id: s.token_hash.slice(0, 16), user_agent: s.user_agent, created_at: s.created_at, last_seen: s.last_seen, current: s.token_hash === req.user.token_hash })));
}));

r.delete('/auth/sessions/:id', h((req, res) => {
  const id = String(req.params.id);
  const sessions = all('SELECT token_hash FROM sessions WHERE user_id = ?', req.user.id);
  for (const s of sessions) {
    if ((id === 'others' && s.token_hash !== req.user.token_hash) || s.token_hash.slice(0, 16) === id) {
      destroySession(s.token_hash);
      gateway.closeSession(s.token_hash);
    }
  }
  res.json({ ok: true });
}));

// ---------- Ready payload ----------
r.get('/ready', h((req, res) => {
  const uid = req.user.id;
  const servers = all('SELECT s.* FROM servers s JOIN members m ON m.server_id = s.id WHERE m.user_id = ? ORDER BY m.position, m.joined_at', uid)
    .map((s) => require('./servers').serverPayload(s, uid));
  const dms = all(
    `SELECT c.* FROM channels c JOIN dm_members d ON d.channel_id = c.id WHERE d.user_id = ? AND d.closed = 0
     ORDER BY COALESCE(c.last_message_id, c.id) DESC`, uid
  ).map((c) => ser.dmChannel(c, uid));
  const relationships = all('SELECT other_id, type, created_at FROM relationships WHERE user_id = ?', uid)
    .map((x) => ({ type: x.type, user: ser.userById(x.other_id), created_at: x.created_at }));
  const readStates = all('SELECT channel_id, last_read_id, mention_count FROM read_states WHERE user_id = ?', uid);
  const notify = all('SELECT target_id, level, muted FROM notify_settings WHERE user_id = ?', uid);
  res.json({
    user: ser.selfUser(req.user), servers, dms, relationships, read_states: readStates, notify_settings: notify,
    vapid_public_key: push.publicKey(), limits: { upload: config.maxUploadBytes, avatar: config.maxAvatarBytes, emoji: config.maxEmojiBytes, music: config.maxMusicBytes },
  });
}));

// ---------- Self ----------
const avatarUpload = uploads.memory(config.maxAvatarBytes, 2).fields([{ name: 'avatar', maxCount: 1 }, { name: 'banner', maxCount: 1 }]);

r.patch('/users/@me', avatarUpload, h(async (req, res) => {
  const u = req.user;
  const b = req.body || {};
  const sets = {};
  if ('display_name' in b) sets.display_name = str(b.display_name, { max: 32, name: 'Display name' }) || null;
  if ('bio' in b) sets.bio = str(b.bio, { max: 400, name: 'About me', trim: false }).trim();
  if ('pronouns' in b) sets.pronouns = str(b.pronouns, { max: 40, name: 'Pronouns' });
  if ('accent_color' in b) {
    const c = String(b.accent_color || '');
    if (c && !COLOR_RE.test(c)) fail(400, 'Invalid color.');
    sets.accent_color = c || null;
  }
  if ('custom_status' in b) sets.custom_status = str(b.custom_status, { max: 128, name: 'Custom status' }) || null;
  if ('custom_status_emoji' in b) {
    const e = str(b.custom_status_emoji, { max: 64, name: 'Status emoji' }) || null;
    if (e && !isEmoji(e)) fail(400, 'Invalid status emoji.');
    sets.custom_status_emoji = e;
  }
  if ('status' in b) {
    if (!['online', 'idle', 'dnd', 'invisible'].includes(b.status)) fail(400, 'Invalid status.');
    sets.status = b.status;
  }
  if ('settings' in b) {
    const s = typeof b.settings === 'string' ? parseJSON(b.settings, null) : b.settings;
    if (!s || typeof s !== 'object') fail(400, 'Invalid settings.');
    const current = parseJSON(u.settings, {});
    const merged = { ...current, ...s };
    // The music file itself is only changed through /users/@me/music.
    if (s.bgMusic && typeof s.bgMusic === 'object') merged.bgMusic = { ...s.bgMusic, url: current.bgMusic?.url || null, name: current.bgMusic?.name || null };
    const json = JSON.stringify(merged);
    if (json.length > 20000) fail(400, 'Settings too large.');
    sets.settings = json;
  }
  if ('username' in b || 'new_password' in b || 'email' in b) {
    if (!(await bcrypt.compare(String(b.password || ''), u.password_hash))) fail(401, 'Your current password is incorrect.');
    if ('username' in b) {
      const name = validateUsername(b.username);
      if (name !== u.username && get('SELECT 1 FROM users WHERE username = ? AND id != ?', name, u.id)) fail(409, 'That username is taken.');
      sets.username = name;
    }
    if ('email' in b) {
      const email = str(b.email, { max: 200, name: 'Email' }) || null;
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'That email address does not look right.');
      sets.email = email;
    }
    if ('new_password' in b) sets.password_hash = await bcrypt.hash(str(b.new_password, { min: 8, max: 128, name: 'Password', trim: false }), 11);
  }
  const files = req.files || {};
  for (const k of ['avatar', 'banner']) {
    if (files[k]?.[0]) {
      const f = uploads.store(files[k][0], { imagesOnly: true });
      uploads.removeUpload(u[k]);
      sets[k] = f.url;
    } else if (b[`remove_${k}`] === 'true' || b[`remove_${k}`] === true) {
      uploads.removeUpload(u[k]);
      sets[k] = null;
    }
  }
  const keys = Object.keys(sets);
  if (keys.length) run(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => sets[k]), u.id);
  if (keys.some((k) => k !== 'settings')) gateway.broadcastUser(u.id);
  if ('status' in sets || 'custom_status' in sets || 'custom_status_emoji' in sets) gateway.broadcastPresence(u.id);
  res.json(ser.selfUser(get('SELECT * FROM users WHERE id = ?', u.id)));
}));

r.delete('/users/@me', h(async (req, res) => {
  const u = req.user;
  if (!(await bcrypt.compare(String(req.body?.password || ''), u.password_hash))) fail(401, 'Your password is incorrect.');
  if (get('SELECT 1 FROM servers WHERE owner_id = ?', u.id)) fail(400, 'Transfer or delete the servers you own first.');
  const related = [...all('SELECT server_id FROM members WHERE user_id = ?', u.id)];
  tx(() => {
    run('DELETE FROM users WHERE id = ?', u.id);
  });
  for (const m of related) gateway.toServer(m.server_id, 'member_remove', { server_id: m.server_id, user_id: u.id });
  uploads.removeUpload(u.avatar); uploads.removeUpload(u.banner); uploads.removeUpload(parseJSON(u.settings, {}).bgMusic?.url);
  gateway.disconnectUser(u.id);
  res.json({ ok: true });
}));

// ---------- Background music ----------
const PLAYABLE_AUDIO = new Set(['audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/flac', 'audio/mp4', 'video/webm', 'video/mp4']);

function setMusic(user, music) {
  const settings = parseJSON(user.settings, {});
  const next = { ...settings, bgMusic: { ...(settings.bgMusic || {}), ...music } };
  run('UPDATE users SET settings = ? WHERE id = ?', JSON.stringify(next), user.id);
  const fresh = ser.selfUser(get('SELECT * FROM users WHERE id = ?', user.id));
  gateway.toUser(user.id, 'self_update', fresh);
  return fresh;
}

r.post('/users/@me/music', uploads.memory(config.maxMusicBytes).single('file'), h((req, res) => {
  if (!req.file) fail(400, 'Choose an audio file.');
  const info = uploads.sniff(req.file.buffer);
  if (!info || !PLAYABLE_AUDIO.has(info.mime)) fail(400, 'Please choose an audio file (MP3, OGG, WAV, FLAC, M4A or WebM).');
  const old = parseJSON(req.user.settings, {}).bgMusic?.url;
  const f = uploads.store(req.file);
  uploads.removeUpload(old);
  res.json(setMusic(req.user, { url: f.url, name: f.name, enabled: true }));
}));

r.delete('/users/@me/music', h((req, res) => {
  uploads.removeUpload(parseJSON(req.user.settings, {}).bgMusic?.url);
  res.json(setMusic(req.user, { url: null, name: null, enabled: false }));
}));

r.post('/users/@me/push', h((req, res) => {
  if (!push.subscribe(req.user.id, req.body)) fail(400, 'Invalid push subscription.');
  res.json({ ok: true });
}));
r.delete('/users/@me/push', h((req, res) => {
  push.unsubscribe(req.body?.endpoint);
  res.json({ ok: true });
}));

r.put('/users/@me/notify/:target', h((req, res) => {
  const target = toId(req.params.target);
  if (!target) fail(400, 'Invalid target.');
  const level = req.body.level == null ? null : String(req.body.level);
  if (level && !['all', 'mentions', 'none'].includes(level)) fail(400, 'Invalid level.');
  const muted = req.body.muted ? 1 : 0;
  run(`INSERT INTO notify_settings (user_id, target_id, level, muted) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, target_id) DO UPDATE SET level = excluded.level, muted = excluded.muted`, req.user.id, target, level, muted);
  const data = { target_id: target, level, muted };
  gateway.toUser(req.user.id, 'notify_settings', data);
  res.json(data);
}));

r.put('/users/@me/server-order', h((req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(toId) : [];
  tx(() => ids.forEach((id, i) => run('UPDATE members SET position = ? WHERE server_id = ? AND user_id = ?', i, id, req.user.id)));
  gateway.toUser(req.user.id, 'server_order', { ids });
  res.json({ ok: true });
}));

// ---------- Other users ----------
r.get('/users/:id', h((req, res) => {
  const id = toId(req.params.id);
  const u = get('SELECT * FROM users WHERE id = ?', id);
  if (!u) fail(404, 'User not found.');
  const mutualServers = all(
    'SELECT m1.server_id FROM members m1 JOIN members m2 ON m1.server_id = m2.server_id WHERE m1.user_id = ? AND m2.user_id = ?', req.user.id, id
  ).map((x) => x.server_id);
  const mutualFriends = all(
    `SELECT a.other_id FROM relationships a JOIN relationships b ON a.other_id = b.other_id
     WHERE a.user_id = ? AND b.user_id = ? AND a.type = 'friend' AND b.type = 'friend'`, req.user.id, id
  ).map((x) => ser.userById(x.other_id));
  const note = get('SELECT note FROM user_notes WHERE user_id = ? AND target_id = ?', req.user.id, id)?.note || '';
  const rel = get('SELECT type FROM relationships WHERE user_id = ? AND other_id = ?', req.user.id, id)?.type || null;
  res.json({ user: ser.publicUser(u), mutual_servers: mutualServers, mutual_friends: mutualFriends, note, relationship: rel });
}));

r.put('/users/:id/note', h((req, res) => {
  const id = toId(req.params.id);
  if (!get('SELECT 1 FROM users WHERE id = ?', id)) fail(404, 'User not found.');
  const note = str(req.body.note, { max: 256, name: 'Note' });
  if (note) run('INSERT INTO user_notes (user_id, target_id, note) VALUES (?, ?, ?) ON CONFLICT(user_id, target_id) DO UPDATE SET note = excluded.note', req.user.id, id, note);
  else run('DELETE FROM user_notes WHERE user_id = ? AND target_id = ?', req.user.id, id);
  res.json({ note });
}));

// ---------- Relationships ----------
function relEvent(userId, otherId) {
  const row = get('SELECT type, created_at FROM relationships WHERE user_id = ? AND other_id = ?', userId, otherId);
  gateway.toUser(userId, 'relationship', row ? { type: row.type, user: ser.userById(otherId), created_at: row.created_at } : { type: null, user: ser.userById(otherId) });
}
function setRel(a, b, type) {
  if (type) run(`INSERT INTO relationships (user_id, other_id, type, created_at) VALUES (?, ?, ?, ?)
                 ON CONFLICT(user_id, other_id) DO UPDATE SET type = excluded.type, created_at = excluded.created_at`, a, b, type, Date.now());
  else run('DELETE FROM relationships WHERE user_id = ? AND other_id = ?', a, b);
}

r.post('/relationships', h((req, res) => {
  rateLimit(`friend:${req.user.id}`, 30, 600_000);
  const me = req.user.id;
  let other;
  if (req.body.user_id) other = get('SELECT id FROM users WHERE id = ?', toId(req.body.user_id));
  else other = get('SELECT id FROM users WHERE username = ?', String(req.body.username || '').trim().toLowerCase().replace(/^@/, ''));
  if (!other) fail(404, "Hm, didn't work. Double check that the username is correct.");
  const oid = other.id;
  if (oid === me) fail(400, "You can't add yourself as a friend.");
  const mine = get('SELECT type FROM relationships WHERE user_id = ? AND other_id = ?', me, oid)?.type;
  const theirs = get('SELECT type FROM relationships WHERE user_id = ? AND other_id = ?', oid, me)?.type;
  if (mine === 'friend') fail(400, "You're already friends with that user!");
  if (theirs === 'blocked') fail(400, "Hm, didn't work. That user isn't accepting friend requests from you.");
  if (mine === 'incoming') { setRel(me, oid, 'friend'); setRel(oid, me, 'friend'); }
  else { setRel(me, oid, 'outgoing'); setRel(oid, me, 'incoming'); }
  relEvent(me, oid); relEvent(oid, me);
  if (mine !== 'incoming') push.send(oid, { type: 'friend', title: 'New friend request', body: `${req.user.display_name || req.user.username} sent you a friend request.`, icon: req.user.avatar || '/icons/icon-192.png', url: '/channels/@me', tag: `friend-${me}` }).catch(() => {});
  res.json({ ok: true });
}));

r.put('/relationships/:id/block', h((req, res) => {
  const me = req.user.id; const oid = toId(req.params.id);
  if (!get('SELECT 1 FROM users WHERE id = ?', oid) || oid === me) fail(404, 'User not found.');
  setRel(me, oid, 'blocked');
  const theirs = get('SELECT type FROM relationships WHERE user_id = ? AND other_id = ?', oid, me)?.type;
  if (theirs && theirs !== 'blocked') setRel(oid, me, null);
  relEvent(me, oid); relEvent(oid, me);
  res.json({ ok: true });
}));

r.delete('/relationships/:id', h((req, res) => {
  const me = req.user.id; const oid = toId(req.params.id);
  const mine = get('SELECT type FROM relationships WHERE user_id = ? AND other_id = ?', me, oid)?.type;
  setRel(me, oid, null);
  if (mine && mine !== 'blocked') {
    const theirs = get('SELECT type FROM relationships WHERE user_id = ? AND other_id = ?', oid, me)?.type;
    if (theirs !== 'blocked') setRel(oid, me, null);
  }
  relEvent(me, oid); relEvent(oid, me);
  res.json({ ok: true });
}));

// ---------- Direct messages ----------
function canDM(me, other) {
  if (get("SELECT 1 FROM relationships WHERE user_id = ? AND other_id = ? AND type = 'blocked'", other, me)) return false;
  if (get("SELECT 1 FROM relationships WHERE user_id = ? AND other_id = ? AND type = 'friend'", me, other)) return true;
  return !!get('SELECT 1 FROM members m1 JOIN members m2 ON m1.server_id = m2.server_id WHERE m1.user_id = ? AND m2.user_id = ?', me, other);
}

r.post('/dms', h((req, res) => {
  const me = req.user.id;
  const ids = [...new Set((Array.isArray(req.body.recipients) ? req.body.recipients : [req.body.recipient]).map(toId).filter((x) => x && x !== me))];
  if (!ids.length) fail(400, 'Pick someone to message.');
  if (ids.length > 9) fail(400, 'Group DMs can have up to 10 members.');
  for (const id of ids) {
    if (!get('SELECT 1 FROM users WHERE id = ?', id)) fail(404, 'User not found.');
    if (ids.length === 1 ? !canDM(me, id) : !get("SELECT 1 FROM relationships WHERE user_id = ? AND other_id = ? AND type = 'friend'", me, id)) {
      fail(403, ids.length === 1 ? "You can't message this user. You need to be friends or share a server." : 'You can only add friends to a group DM.');
    }
  }
  let ch;
  if (ids.length === 1) {
    ch = get(`SELECT c.* FROM channels c JOIN dm_members a ON a.channel_id = c.id AND a.user_id = ? JOIN dm_members b ON b.channel_id = c.id AND b.user_id = ?
              WHERE c.type = 'dm'`, me, ids[0]);
  }
  if (!ch) {
    const id = newId();
    tx(() => {
      run('INSERT INTO channels (id, type, owner_id, created_at) VALUES (?, ?, ?, ?)', id, ids.length === 1 ? 'dm' : 'group', me, Date.now());
      for (const uid of [me, ...ids]) run('INSERT INTO dm_members (channel_id, user_id, closed) VALUES (?, ?, ?)', id, uid, uid === me || ids.length > 1 ? 0 : 1);
    });
    ch = get('SELECT * FROM channels WHERE id = ?', id);
    if (ids.length > 1) for (const uid of ids) gateway.toUser(uid, 'dm_create', ser.dmChannel(ch, uid));
  } else {
    run('UPDATE dm_members SET closed = 0 WHERE channel_id = ? AND user_id = ?', ch.id, me);
  }
  const payload = ser.dmChannel(ch, me);
  gateway.toUser(me, 'dm_create', payload);
  res.json(payload);
}));

module.exports = r;
module.exports.canDM = canDM;
