'use strict';
const express = require('express');
const crypto = require('node:crypto');
const path = require('node:path');
const { get, all, run, newId, tx } = require('../db');
const { h, fail, str, toId, rateLimit, COLOR_RE } = require('../util');
const { requireAuth } = require('../auth');
const { P, ALL, DEFAULT_EVERYONE, serverPermissions, channelPermissions, has, topPosition, canActOn } = require('../permissions');
const ser = require('../serialize');
const gateway = require('../gateway');
const presence = require('../presence');
const uploads = require('../uploads');
const config = require('../config');

const r = express.Router();
r.use(requireAuth);

// ---------- Helpers ----------
function audit(serverId, userId, action, target, details) {
  run('INSERT INTO audit_log (id, server_id, user_id, action, target, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    newId(), serverId, userId, action, target == null ? null : String(target), details ? JSON.stringify(details) : null, Date.now());
}

function loadServer(req, perm) {
  const s = get('SELECT * FROM servers WHERE id = ?', toId(req.params.id));
  if (!s) fail(404, 'Server not found.');
  const perms = serverPermissions(s.id, req.user.id);
  if (!perms) fail(404, 'Server not found.');
  if (perm && !has(perms, perm)) fail(403, "You don't have permission to do that.");
  req.perms = perms;
  return s;
}

function generatePin() {
  for (let i = 0; i < 50; i++) {
    const pin = String(crypto.randomInt(0, 1e8)).padStart(8, '0');
    if (!get('SELECT 1 FROM servers WHERE pin = ?', pin)) return pin;
  }
  fail(500, 'Could not generate a PIN, try again.');
}

function serverPayload(s, uid) {
  const perms = serverPermissions(s.id, uid);
  const channels = all('SELECT * FROM channels WHERE server_id = ? ORDER BY position, id', s.id)
    .map((c) => ({ c, p: channelPermissions(c, uid) }))
    .filter(({ c, p }) => has(p, P.VIEW_CHANNELS) || (c.type === 'category'))
    .map(({ c, p }) => ({ ...ser.channel(c), permissions: p, overwrites: has(perms, P.MANAGE_ROLES) || has(perms, P.MANAGE_CHANNELS) ? ser.overwrites(c.id) : undefined }));
  // Hide empty categories the user can't see into.
  const visibleParents = new Set(channels.filter((c) => c.type !== 'category').map((c) => c.parent_id));
  const filtered = channels.filter((c) => c.type !== 'category' || has(c.permissions, P.VIEW_CHANNELS) || visibleParents.has(c.id));
  return {
    id: s.id, name: s.name, icon: s.icon, banner: s.banner, description: s.description, owner_id: s.owner_id,
    system_channel_id: s.system_channel_id, created_at: s.created_at,
    pin: has(perms, P.MANAGE_SERVER) ? s.pin : undefined,
    permissions: perms,
    member_count: get('SELECT COUNT(*) AS n FROM members WHERE server_id = ?', s.id).n,
    rating: serverRating(s.id),
    channels: filtered,
    roles: all('SELECT * FROM roles WHERE server_id = ? ORDER BY position DESC', s.id).map(ser.role),
    emojis: all('SELECT * FROM emojis WHERE server_id = ? ORDER BY name', s.id).map(ser.emoji),
    me: ser.member(s.id, uid),
  };
}

// Public member counter: total members, who's online, and who's in voice right now.
function serverCounts(serverId) {
  const users = all('SELECT u.id, u.status FROM members m JOIN users u ON u.id = m.user_id WHERE m.server_id = ?', serverId);
  const online = users.filter((u) => presence.statusOf(u) !== 'offline').length;
  const inVoice = new Set();
  for (const c of all("SELECT id FROM channels WHERE server_id = ? AND type = 'voice'", serverId)) {
    for (const v of gateway.voiceStates(c.id)) inVoice.add(v.user_id);
  }
  return { total: users.length, online, voice: inVoice.size };
}

function serverRating(serverId) {
  const r = get('SELECT AVG(rating) AS avg, COUNT(*) AS n FROM server_reviews WHERE server_id = ?', serverId);
  const dist = [0, 0, 0, 0, 0];
  for (const x of all('SELECT rating, COUNT(*) AS n FROM server_reviews WHERE server_id = ? GROUP BY rating', serverId)) dist[x.rating - 1] = x.n;
  return { average: r.n ? Math.round(r.avg * 10) / 10 : null, count: r.n, distribution: dist };
}

function reviewPayload(r) {
  return { user: ser.userById(r.user_id), rating: r.rating, content: r.content, created_at: r.created_at, updated_at: r.updated_at };
}

// Tell every member to refresh their copy of the server (permissions may have changed).
function refresh(serverId) {
  const s = get('SELECT * FROM servers WHERE id = ?', serverId);
  if (!s) return;
  for (const m of all('SELECT user_id FROM members WHERE server_id = ?', serverId)) {
    gateway.toUser(m.user_id, 'server_update', serverPayload(s, m.user_id));
  }
}

function systemMessage(serverId, content, authorId) {
  const s = get('SELECT system_channel_id FROM servers WHERE id = ?', serverId);
  if (!s?.system_channel_id) return;
  const ch = get('SELECT * FROM channels WHERE id = ?', s.system_channel_id);
  if (!ch) return;
  const id = newId();
  run("INSERT INTO messages (id, channel_id, author_id, type, content, created_at) VALUES (?, ?, ?, 'system', ?, ?)", id, ch.id, authorId, content, Date.now());
  run('UPDATE channels SET last_message_id = ? WHERE id = ?', id, ch.id);
  gateway.toChannel(ch, 'message_create', ser.message(get('SELECT * FROM messages WHERE id = ?', id)));
}

function addMember(serverId, userId) {
  run('INSERT INTO members (server_id, user_id, joined_at, position) VALUES (?, ?, ?, ?)', serverId, userId, Date.now(),
    (get('SELECT MAX(position) AS p FROM members WHERE user_id = ?', userId)?.p ?? -1) + 1);
  gateway.joinServerRoom(userId, serverId);
  gateway.toServer(serverId, 'member_add', { server_id: serverId, member: ser.member(serverId, userId) });
  const s = get('SELECT * FROM servers WHERE id = ?', serverId);
  gateway.toUser(userId, 'server_create', serverPayload(s, userId));
  systemMessage(serverId, 'join', userId);
}

function removeMember(serverId, userId) {
  run('DELETE FROM members WHERE server_id = ? AND user_id = ?', serverId, userId);
  run('DELETE FROM read_states WHERE user_id = ? AND channel_id IN (SELECT id FROM channels WHERE server_id = ?)', userId, serverId);
  gateway.leaveServerRoom(userId, serverId);
  gateway.toServer(serverId, 'member_remove', { server_id: serverId, user_id: userId });
  gateway.toUser(userId, 'server_delete', { id: serverId });
}

const imgUpload = uploads.memory(config.maxAvatarBytes, 2).fields([{ name: 'icon', maxCount: 1 }, { name: 'banner', maxCount: 1 }]);

// ---------- Servers ----------
r.post('/servers', imgUpload, h((req, res) => {
  rateLimit(`create-server:${req.user.id}`, 10, 3600_000);
  if (get('SELECT COUNT(*) AS n FROM members WHERE user_id = ?', req.user.id).n >= 200) fail(400, 'You can be in up to 200 servers.');
  const name = str(req.body.name, { min: 1, max: 100, name: 'Server name' });
  const icon = req.files?.icon?.[0] ? uploads.store(req.files.icon[0], { imagesOnly: true }).url : null;
  const id = newId();
  const uid = req.user.id;
  const now = Date.now();
  tx(() => {
    const textCat = newId(), voiceCat = newId(), general = newId(), voiceGeneral = newId();
    run('INSERT INTO servers (id, name, icon, owner_id, pin, system_channel_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, name, icon, uid, generatePin(), general, now);
    run('INSERT INTO roles (id, server_id, name, permissions, position, is_default) VALUES (?, ?, ?, ?, 0, 1)', newId(), id, '@everyone', DEFAULT_EVERYONE);
    run("INSERT INTO channels (id, server_id, type, name, position, created_at) VALUES (?, ?, 'category', 'Text Channels', 0, ?)", textCat, id, now);
    run("INSERT INTO channels (id, server_id, type, name, position, created_at) VALUES (?, ?, 'category', 'Voice Channels', 1, ?)", voiceCat, id, now);
    run("INSERT INTO channels (id, server_id, type, name, parent_id, position, created_at) VALUES (?, ?, 'text', 'general', ?, 0, ?)", general, id, textCat, now);
    run("INSERT INTO channels (id, server_id, type, name, parent_id, position, created_at) VALUES (?, ?, 'voice', 'General', ?, 0, ?)", voiceGeneral, id, voiceCat, now);
    run('INSERT INTO members (server_id, user_id, joined_at, position) VALUES (?, ?, ?, ?)', id, uid, now,
      (get('SELECT MAX(position) AS p FROM members WHERE user_id = ?', uid)?.p ?? -1) + 1);
  });
  gateway.joinServerRoom(uid, id);
  const payload = serverPayload(get('SELECT * FROM servers WHERE id = ?', id), uid);
  gateway.toUser(uid, 'server_create', payload);
  res.json(payload);
}));

// Join with PIN.
r.post('/servers/join', h((req, res) => {
  rateLimit(`join-pin:${req.user.id}`, 10, 600_000);
  rateLimit(`join-pin-ip:${req.ip}`, 30, 600_000);
  const pin = String(req.body.pin || '').replace(/\D/g, '');
  if (pin.length < 4) fail(400, 'Enter the server PIN.');
  const s = get('SELECT * FROM servers WHERE pin = ?', pin);
  if (!s) fail(404, "That PIN doesn't match any server. Double check it and try again.");
  if (get('SELECT 1 FROM bans WHERE server_id = ? AND user_id = ?', s.id, req.user.id)) fail(403, 'You are banned from this server.');
  if (get('SELECT 1 FROM members WHERE server_id = ? AND user_id = ?', s.id, req.user.id)) return res.json(serverPayload(s, req.user.id));
  if (get('SELECT COUNT(*) AS n FROM members WHERE user_id = ?', req.user.id).n >= 200) fail(400, 'You can be in up to 200 servers.');
  addMember(s.id, req.user.id);
  res.json(serverPayload(s, req.user.id));
}));

// Preview a server from its PIN before joining (name, member counter, rating).
r.post('/servers/preview', h((req, res) => {
  rateLimit(`join-pin:${req.user.id}`, 10, 600_000);
  rateLimit(`join-pin-ip:${req.ip}`, 30, 600_000);
  const pin = String(req.body.pin || '').replace(/\D/g, '');
  if (pin.length < 4) fail(400, 'Enter the server PIN.');
  const s = get('SELECT * FROM servers WHERE pin = ?', pin);
  if (!s) fail(404, "That PIN doesn't match any server. Double check it and try again.");
  res.json({
    id: s.id, name: s.name, icon: s.icon, banner: s.banner, description: s.description, created_at: s.created_at,
    counts: serverCounts(s.id),
    rating: serverRating(s.id),
    reviews: all('SELECT * FROM server_reviews WHERE server_id = ? ORDER BY updated_at DESC LIMIT 3', s.id).map(reviewPayload),
    member: !!get('SELECT 1 FROM members WHERE server_id = ? AND user_id = ?', s.id, req.user.id),
    banned: !!get('SELECT 1 FROM bans WHERE server_id = ? AND user_id = ?', s.id, req.user.id),
  });
}));

r.get('/servers/:id/counts', h((req, res) => {
  const s = loadServer(req);
  res.json(serverCounts(s.id));
}));

// ---------- Reviews ----------
r.get('/servers/:id/reviews', h((req, res) => {
  const s = loadServer(req);
  res.json({
    rating: serverRating(s.id),
    reviews: all('SELECT * FROM server_reviews WHERE server_id = ? ORDER BY updated_at DESC LIMIT 200', s.id).map(reviewPayload),
  });
}));

r.put('/servers/:id/reviews/@me', h((req, res) => {
  const s = loadServer(req);
  if (s.owner_id === req.user.id) fail(400, "You can't review your own server.");
  rateLimit(`review:${req.user.id}`, 10, 600_000);
  const rating = Number(req.body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) fail(400, 'Pick a rating from 1 to 5 stars.');
  const content = str(req.body.content, { max: 1000, name: 'Review' });
  const now = Date.now();
  run(`INSERT INTO server_reviews (server_id, user_id, rating, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(server_id, user_id) DO UPDATE SET rating = excluded.rating, content = excluded.content, updated_at = excluded.updated_at`,
    s.id, req.user.id, rating, content, now, now);
  gateway.toServer(s.id, 'reviews_update', { server_id: s.id, rating: serverRating(s.id) });
  res.json(reviewPayload(get('SELECT * FROM server_reviews WHERE server_id = ? AND user_id = ?', s.id, req.user.id)));
}));

r.delete('/servers/:id/reviews/:uid', h((req, res) => {
  const s = loadServer(req);
  const uid = req.params.uid === '@me' ? req.user.id : toId(req.params.uid);
  if (uid !== req.user.id && !has(req.perms, P.MANAGE_SERVER)) fail(403, "You can't remove other people's reviews.");
  run('DELETE FROM server_reviews WHERE server_id = ? AND user_id = ?', s.id, uid);
  if (uid !== req.user.id) audit(s.id, req.user.id, 'review_delete', uid);
  gateway.toServer(s.id, 'reviews_update', { server_id: s.id, rating: serverRating(s.id) });
  res.json({ ok: true });
}));

r.get('/servers/:id', h((req, res) => {
  const s = loadServer(req);
  res.json(serverPayload(s, req.user.id));
}));

r.patch('/servers/:id', imgUpload, h((req, res) => {
  const s = loadServer(req, P.MANAGE_SERVER);
  const b = req.body || {};
  const sets = {};
  if ('name' in b) sets.name = str(b.name, { min: 1, max: 100, name: 'Server name' });
  if ('description' in b) sets.description = str(b.description, { max: 300, name: 'Description' });
  if ('system_channel_id' in b) {
    const cid = toId(b.system_channel_id);
    if (cid && !get("SELECT 1 FROM channels WHERE id = ? AND server_id = ? AND type IN ('text','announcement')", cid, s.id)) fail(400, 'Invalid channel.');
    sets.system_channel_id = cid || null;
  }
  for (const k of ['icon', 'banner']) {
    if (req.files?.[k]?.[0]) { uploads.removeUpload(s[k]); sets[k] = uploads.store(req.files[k][0], { imagesOnly: true }).url; }
    else if (b[`remove_${k}`] === 'true') { uploads.removeUpload(s[k]); sets[k] = null; }
  }
  const keys = Object.keys(sets);
  if (keys.length) {
    run(`UPDATE servers SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => sets[k]), s.id);
    audit(s.id, req.user.id, 'server_update', s.id, { changed: keys });
    refresh(s.id);
  }
  res.json(serverPayload(get('SELECT * FROM servers WHERE id = ?', s.id), req.user.id));
}));

// PIN management (view is part of the server payload for MANAGE_SERVER).
r.post('/servers/:id/pin', h((req, res) => {
  const s = loadServer(req, P.MANAGE_SERVER);
  let pin;
  if (req.body?.pin) {
    pin = String(req.body.pin).replace(/\D/g, '');
    if (pin.length < 6 || pin.length > 12) fail(400, 'Custom PINs must be 6–12 digits.');
    if (get('SELECT 1 FROM servers WHERE pin = ? AND id != ?', pin, s.id)) fail(409, 'That PIN is already used by another server. Pick a different one.');
  } else pin = generatePin();
  run('UPDATE servers SET pin = ? WHERE id = ?', pin, s.id);
  audit(s.id, req.user.id, 'pin_update', s.id);
  refresh(s.id);
  res.json({ pin });
}));

r.delete('/servers/:id', h((req, res) => {
  const s = loadServer(req);
  if (s.owner_id !== req.user.id) fail(403, 'Only the owner can delete the server.');
  if (String(req.body?.name || '') !== s.name) fail(400, 'Type the server name exactly to confirm.');
  const members = all('SELECT user_id FROM members WHERE server_id = ?', s.id);
  const files = [s.icon, s.banner, ...all('SELECT file FROM emojis WHERE server_id = ?', s.id).map((e) => e.file)];
  run('DELETE FROM servers WHERE id = ?', s.id);
  files.forEach(uploads.removeUpload);
  for (const m of members) { gateway.toUser(m.user_id, 'server_delete', { id: s.id }); gateway.leaveServerRoom(m.user_id, s.id); }
  res.json({ ok: true });
}));

r.post('/servers/:id/transfer', h((req, res) => {
  const s = loadServer(req);
  if (s.owner_id !== req.user.id) fail(403, 'Only the owner can transfer ownership.');
  const to = toId(req.body.user_id);
  if (!get('SELECT 1 FROM members WHERE server_id = ? AND user_id = ?', s.id, to)) fail(404, 'That user is not a member.');
  run('UPDATE servers SET owner_id = ? WHERE id = ?', to, s.id);
  audit(s.id, req.user.id, 'owner_transfer', to);
  refresh(s.id);
  res.json({ ok: true });
}));

r.delete('/servers/:id/members/@me', h((req, res) => {
  const s = loadServer(req);
  if (s.owner_id === req.user.id) fail(400, "You own this server. Transfer ownership or delete it instead.");
  removeMember(s.id, req.user.id);
  systemMessage(s.id, 'leave', req.user.id);
  res.json({ ok: true });
}));

// ---------- Members ----------
r.get('/servers/:id/members', h((req, res) => {
  const s = loadServer(req);
  const rows = all('SELECT * FROM members WHERE server_id = ?', s.id);
  const roles = all('SELECT user_id, role_id FROM member_roles WHERE server_id = ?', s.id);
  const byUser = new Map();
  for (const x of roles) { if (!byUser.has(x.user_id)) byUser.set(x.user_id, []); byUser.get(x.user_id).push(x.role_id); }
  res.json(rows.map((m) => ({
    user: ser.userById(m.user_id), nickname: m.nickname, joined_at: m.joined_at,
    timeout_until: m.timeout_until && m.timeout_until > Date.now() ? m.timeout_until : null,
    roles: byUser.get(m.user_id) || [],
  })));
}));

r.patch('/servers/:id/members/:uid', h((req, res) => {
  const s = loadServer(req);
  const uid = toId(req.params.uid);
  const me = req.user.id;
  const m = get('SELECT * FROM members WHERE server_id = ? AND user_id = ?', s.id, uid);
  if (!m) fail(404, 'Member not found.');
  const b = req.body || {};
  if ('nickname' in b) {
    const nick = str(b.nickname, { max: 32, name: 'Nickname' }) || null;
    if (uid === me) { if (!has(req.perms, P.CHANGE_NICKNAME) && !has(req.perms, P.MANAGE_NICKNAMES)) fail(403, "You can't change your nickname here."); }
    else if (!has(req.perms, P.MANAGE_NICKNAMES) || !canActOn(s.id, me, uid)) fail(403, "You can't change this member's nickname.");
    run('UPDATE members SET nickname = ? WHERE server_id = ? AND user_id = ?', nick, s.id, uid);
    if (uid !== me) audit(s.id, me, 'member_nick', uid, { nickname: nick });
  }
  if ('roles' in b) {
    if (!has(req.perms, P.MANAGE_ROLES)) fail(403, "You don't have permission to manage roles.");
    const myTop = topPosition(s.id, me);
    if (uid !== me && !canActOn(s.id, me, uid) && s.owner_id !== me) fail(403, 'That member has a higher or equal role than you.');
    const wanted = new Set((Array.isArray(b.roles) ? b.roles : []).map(toId));
    const current = new Set(all('SELECT role_id FROM member_roles WHERE server_id = ? AND user_id = ?', s.id, uid).map((x) => x.role_id));
    const roles = new Map(all('SELECT * FROM roles WHERE server_id = ? AND is_default = 0', s.id).map((x) => [x.id, x]));
    const changes = { added: [], removed: [] };
    tx(() => {
      for (const rid of wanted) {
        if (current.has(rid)) continue;
        const role = roles.get(rid);
        if (!role) fail(400, 'Unknown role.');
        if (role.position >= myTop) fail(403, `You can't assign "${role.name}" — it's not below your highest role.`);
        run('INSERT INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)', s.id, uid, rid);
        changes.added.push(role.name);
      }
      for (const rid of current) {
        if (wanted.has(rid)) continue;
        const role = roles.get(rid);
        if (role && role.position >= myTop) fail(403, `You can't remove "${role.name}" — it's not below your highest role.`);
        run('DELETE FROM member_roles WHERE server_id = ? AND user_id = ? AND role_id = ?', s.id, uid, rid);
        if (role) changes.removed.push(role.name);
      }
    });
    if (changes.added.length || changes.removed.length) audit(s.id, me, 'member_roles', uid, changes);
  }
  if ('timeout_until' in b) {
    if (!has(req.perms, P.MODERATE_MEMBERS) || !canActOn(s.id, me, uid)) fail(403, "You can't time out this member.");
    const until = b.timeout_until ? Number(b.timeout_until) : null;
    if (until && (until < Date.now() || until > Date.now() + 28 * 864e5)) fail(400, 'Timeouts can last up to 28 days.');
    run('UPDATE members SET timeout_until = ? WHERE server_id = ? AND user_id = ?', until, s.id, uid);
    audit(s.id, me, until ? 'member_timeout' : 'member_timeout_remove', uid, { until, reason: b.reason || null });
  }
  if ('voice_mute' in b) {
    if (!has(req.perms, P.MUTE_MEMBERS)) fail(403, "You can't server mute members.");
    const ch = gateway.voiceChannelOf(uid);
    if (ch) gateway.serverMute(ch, uid, !!b.voice_mute);
  }
  if ('voice_disconnect' in b) {
    if (!has(req.perms, P.MOVE_MEMBERS) || (uid !== me && !canActOn(s.id, me, uid))) fail(403, "You can't disconnect this member.");
    gateway.disconnectVoiceUser(uid);
  }
  gateway.toServer(s.id, 'member_update', { server_id: s.id, member: ser.member(s.id, uid) });
  if ('roles' in b || 'timeout_until' in b) gateway.toUser(uid, 'server_update', serverPayload(s, uid));
  res.json(ser.member(s.id, uid));
}));

r.delete('/servers/:id/members/:uid', h((req, res) => {
  const s = loadServer(req, P.KICK_MEMBERS);
  const uid = toId(req.params.uid);
  if (!get('SELECT 1 FROM members WHERE server_id = ? AND user_id = ?', s.id, uid)) fail(404, 'Member not found.');
  if (!canActOn(s.id, req.user.id, uid)) fail(403, "You can't kick this member.");
  removeMember(s.id, uid);
  audit(s.id, req.user.id, 'member_kick', uid, { reason: req.body?.reason || null });
  res.json({ ok: true });
}));

// ---------- Bans ----------
r.get('/servers/:id/bans', h((req, res) => {
  const s = loadServer(req, P.BAN_MEMBERS);
  res.json(all('SELECT * FROM bans WHERE server_id = ? ORDER BY created_at DESC', s.id).map((b) => ({ user: ser.userById(b.user_id), reason: b.reason, created_at: b.created_at })));
}));

r.put('/servers/:id/bans/:uid', h((req, res) => {
  const s = loadServer(req, P.BAN_MEMBERS);
  const uid = toId(req.params.uid);
  if (!get('SELECT 1 FROM users WHERE id = ?', uid)) fail(404, 'User not found.');
  const isMember = get('SELECT 1 FROM members WHERE server_id = ? AND user_id = ?', s.id, uid);
  if (uid === req.user.id || uid === s.owner_id || (isMember && !canActOn(s.id, req.user.id, uid))) fail(403, "You can't ban this member.");
  const reason = str(req.body?.reason, { max: 512, name: 'Reason' }) || null;
  run('INSERT INTO bans (server_id, user_id, reason, banned_by, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(server_id, user_id) DO UPDATE SET reason = excluded.reason',
    s.id, uid, reason, req.user.id, Date.now());
  const deleteSeconds = Math.min(Math.max(Number(req.body?.delete_seconds) || 0, 0), 7 * 86400);
  if (deleteSeconds) {
    const since = Date.now() - deleteSeconds * 1000;
    const msgs = all('SELECT m.id, m.channel_id FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.server_id = ? AND m.author_id = ? AND m.created_at >= ?', s.id, uid, since);
    for (const m of msgs) {
      run('DELETE FROM messages WHERE id = ?', m.id);
      const ch = get('SELECT * FROM channels WHERE id = ?', m.channel_id);
      gateway.toChannel(ch, 'message_delete', { id: m.id, channel_id: m.channel_id });
    }
  }
  if (isMember) removeMember(s.id, uid);
  audit(s.id, req.user.id, 'member_ban', uid, { reason });
  res.json({ ok: true });
}));

r.delete('/servers/:id/bans/:uid', h((req, res) => {
  const s = loadServer(req, P.BAN_MEMBERS);
  run('DELETE FROM bans WHERE server_id = ? AND user_id = ?', s.id, toId(req.params.uid));
  audit(s.id, req.user.id, 'member_unban', toId(req.params.uid));
  res.json({ ok: true });
}));

// ---------- Roles ----------
function roleGuard(s, req, role) {
  if (s.owner_id === req.user.id) return;
  if (role && role.position >= topPosition(s.id, req.user.id)) fail(403, "You can only edit roles below your highest role.");
}

r.post('/servers/:id/roles', h((req, res) => {
  const s = loadServer(req, P.MANAGE_ROLES);
  if (get('SELECT COUNT(*) AS n FROM roles WHERE server_id = ?', s.id).n >= 250) fail(400, 'Servers can have up to 250 roles.');
  const id = newId();
  const name = str(req.body?.name || 'new role', { min: 1, max: 100, name: 'Role name' });
  run('UPDATE roles SET position = position + 1 WHERE server_id = ? AND is_default = 0', s.id);
  run('INSERT INTO roles (id, server_id, name, color, permissions, position) VALUES (?, ?, ?, ?, ?, 1)', id, s.id, name, null,
    get('SELECT permissions FROM roles WHERE server_id = ? AND is_default = 1', s.id).permissions);
  audit(s.id, req.user.id, 'role_create', id, { name });
  refresh(s.id);
  res.json(ser.role(get('SELECT * FROM roles WHERE id = ?', id)));
}));

r.patch('/servers/:id/roles/:rid', h((req, res) => {
  const s = loadServer(req, P.MANAGE_ROLES);
  const role = get('SELECT * FROM roles WHERE id = ? AND server_id = ?', toId(req.params.rid), s.id);
  if (!role) fail(404, 'Role not found.');
  if (!role.is_default) roleGuard(s, req, role);
  const b = req.body || {};
  const sets = {};
  if ('name' in b && !role.is_default) sets.name = str(b.name, { min: 1, max: 100, name: 'Role name' });
  if ('color' in b) {
    if (b.color && !COLOR_RE.test(b.color)) fail(400, 'Invalid color.');
    sets.color = b.color || null;
  }
  if ('color2' in b) {
    if (b.color2 && !COLOR_RE.test(b.color2)) fail(400, 'Invalid gradient color.');
    sets.color2 = b.color2 || null;
  }
  if ('animated' in b) sets.animated = b.animated ? 1 : 0;
  if ('hoist' in b && !role.is_default) sets.hoist = b.hoist ? 1 : 0;
  if ('mentionable' in b && !role.is_default) sets.mentionable = b.mentionable ? 1 : 0;
  if ('permissions' in b) {
    let perms = Number(b.permissions) & ALL;
    if (s.owner_id !== req.user.id) {
      // Non-owners can't grant permissions they don't have themselves.
      const changed = perms ^ role.permissions;
      if (changed & ~req.perms) fail(403, "You can't grant or remove permissions you don't have.");
    }
    sets.permissions = perms;
  }
  const keys = Object.keys(sets);
  if (keys.length) {
    run(`UPDATE roles SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => sets[k]), role.id);
    audit(s.id, req.user.id, 'role_update', role.id, { name: role.name, changed: keys });
    refresh(s.id);
  }
  res.json(ser.role(get('SELECT * FROM roles WHERE id = ?', role.id)));
}));

// Reorder: body.ids = role ids from highest to lowest (excluding @everyone).
r.put('/servers/:id/roles', h((req, res) => {
  const s = loadServer(req, P.MANAGE_ROLES);
  const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(toId);
  const roles = all('SELECT * FROM roles WHERE server_id = ? AND is_default = 0', s.id);
  if (ids.length !== roles.length || !roles.every((x) => ids.includes(x.id))) fail(400, 'Role list mismatch.');
  const myTop = topPosition(s.id, req.user.id);
  const n = ids.length;
  tx(() => ids.forEach((id, i) => {
    const role = roles.find((x) => x.id === id);
    const pos = n - i;
    if (pos !== role.position && (role.position >= myTop || pos >= myTop)) fail(403, 'You can only move roles below your highest role.');
    run('UPDATE roles SET position = ? WHERE id = ?', pos, id);
  }));
  refresh(s.id);
  res.json({ ok: true });
}));

r.delete('/servers/:id/roles/:rid', h((req, res) => {
  const s = loadServer(req, P.MANAGE_ROLES);
  const role = get('SELECT * FROM roles WHERE id = ? AND server_id = ?', toId(req.params.rid), s.id);
  if (!role || role.is_default) fail(404, 'Role not found.');
  roleGuard(s, req, role);
  run('DELETE FROM roles WHERE id = ?', role.id);
  run("DELETE FROM channel_overwrites WHERE target_type = 'role' AND target_id = ?", role.id);
  audit(s.id, req.user.id, 'role_delete', role.id, { name: role.name });
  refresh(s.id);
  res.json({ ok: true });
}));

// ---------- Emojis ----------
r.post('/servers/:id/emojis', uploads.memory(config.maxEmojiBytes).single('image'), h((req, res) => {
  const s = loadServer(req, P.MANAGE_EMOJIS);
  if (!req.file) fail(400, 'Choose an image.');
  if (get('SELECT COUNT(*) AS n FROM emojis WHERE server_id = ?', s.id).n >= config.maxEmojisPerServer) fail(400, `Servers can have up to ${config.maxEmojisPerServer} emojis.`);
  let name = String(req.body.name || path.parse(req.file.originalname || '').name || 'emoji').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 32);
  if (name.length < 2) name = (name + '__').slice(0, 2);
  const f = uploads.store(req.file, { imagesOnly: true });
  const id = newId();
  run('INSERT INTO emojis (id, server_id, name, file, animated, creator_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id, s.id, name, f.url, f.animated ? 1 : 0, req.user.id, Date.now());
  audit(s.id, req.user.id, 'emoji_create', id, { name });
  const emojis = all('SELECT * FROM emojis WHERE server_id = ? ORDER BY name', s.id).map(ser.emoji);
  gateway.toServer(s.id, 'emojis_update', { server_id: s.id, emojis });
  res.json(ser.emoji(get('SELECT * FROM emojis WHERE id = ?', id)));
}));

r.patch('/servers/:id/emojis/:eid', h((req, res) => {
  const s = loadServer(req, P.MANAGE_EMOJIS);
  const e = get('SELECT * FROM emojis WHERE id = ? AND server_id = ?', toId(req.params.eid), s.id);
  if (!e) fail(404, 'Emoji not found.');
  const name = String(req.body.name || '').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 32);
  if (name.length < 2) fail(400, 'Emoji names need at least 2 characters.');
  run('UPDATE emojis SET name = ? WHERE id = ?', name, e.id);
  gateway.toServer(s.id, 'emojis_update', { server_id: s.id, emojis: all('SELECT * FROM emojis WHERE server_id = ? ORDER BY name', s.id).map(ser.emoji) });
  res.json({ ok: true });
}));

r.delete('/servers/:id/emojis/:eid', h((req, res) => {
  const s = loadServer(req, P.MANAGE_EMOJIS);
  const e = get('SELECT * FROM emojis WHERE id = ? AND server_id = ?', toId(req.params.eid), s.id);
  if (!e) fail(404, 'Emoji not found.');
  run('DELETE FROM emojis WHERE id = ?', e.id);
  // Keep the file: old messages may still reference it.
  audit(s.id, req.user.id, 'emoji_delete', e.id, { name: e.name });
  gateway.toServer(s.id, 'emojis_update', { server_id: s.id, emojis: all('SELECT * FROM emojis WHERE server_id = ? ORDER BY name', s.id).map(ser.emoji) });
  res.json({ ok: true });
}));

// ---------- Audit log ----------
r.get('/servers/:id/audit-log', h((req, res) => {
  const s = loadServer(req, P.VIEW_AUDIT_LOG);
  const before = toId(req.query.before) || Number.MAX_SAFE_INTEGER;
  res.json(all('SELECT * FROM audit_log WHERE server_id = ? AND id < ? ORDER BY id DESC LIMIT 50', s.id, before).map((a) => ({
    id: a.id, user: ser.userById(a.user_id), action: a.action, target: a.target,
    target_user: /^member_/.test(a.action) || a.action === 'owner_transfer' ? ser.userById(toId(a.target)) : null,
    details: a.details ? JSON.parse(a.details) : null, created_at: a.created_at,
  })));
}));

// ---------- Channels ----------
const CHANNEL_TYPES = ['text', 'voice', 'category', 'announcement'];
const channelName = (type, v) => {
  let name = str(v, { min: 1, max: 100, name: 'Channel name' });
  if (type === 'text' || type === 'announcement') name = name.toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}\p{Emoji_Presentation}_-]/gu, '').slice(0, 100) || 'channel';
  return name;
};

r.post('/servers/:id/channels', h((req, res) => {
  const s = loadServer(req, P.MANAGE_CHANNELS);
  const type = CHANNEL_TYPES.includes(req.body.type) ? req.body.type : 'text';
  if (get('SELECT COUNT(*) AS n FROM channels WHERE server_id = ?', s.id).n >= 500) fail(400, 'Servers can have up to 500 channels.');
  const name = channelName(type, req.body.name);
  let parent = toId(req.body.parent_id) || null;
  if (parent && (type === 'category' || !get("SELECT 1 FROM channels WHERE id = ? AND server_id = ? AND type = 'category'", parent, s.id))) parent = null;
  const id = newId();
  const pos = (get('SELECT MAX(position) AS p FROM channels WHERE server_id = ? AND parent_id IS ?', s.id, parent)?.p ?? -1) + 1;
  tx(() => {
    run('INSERT INTO channels (id, server_id, type, name, topic, parent_id, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id, s.id, type, name, str(req.body.topic, { max: 1024, name: 'Topic' }), parent, pos, Date.now());
    if (req.body.private) {
      const everyone = get('SELECT id FROM roles WHERE server_id = ? AND is_default = 1', s.id);
      run("INSERT INTO channel_overwrites (channel_id, target_type, target_id, allow, deny) VALUES (?, 'role', ?, 0, ?)", id, everyone.id, P.VIEW_CHANNELS);
      run("INSERT INTO channel_overwrites (channel_id, target_type, target_id, allow, deny) VALUES (?, 'member', ?, ?, 0)", id, req.user.id, P.VIEW_CHANNELS);
    }
  });
  audit(s.id, req.user.id, 'channel_create', id, { name, type });
  refresh(s.id);
  res.json(ser.channel(get('SELECT * FROM channels WHERE id = ?', id)));
}));

// Reorder: body.channels = [{id, position, parent_id}]
r.put('/servers/:id/channels', h((req, res) => {
  const s = loadServer(req, P.MANAGE_CHANNELS);
  const items = Array.isArray(req.body.channels) ? req.body.channels : [];
  tx(() => {
    for (const it of items) {
      const c = get('SELECT * FROM channels WHERE id = ? AND server_id = ?', toId(it.id), s.id);
      if (!c) continue;
      let parent = 'parent_id' in it ? toId(it.parent_id) || null : c.parent_id;
      if (c.type === 'category') parent = null;
      if (parent && !get("SELECT 1 FROM channels WHERE id = ? AND server_id = ? AND type = 'category'", parent, s.id)) parent = c.parent_id;
      run('UPDATE channels SET position = ?, parent_id = ? WHERE id = ?', Number(it.position) || 0, parent, c.id);
    }
  });
  refresh(s.id);
  res.json({ ok: true });
}));

module.exports = r;
module.exports.serverPayload = serverPayload;
module.exports.refresh = refresh;
module.exports.audit = audit;
