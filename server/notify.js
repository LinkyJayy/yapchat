'use strict';
const { get, all, run } = require('./db');
const presence = require('./presence');
const push = require('./push');
const gateway = require('./gateway');

function displayName(u) { return u.display_name || u.username; }

function isBlocked(userId, otherId) {
  return !!get("SELECT 1 FROM relationships WHERE user_id = ? AND other_id = ? AND type = 'blocked'", userId, otherId);
}

function setting(userId, targetId) {
  return get('SELECT level, muted FROM notify_settings WHERE user_id = ? AND target_id = ?', userId, targetId);
}

// Decide whether a recipient should be notified about a message.
function shouldNotify(userId, msg, ch, mentioned) {
  if (isBlocked(userId, msg.author_id)) return false;
  if (!ch.server_id) {
    const s = setting(userId, ch.id);
    return !(s && s.muted);
  }
  const cs = setting(userId, ch.id);
  const ss = setting(userId, ch.server_id);
  if (ss?.muted || cs?.muted) return false;
  let level = cs?.level || ss?.level;
  if (!level) {
    const n = get('SELECT COUNT(*) AS n FROM members WHERE server_id = ?', ch.server_id).n;
    level = n <= 50 ? 'all' : 'mentions';
  }
  if (level === 'none') return false;
  if (level === 'mentions') return mentioned;
  return true;
}

function preview(msg, mentionNames) {
  let text = msg.content || '';
  text = text.replace(/<@!?(\d+)>/g, (_, id) => '@' + (mentionNames.get(Number(id)) || 'user'))
    .replace(/<@&(\d+)>/g, (_, id) => '@' + (get('SELECT name FROM roles WHERE id = ?', Number(id))?.name || 'role'))
    .replace(/<#(\d+)>/g, (_, id) => '#' + (get('SELECT name FROM channels WHERE id = ?', Number(id))?.name || 'channel'))
    .replace(/<a?:(\w+):\d+>/g, ':$1:')
    .replace(/\|\|[\s\S]+?\|\|/g, '[spoiler]');
  if (msg.type === 'poll') text = '📊 Poll: ' + text;
  if (!text) {
    const att = JSON.parse(msg.attachments || '[]');
    if (att.length) text = att[0].kind === 'image' ? '📷 Image' : att[0].kind === 'video' ? '🎬 Video' : '📎 ' + att[0].name;
  }
  return text.length > 180 ? text.slice(0, 177) + '…' : text;
}

// Called after a message is created. recipients: users who can view the channel.
function onMessage(msg, ch, recipients, { mentionedUsers, mentionedRoles, everyone }) {
  const author = get('SELECT * FROM users WHERE id = ?', msg.author_id);
  if (!author) return;
  const server = ch.server_id ? get('SELECT id, name, icon FROM servers WHERE id = ?', ch.server_id) : null;
  const names = new Map();
  for (const id of mentionedUsers) {
    const u = get('SELECT username, display_name FROM users WHERE id = ?', id);
    if (u) names.set(id, displayName(u));
  }
  const body = preview(msg, names);
  let title;
  if (!ch.server_id) title = ch.type === 'group' ? `${displayName(author)} (${ch.name || 'Group'})` : displayName(author);
  else title = `${displayName(author)} (#${ch.name}, ${server.name})`;

  for (const uid of recipients) {
    if (uid === msg.author_id) continue;
    let mentioned = mentionedUsers.includes(uid) || everyone;
    if (!mentioned && mentionedRoles.length) {
      mentioned = !!get(
        `SELECT 1 FROM member_roles WHERE server_id = ? AND user_id = ? AND role_id IN (${mentionedRoles.map(() => '?').join(',')})`,
        ch.server_id, uid, ...mentionedRoles
      );
    }
    if (mentioned || !ch.server_id) {
      if (!isBlocked(uid, msg.author_id)) {
        run(`INSERT INTO read_states (user_id, channel_id, last_read_id, mention_count) VALUES (?, ?, 0, 1)
             ON CONFLICT(user_id, channel_id) DO UPDATE SET mention_count = mention_count + 1`, uid, ch.id);
        const rs = get('SELECT channel_id, last_read_id, mention_count FROM read_states WHERE user_id = ? AND channel_id = ?', uid, ch.id);
        gateway.toUser(uid, 'read_state', rs);
      }
    }
    if (!shouldNotify(uid, msg, ch, mentioned)) continue;
    const payload = {
      type: 'message', title, body, icon: author.avatar || '/icons/icon-192.png',
      tag: `ch-${ch.id}`, channel_id: ch.id, server_id: ch.server_id, message_id: msg.id,
      url: ch.server_id ? `/channels/${ch.server_id}/${ch.id}` : `/channels/@me/${ch.id}`,
      mentioned,
    };
    const active = presence.isActive(uid);
    gateway.toUser(uid, 'notify', { ...payload, quiet: active });
    if (!active) push.send(uid, payload).catch(() => {});
  }
}

function callNotify(ch, callerId) {
  const caller = get('SELECT * FROM users WHERE id = ?', callerId);
  for (const r of all('SELECT user_id FROM dm_members WHERE channel_id = ? AND user_id != ?', ch.id, callerId)) {
    if (isBlocked(r.user_id, callerId)) continue;
    const s = setting(r.user_id, ch.id);
    if (s?.muted) continue;
    const payload = {
      type: 'call', title: `${displayName(caller)} is calling you`, body: 'Tap to join the call.',
      icon: caller.avatar || '/icons/icon-192.png', tag: `call-${ch.id}`, channel_id: ch.id,
      url: `/channels/@me/${ch.id}?call=1`,
    };
    if (!presence.isActive(r.user_id)) push.send(r.user_id, payload).catch(() => {});
  }
}

module.exports = { onMessage, callNotify, isBlocked };
