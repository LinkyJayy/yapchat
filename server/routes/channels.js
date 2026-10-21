'use strict';
const express = require('express');
const { get, all, run, newId, tx } = require('../db');
const { h, fail, str, toId, rateLimit, parseJSON, isEmoji } = require('../util');
const { requireAuth } = require('../auth');
const { P, ALL, channelPermissions, serverPermissions, has } = require('../permissions');
const ser = require('../serialize');
const gateway = require('../gateway');
const uploads = require('../uploads');
const config = require('../config');
const notify = require('../notify');
const servers = require('./servers');

const r = express.Router();
r.use(requireAuth);

const MAX_CONTENT = 4000;
const MAX_ATTACHMENTS = 10;
const slowmodeHits = new Map(); // `${channel}:${user}` -> timestamp

function loadChannel(req, perm, id = req.params.id) {
  const ch = get('SELECT * FROM channels WHERE id = ?', toId(id));
  if (!ch) fail(404, 'Channel not found.');
  const perms = channelPermissions(ch, req.user.id);
  if (!has(perms, P.VIEW_CHANNELS)) fail(404, 'Channel not found.');
  if (perm && !has(perms, perm)) fail(403, "You don't have permission to do that.");
  req.perms = perms;
  return ch;
}

function loadMessage(req, ch) {
  const m = get('SELECT * FROM messages WHERE id = ? AND channel_id = ?', toId(req.params.mid), ch.id);
  if (!m) fail(404, 'Message not found.');
  return m;
}

const broadcastMessage = (ch, m, event = 'message_update') => gateway.toChannel(ch, event, ser.message(get('SELECT * FROM messages WHERE id = ?', m.id)));

// ---------- Channel management ----------
r.patch('/channels/:id', h((req, res) => {
  const ch = loadChannel(req);
  const b = req.body || {};
  const sets = {};
  if (!ch.server_id) {
    if (ch.type !== 'group') fail(400, "DMs can't be edited.");
    if ('name' in b) sets.name = str(b.name, { max: 100, name: 'Group name' }) || null;
  } else {
    if (!has(req.perms, P.MANAGE_CHANNELS)) fail(403, "You don't have permission to manage this channel.");
    if ('name' in b) {
      sets.name = str(b.name, { min: 1, max: 100, name: 'Channel name' });
      if (ch.type === 'text' || ch.type === 'announcement') sets.name = sets.name.toLowerCase().replace(/\s+/g, '-');
    }
    if ('topic' in b) sets.topic = str(b.topic, { max: 1024, name: 'Topic' });
    if ('slowmode' in b) sets.slowmode = Math.min(Math.max(Number(b.slowmode) || 0, 0), 21600);
    if ('type' in b && ['text', 'announcement'].includes(b.type) && ['text', 'announcement'].includes(ch.type)) sets.type = b.type;
    if ('parent_id' in b && ch.type !== 'category') {
      const p = toId(b.parent_id) || null;
      if (p && !get("SELECT 1 FROM channels WHERE id = ? AND server_id = ? AND type = 'category'", p, ch.server_id)) fail(400, 'Invalid category.');
      sets.parent_id = p;
    }
  }
  const keys = Object.keys(sets);
  if (keys.length) run(`UPDATE channels SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => sets[k]), ch.id);
  if (ch.server_id) {
    if (keys.length) servers.audit(ch.server_id, req.user.id, 'channel_update', ch.id, { name: ch.name, changed: keys });
    servers.refresh(ch.server_id);
  } else {
    const c = get('SELECT * FROM channels WHERE id = ?', ch.id);
    for (const u of gateway.channelViewers(c)) gateway.toUser(u, 'dm_update', ser.dmChannel(c, u));
  }
  res.json(ser.channel(get('SELECT * FROM channels WHERE id = ?', ch.id)));
}));

r.delete('/channels/:id', h((req, res) => {
  const ch = loadChannel(req);
  if (!ch.server_id) {
    // Closing a DM / leaving a group.
    if (ch.type === 'group') {
      run('DELETE FROM dm_members WHERE channel_id = ? AND user_id = ?', ch.id, req.user.id);
      const left = all('SELECT user_id FROM dm_members WHERE channel_id = ?', ch.id);
      if (!left.length) run('DELETE FROM channels WHERE id = ?', ch.id);
      else {
        if (ch.owner_id === req.user.id) run('UPDATE channels SET owner_id = ? WHERE id = ?', left[0].user_id, ch.id);
        const c = get('SELECT * FROM channels WHERE id = ?', ch.id);
        for (const u of left) gateway.toUser(u.user_id, 'dm_update', ser.dmChannel(c, u.user_id));
      }
    } else run('UPDATE dm_members SET closed = 1 WHERE channel_id = ? AND user_id = ?', ch.id, req.user.id);
    gateway.toUser(req.user.id, 'dm_delete', { id: ch.id });
    return res.json({ ok: true });
  }
  if (!has(req.perms, P.MANAGE_CHANNELS)) fail(403, "You don't have permission to delete this channel.");
  tx(() => {
    if (ch.type === 'category') run('UPDATE channels SET parent_id = NULL WHERE parent_id = ?', ch.id);
    run('DELETE FROM channels WHERE id = ?', ch.id);
    run('UPDATE servers SET system_channel_id = NULL WHERE system_channel_id = ?', ch.id);
  });
  servers.audit(ch.server_id, req.user.id, 'channel_delete', ch.id, { name: ch.name });
  servers.refresh(ch.server_id);
  res.json({ ok: true });
}));

// Group DM membership.
r.put('/channels/:id/recipients/:uid', h((req, res) => {
  const ch = loadChannel(req);
  if (ch.type !== 'group') fail(400, 'Not a group DM.');
  const uid = toId(req.params.uid);
  if (!get("SELECT 1 FROM relationships WHERE user_id = ? AND other_id = ? AND type = 'friend'", req.user.id, uid)) fail(403, 'You can only add friends.');
  if (get('SELECT COUNT(*) AS n FROM dm_members WHERE channel_id = ?', ch.id).n >= 10) fail(400, 'Group DMs can have up to 10 members.');
  run('INSERT OR IGNORE INTO dm_members (channel_id, user_id) VALUES (?, ?)', ch.id, uid);
  const c = get('SELECT * FROM channels WHERE id = ?', ch.id);
  for (const u of gateway.channelViewers(c)) gateway.toUser(u, u === uid ? 'dm_create' : 'dm_update', ser.dmChannel(c, u));
  res.json({ ok: true });
}));

r.delete('/channels/:id/recipients/:uid', h((req, res) => {
  const ch = loadChannel(req);
  if (ch.type !== 'group' || ch.owner_id !== req.user.id) fail(403, 'Only the group owner can remove people.');
  const uid = toId(req.params.uid);
  run('DELETE FROM dm_members WHERE channel_id = ? AND user_id = ?', ch.id, uid);
  gateway.toUser(uid, 'dm_delete', { id: ch.id });
  const c = get('SELECT * FROM channels WHERE id = ?', ch.id);
  for (const u of gateway.channelViewers(c)) gateway.toUser(u, 'dm_update', ser.dmChannel(c, u));
  res.json({ ok: true });
}));

// Permission overwrites.
r.put('/channels/:id/overwrites/:type/:tid', h((req, res) => {
  const ch = loadChannel(req);
  if (!ch.server_id) fail(400, 'Not a server channel.');
  const sp = serverPermissions(ch.server_id, req.user.id);
  if (!has(req.perms, P.MANAGE_ROLES) && !has(sp, P.MANAGE_ROLES)) fail(403, "You don't have permission to edit channel permissions.");
  const type = req.params.type === 'member' ? 'member' : 'role';
  const tid = toId(req.params.tid);
  if (type === 'role' && !get('SELECT 1 FROM roles WHERE id = ? AND server_id = ?', tid, ch.server_id)) fail(404, 'Role not found.');
  if (type === 'member' && !get('SELECT 1 FROM members WHERE user_id = ? AND server_id = ?', tid, ch.server_id)) fail(404, 'Member not found.');
  const mask = ALL & ~P.ADMINISTRATOR;
  const allow = (Number(req.body.allow) | 0) & mask, deny = (Number(req.body.deny) | 0) & mask;
  const server = get('SELECT owner_id FROM servers WHERE id = ?', ch.server_id);
  if (server.owner_id !== req.user.id) {
    // Non-owners can only allow or deny permissions they have themselves.
    const prev = get('SELECT allow, deny FROM channel_overwrites WHERE channel_id = ? AND target_type = ? AND target_id = ?', ch.id, type, tid) || { allow: 0, deny: 0 };
    const changed = (prev.allow ^ allow) | (prev.deny ^ deny);
    if (changed & ~req.perms) fail(403, "You can't change permissions you don't have.");
  }
  if (!allow && !deny) run('DELETE FROM channel_overwrites WHERE channel_id = ? AND target_type = ? AND target_id = ?', ch.id, type, tid);
  else run(`INSERT INTO channel_overwrites (channel_id, target_type, target_id, allow, deny) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(channel_id, target_type, target_id) DO UPDATE SET allow = excluded.allow, deny = excluded.deny`, ch.id, type, tid, allow, deny);
  servers.audit(ch.server_id, req.user.id, 'channel_permissions', ch.id, { name: ch.name, type, target: tid });
  servers.refresh(ch.server_id);
  res.json({ ok: true });
}));

// ---------- Messages ----------
r.get('/channels/:id/messages', h((req, res) => {
  const ch = loadChannel(req, P.READ_HISTORY);
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
  let rows;
  if (req.query.around) {
    const around = toId(req.query.around);
    const before = all('SELECT * FROM messages WHERE channel_id = ? AND id < ? ORDER BY id DESC LIMIT ?', ch.id, around, Math.floor(limit / 2));
    const after = all('SELECT * FROM messages WHERE channel_id = ? AND id >= ? ORDER BY id ASC LIMIT ?', ch.id, around, Math.ceil(limit / 2));
    rows = [...before.reverse(), ...after];
  } else if (req.query.after) {
    rows = all('SELECT * FROM messages WHERE channel_id = ? AND id > ? ORDER BY id ASC LIMIT ?', ch.id, toId(req.query.after), limit);
  } else {
    const before = toId(req.query.before) || Number.MAX_SAFE_INTEGER;
    rows = all('SELECT * FROM messages WHERE channel_id = ? AND id < ? ORDER BY id DESC LIMIT ?', ch.id, before, limit).reverse();
  }
  const cache = new Map();
  res.json(rows.map((m) => ser.message(m, cache)));
}));

function parseMentions(content, ch, perms) {
  const users = new Set(), roles = new Set();
  for (const m of content.matchAll(/<@!?(\d+)>/g)) users.add(Number(m[1]));
  for (const m of content.matchAll(/<@&(\d+)>/g)) roles.add(Number(m[1]));
  const validUsers = [...users].filter((id) => ch.server_id
    ? get('SELECT 1 FROM members WHERE server_id = ? AND user_id = ?', ch.server_id, id)
    : get('SELECT 1 FROM dm_members WHERE channel_id = ? AND user_id = ?', ch.id, id));
  const validRoles = ch.server_id
    ? [...roles].filter((id) => {
      const role = get('SELECT mentionable FROM roles WHERE id = ? AND server_id = ? AND is_default = 0', id, ch.server_id);
      return role && (role.mentionable || has(perms, P.MENTION_EVERYONE));
    })
    : [];
  const everyone = ch.server_id ? /(^|[^`\w])@(everyone|here)\b/.test(content) && has(perms, P.MENTION_EVERYONE) : false;
  return { users: validUsers, roles: validRoles, everyone };
}

const msgUpload = uploads.memory(config.maxUploadBytes, MAX_ATTACHMENTS).array('files', MAX_ATTACHMENTS);

r.post('/channels/:id/messages', msgUpload, h((req, res) => {
  const ch = loadChannel(req, P.SEND_MESSAGES);
  if (ch.type === 'category' || ch.type === 'voice') fail(400, "You can't send messages here.");
  if (ch.type === 'announcement' && !has(req.perms, P.MANAGE_MESSAGES)) fail(403, 'Only moderators can post in announcement channels.');
  const uid = req.user.id;
  rateLimit(`msg:${uid}`, 10, 5000);
  if (ch.type === 'dm') {
    const other = get('SELECT user_id FROM dm_members WHERE channel_id = ? AND user_id != ?', ch.id, uid);
    if (other && notify.isBlocked(other.user_id, uid)) fail(403, "Your message could not be delivered. This user isn't accepting messages from you.");
    if (other && notify.isBlocked(uid, other.user_id)) fail(403, 'You blocked this user. Unblock them to send messages.');
  }
  if (ch.slowmode && !has(req.perms, P.MANAGE_MESSAGES) && !has(req.perms, P.MANAGE_CHANNELS)) {
    const key = `${ch.id}:${uid}`;
    const last = slowmodeHits.get(key) || 0;
    const wait = last + ch.slowmode * 1000 - Date.now();
    if (wait > 0) fail(429, `Slowmode is on. Wait ${Math.ceil(wait / 1000)}s.`);
    slowmodeHits.set(key, Date.now());
  }
  const body = req.body || {};
  const content = str(body.content, { max: MAX_CONTENT, name: 'Message', trim: false }).replace(/^\s+$/, '');
  const files = req.files || [];
  if (files.length && !has(req.perms, P.ATTACH_FILES)) fail(403, "You don't have permission to attach files here.");
  let poll = null;
  if (body.poll) {
    if (!has(req.perms, P.CREATE_POLLS)) fail(403, "You don't have permission to create polls here.");
    poll = typeof body.poll === 'string' ? parseJSON(body.poll, null) : body.poll;
    if (!poll || typeof poll !== 'object') fail(400, 'Invalid poll.');
    poll.question = str(poll.question, { min: 1, max: 300, name: 'Poll question' });
    if (!Array.isArray(poll.options) || poll.options.length < 2 || poll.options.length > 10) fail(400, 'Polls need 2–10 answers.');
    poll.options = poll.options.map((o) => ({
      text: str(o?.text, { min: 1, max: 55, name: 'Answer' }),
      emoji: o?.emoji && isEmoji(o.emoji) ? o.emoji : null,
    }));
    const hours = Number(poll.duration) || 24;
    if (![1, 4, 8, 24, 72, 168, 336].includes(hours)) fail(400, 'Invalid poll duration.');
    poll.expires_at = Date.now() + hours * 3600_000;
  }
  if (!content.trim() && !files.length && !poll) fail(400, 'Message is empty.');
  let replyTo = toId(body.reply_to) || null;
  if (replyTo && !get('SELECT 1 FROM messages WHERE id = ? AND channel_id = ?', replyTo, ch.id)) replyTo = null;
  const attachments = files.map((f) => uploads.store(f));
  const mentions = parseMentions(content, ch, req.perms);
  // Reply pings the replied-to author unless disabled.
  if (replyTo && body.mention_reply !== 'false' && body.mention_reply !== false) {
    const ra = get('SELECT author_id FROM messages WHERE id = ?', replyTo)?.author_id;
    if (ra && ra !== uid && !mentions.users.includes(ra)) mentions.users.push(ra);
  }
  const id = newId();
  const now = Date.now();
  tx(() => {
    run(`INSERT INTO messages (id, channel_id, author_id, type, content, attachments, reply_to, mentions, mention_roles, mention_everyone, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, ch.id, uid, poll ? 'poll' : replyTo ? 'reply' : 'default', poll ? poll.question : content, JSON.stringify(attachments), replyTo,
      JSON.stringify(mentions.users), JSON.stringify(mentions.roles), mentions.everyone ? 1 : 0, now);
    if (poll) run('INSERT INTO polls (message_id, question, options, multi, expires_at) VALUES (?, ?, ?, ?, ?)', id, poll.question, JSON.stringify(poll.options), poll.multi ? 1 : 0, poll.expires_at);
    run('UPDATE channels SET last_message_id = ? WHERE id = ?', id, ch.id);
    run(`INSERT INTO read_states (user_id, channel_id, last_read_id, mention_count) VALUES (?, ?, ?, 0)
         ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_id = excluded.last_read_id, mention_count = 0`, uid, ch.id, id);
  });
  if (!ch.server_id) {
    // Re-open closed DMs for everyone.
    const reopened = all('SELECT user_id FROM dm_members WHERE channel_id = ? AND closed = 1', ch.id);
    run('UPDATE dm_members SET closed = 0 WHERE channel_id = ?', ch.id);
    const c = get('SELECT * FROM channels WHERE id = ?', ch.id);
    for (const x of reopened) gateway.toUser(x.user_id, 'dm_create', ser.dmChannel(c, x.user_id));
  }
  const row = get('SELECT * FROM messages WHERE id = ?', id);
  const msg = ser.message(row);
  if (body.nonce) msg.nonce = String(body.nonce).slice(0, 64);
  gateway.toChannel(ch, 'message_create', msg);
  gateway.toUser(uid, 'read_state', { channel_id: ch.id, last_read_id: id, mention_count: 0 });
  const viewers = gateway.channelViewers(ch);
  notify.onMessage(row, ch, viewers, { mentionedUsers: mentions.users, mentionedRoles: mentions.roles, everyone: mentions.everyone });
  res.json(msg);
}));

r.patch('/channels/:id/messages/:mid', h((req, res) => {
  const ch = loadChannel(req);
  const m = loadMessage(req, ch);
  if (m.author_id !== req.user.id) fail(403, 'You can only edit your own messages.');
  if (m.type === 'system') fail(400, "System messages can't be edited.");
  const content = str(req.body.content, { max: MAX_CONTENT, name: 'Message', trim: false });
  if (!content.trim() && m.attachments === '[]') fail(400, 'Message is empty. Delete it instead.');
  if (m.type === 'poll') fail(400, "Polls can't be edited.");
  const mentions = parseMentions(content, ch, req.perms);
  run('UPDATE messages SET content = ?, edited_at = ?, mentions = ?, mention_roles = ?, mention_everyone = ? WHERE id = ?',
    content, Date.now(), JSON.stringify(mentions.users), JSON.stringify(mentions.roles), mentions.everyone ? 1 : 0, m.id);
  broadcastMessage(ch, m);
  res.json({ ok: true });
}));

r.delete('/channels/:id/messages/:mid', h((req, res) => {
  const ch = loadChannel(req);
  const m = loadMessage(req, ch);
  if (m.author_id !== req.user.id && !(ch.server_id && has(req.perms, P.MANAGE_MESSAGES))) fail(403, "You can't delete this message.");
  run('DELETE FROM messages WHERE id = ?', m.id);
  for (const a of parseJSON(m.attachments, [])) uploads.removeUpload(a.url);
  if (ch.last_message_id === m.id) {
    run('UPDATE channels SET last_message_id = (SELECT MAX(id) FROM messages WHERE channel_id = ?) WHERE id = ?', ch.id, ch.id);
  }
  if (m.author_id !== req.user.id && ch.server_id) servers.audit(ch.server_id, req.user.id, 'message_delete', m.author_id, { channel: ch.name });
  gateway.toChannel(ch, 'message_delete', { id: m.id, channel_id: ch.id });
  res.json({ ok: true });
}));

// Bulk delete (purge) for moderators.
r.post('/channels/:id/messages/bulk-delete', h((req, res) => {
  const ch = loadChannel(req, P.MANAGE_MESSAGES);
  if (!ch.server_id) fail(400, 'Not available in DMs.');
  const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(toId).slice(0, 100);
  for (const id of ids) {
    const m = get('SELECT * FROM messages WHERE id = ? AND channel_id = ?', id, ch.id);
    if (!m) continue;
    run('DELETE FROM messages WHERE id = ?', id);
    gateway.toChannel(ch, 'message_delete', { id, channel_id: ch.id });
  }
  servers.audit(ch.server_id, req.user.id, 'message_bulk_delete', ch.id, { count: ids.length, channel: ch.name });
  res.json({ ok: true });
}));

// ---------- Pins ----------
r.get('/channels/:id/pins', h((req, res) => {
  const ch = loadChannel(req, P.READ_HISTORY);
  const cache = new Map();
  res.json(all('SELECT * FROM messages WHERE channel_id = ? AND pinned = 1 ORDER BY id DESC', ch.id).map((m) => ser.message(m, cache)));
}));

function pin(req, res, value) {
  const ch = loadChannel(req);
  if (ch.server_id && !has(req.perms, P.MANAGE_MESSAGES)) fail(403, "You don't have permission to pin messages.");
  const m = loadMessage(req, ch);
  if (value && get('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ? AND pinned = 1', ch.id).n >= 250) fail(400, 'This channel has hit the 250 pin limit.');
  run('UPDATE messages SET pinned = ? WHERE id = ?', value ? 1 : 0, m.id);
  broadcastMessage(ch, m);
  if (value) {
    const id = newId();
    run("INSERT INTO messages (id, channel_id, author_id, type, content, reply_to, created_at) VALUES (?, ?, ?, 'system', 'pin', ?, ?)", id, ch.id, req.user.id, m.id, Date.now());
    run('UPDATE channels SET last_message_id = ? WHERE id = ?', id, ch.id);
    gateway.toChannel(ch, 'message_create', ser.message(get('SELECT * FROM messages WHERE id = ?', id)));
  }
  res.json({ ok: true });
}
r.put('/channels/:id/pins/:mid', h((req, res) => pin(req, res, true)));
r.delete('/channels/:id/pins/:mid', h((req, res) => pin(req, res, false)));

// ---------- Reactions ----------
function normalizeEmoji(req, raw) {
  const e = String(raw || '');
  const m = /^c:(\d+)$/.exec(e);
  if (m) {
    const em = get('SELECT * FROM emojis WHERE id = ?', Number(m[1]));
    if (!em) fail(400, 'Unknown emoji.');
    return e;
  }
  if (!isEmoji(e)) fail(400, 'Invalid emoji.');
  return e;
}

r.put('/channels/:id/messages/:mid/reactions/:emoji', h((req, res) => {
  const ch = loadChannel(req, P.READ_HISTORY);
  const m = loadMessage(req, ch);
  const emoji = normalizeEmoji(req, req.params.emoji);
  const exists = get('SELECT 1 FROM reactions WHERE message_id = ? AND emoji = ? LIMIT 1', m.id, emoji);
  if (!exists && !has(req.perms, P.ADD_REACTIONS)) fail(403, "You don't have permission to add reactions.");
  if (!exists && get('SELECT COUNT(DISTINCT emoji) AS n FROM reactions WHERE message_id = ?', m.id).n >= 20) fail(400, 'Maximum number of reactions reached (20).');
  rateLimit(`react:${req.user.id}`, 20, 5000);
  run('INSERT OR IGNORE INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)', m.id, req.user.id, emoji, Date.now());
  gateway.toChannel(ch, 'reactions_update', { channel_id: ch.id, message_id: m.id, reactions: ser.reactionsFor(m.id) });
  res.json({ ok: true });
}));

r.delete('/channels/:id/messages/:mid/reactions/:emoji{/:uid}', h((req, res) => {
  const ch = loadChannel(req);
  const m = loadMessage(req, ch);
  const target = req.params.uid ? toId(req.params.uid) : req.user.id;
  if (target !== req.user.id && !(ch.server_id && has(req.perms, P.MANAGE_MESSAGES))) fail(403, "You can't remove other people's reactions.");
  const emoji = String(req.params.emoji);
  if (req.params.uid === 'all') run('DELETE FROM reactions WHERE message_id = ? AND emoji = ?', m.id, emoji);
  else run('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', m.id, target, emoji);
  gateway.toChannel(ch, 'reactions_update', { channel_id: ch.id, message_id: m.id, reactions: ser.reactionsFor(m.id) });
  res.json({ ok: true });
}));

// ---------- Polls ----------
r.put('/channels/:id/messages/:mid/poll', h((req, res) => {
  const ch = loadChannel(req, P.READ_HISTORY);
  const m = loadMessage(req, ch);
  const p = ser.pollFor(m.id);
  if (!p) fail(404, 'Not a poll.');
  if (p.ended) fail(400, 'This poll has ended.');
  let answers = (Array.isArray(req.body.answers) ? req.body.answers : []).map(Number).filter((i) => Number.isInteger(i) && i >= 0 && i < p.options.length);
  answers = [...new Set(answers)];
  if (!p.multi && answers.length > 1) answers = answers.slice(0, 1);
  tx(() => {
    run('DELETE FROM poll_votes WHERE message_id = ? AND user_id = ?', m.id, req.user.id);
    for (const a of answers) run('INSERT INTO poll_votes (message_id, user_id, option_index) VALUES (?, ?, ?)', m.id, req.user.id, a);
  });
  gateway.toChannel(ch, 'poll_update', { channel_id: ch.id, message_id: m.id, poll: ser.pollFor(m.id) });
  res.json({ ok: true });
}));

r.post('/channels/:id/messages/:mid/poll/end', h((req, res) => {
  const ch = loadChannel(req);
  const m = loadMessage(req, ch);
  if (m.author_id !== req.user.id && !(ch.server_id && has(req.perms, P.MANAGE_MESSAGES))) fail(403, "You can't end this poll.");
  run('UPDATE polls SET ended = 1 WHERE message_id = ?', m.id);
  gateway.toChannel(ch, 'poll_update', { channel_id: ch.id, message_id: m.id, poll: ser.pollFor(m.id) });
  res.json({ ok: true });
}));

// ---------- Read states ----------
r.post('/channels/:id/ack', h((req, res) => {
  const ch = loadChannel(req);
  const mid = toId(req.body?.message_id) || ch.last_message_id || 0;
  run(`INSERT INTO read_states (user_id, channel_id, last_read_id, mention_count) VALUES (?, ?, ?, 0)
       ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id), mention_count = 0`, req.user.id, ch.id, mid);
  gateway.toUser(req.user.id, 'read_state', { channel_id: ch.id, last_read_id: mid, mention_count: 0 });
  res.json({ ok: true });
}));

// Mark a message as unread.
r.post('/channels/:id/unread', h((req, res) => {
  const ch = loadChannel(req);
  const mid = Math.max(toId(req.body?.message_id) - 1, 0);
  run(`INSERT INTO read_states (user_id, channel_id, last_read_id, mention_count) VALUES (?, ?, ?, 0)
       ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_id = excluded.last_read_id`, req.user.id, ch.id, mid);
  gateway.toUser(req.user.id, 'read_state', { channel_id: ch.id, last_read_id: mid, mention_count: 0, manual: true });
  res.json({ ok: true });
}));

r.post('/servers/:sid/ack', h((req, res) => {
  const sid = toId(req.params.sid);
  for (const ch of all('SELECT * FROM channels WHERE server_id = ? AND last_message_id IS NOT NULL', sid)) {
    if (!has(channelPermissions(ch, req.user.id), P.VIEW_CHANNELS)) continue;
    run(`INSERT INTO read_states (user_id, channel_id, last_read_id, mention_count) VALUES (?, ?, ?, 0)
         ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_id = excluded.last_read_id, mention_count = 0`, req.user.id, ch.id, ch.last_message_id);
    gateway.toUser(req.user.id, 'read_state', { channel_id: ch.id, last_read_id: ch.last_message_id, mention_count: 0 });
  }
  res.json({ ok: true });
}));

// ---------- Search ----------
r.get('/search', h((req, res) => {
  rateLimit(`search:${req.user.id}`, 30, 60_000);
  const q = String(req.query.q || '').trim().slice(0, 200);
  const sid = toId(req.query.server_id);
  const cid = toId(req.query.channel_id);
  const author = toId(req.query.author_id);
  const has_ = String(req.query.has || '');
  let channels;
  if (sid) channels = all('SELECT * FROM channels WHERE server_id = ?', sid);
  else if (cid) channels = [get('SELECT * FROM channels WHERE id = ?', cid)].filter(Boolean);
  else fail(400, 'Choose where to search.');
  const ids = channels.filter((c) => has(channelPermissions(c, req.user.id), P.VIEW_CHANNELS | P.READ_HISTORY)).map((c) => c.id);
  if (!ids.length) return res.json({ total: 0, results: [] });
  const where = [`channel_id IN (${ids.map(() => '?').join(',')})`, "type != 'system'"];
  const params = [...ids];
  if (q) { where.push("content LIKE ? ESCAPE '\\'"); params.push(`%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`); }
  if (author) { where.push('author_id = ?'); params.push(author); }
  if (has_ === 'file' || has_ === 'image') { where.push("attachments != '[]'"); }
  if (has_ === 'poll') where.push("type = 'poll'");
  if (has_ === 'pin') where.push('pinned = 1');
  const total = get(`SELECT COUNT(*) AS n FROM messages WHERE ${where.join(' AND ')}`, ...params).n;
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const rows = all(`SELECT * FROM messages WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 25 OFFSET ?`, ...params, offset);
  const cache = new Map();
  res.json({ total, results: rows.map((m) => ser.message(m, cache)) });
}));

// Mentions inbox.
r.get('/mentions', h((req, res) => {
  const uid = req.user.id;
  const rows = all(
    `SELECT m.* FROM messages m JOIN channels c ON c.id = m.channel_id
     LEFT JOIN members mem ON mem.server_id = c.server_id AND mem.user_id = ?
     LEFT JOIN dm_members d ON d.channel_id = c.id AND d.user_id = ?
     WHERE (mem.user_id IS NOT NULL OR d.user_id IS NOT NULL) AND m.author_id != ?
       AND (m.mentions LIKE ? OR m.mention_everyone = 1 OR m.mention_roles != '[]')
     ORDER BY m.id DESC LIMIT 200`,
    uid, uid, uid, `%${uid}%`
  );
  const out = [];
  const cache = new Map();
  for (const m of rows) {
    if (out.length >= 50) break;
    const ch = get('SELECT * FROM channels WHERE id = ?', m.channel_id);
    if (!has(channelPermissions(ch, uid), P.VIEW_CHANNELS)) continue;
    const mentions = parseJSON(m.mentions, []);
    let hit = mentions.includes(uid) || !!m.mention_everyone;
    if (!hit) {
      const roles = parseJSON(m.mention_roles, []);
      hit = roles.length > 0 && !!get(`SELECT 1 FROM member_roles WHERE user_id = ? AND role_id IN (${roles.map(() => '?').join(',')})`, uid, ...roles);
    }
    if (hit) out.push(ser.message(m, cache));
  }
  res.json(out);
}));

module.exports = r;
