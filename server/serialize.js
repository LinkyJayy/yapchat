'use strict';
const { get, all } = require('./db');
const { parseJSON } = require('./util');
const presence = require('./presence');

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    display_name: u.display_name || null,
    avatar: u.avatar || null,
    banner: u.banner || null,
    accent_color: u.accent_color || null,
    bio: u.bio || '',
    pronouns: u.pronouns || '',
    custom_status: u.custom_status || null,
    custom_status_emoji: u.custom_status_emoji || null,
    created_at: u.created_at,
    status: presence.statusOf(u),
  };
}

function selfUser(u) {
  return {
    ...publicUser(u),
    email: u.email || null,
    set_status: u.status,
    settings: parseJSON(u.settings, {}),
  };
}

function userById(id) {
  if (!id) return null;
  return publicUser(get('SELECT * FROM users WHERE id = ?', id));
}

function customEmoji(id) {
  const e = get('SELECT id, server_id, name, animated FROM emojis WHERE id = ?', id);
  return e ? { id: e.id, name: e.name, animated: !!e.animated, server_id: e.server_id } : null;
}

function reactionsFor(messageId) {
  const rows = all('SELECT emoji, user_id FROM reactions WHERE message_id = ? ORDER BY created_at', messageId);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.emoji)) map.set(r.emoji, []);
    map.get(r.emoji).push(r.user_id);
  }
  return [...map].map(([emoji, users]) => ({
    emoji,
    users,
    custom: emoji.startsWith('c:') ? customEmoji(Number(emoji.slice(2))) : null,
  }));
}

function pollFor(messageId) {
  const p = get('SELECT * FROM polls WHERE message_id = ?', messageId);
  if (!p) return null;
  const options = parseJSON(p.options, []);
  const votes = options.map(() => []);
  for (const v of all('SELECT user_id, option_index FROM poll_votes WHERE message_id = ?', messageId)) {
    if (votes[v.option_index]) votes[v.option_index].push(v.user_id);
  }
  const ended = !!p.ended || (p.expires_at && p.expires_at <= Date.now());
  return { question: p.question, options, multi: !!p.multi, expires_at: p.expires_at, ended, votes };
}

function message(m, cache = new Map()) {
  const author = (id) => {
    if (!cache.has(id)) cache.set(id, userById(id));
    return cache.get(id);
  };
  let reply = null;
  if (m.reply_to) {
    const r = get('SELECT id, author_id, content, attachments, type FROM messages WHERE id = ?', m.reply_to);
    reply = r
      ? { id: r.id, author: author(r.author_id), content: r.content.slice(0, 300), has_attachments: r.attachments !== '[]', type: r.type }
      : { id: m.reply_to, deleted: true };
  }
  return {
    id: m.id,
    channel_id: m.channel_id,
    author: author(m.author_id) || { id: 0, username: 'deleted_user', display_name: 'Deleted User' },
    type: m.type,
    content: m.content,
    attachments: parseJSON(m.attachments, []),
    reply,
    mentions: parseJSON(m.mentions, []),
    mention_roles: parseJSON(m.mention_roles, []),
    mention_everyone: !!m.mention_everyone,
    pinned: !!m.pinned,
    edited_at: m.edited_at,
    created_at: m.created_at,
    reactions: reactionsFor(m.id),
    poll: m.type === 'poll' ? pollFor(m.id) : null,
  };
}

function role(r) {
  return {
    id: r.id, name: r.name, color: r.color, color2: r.color2 || null, animated: !!r.animated, permissions: r.permissions, position: r.position,
    hoist: !!r.hoist, mentionable: !!r.mentionable, is_default: !!r.is_default,
  };
}

function channel(c) {
  return {
    id: c.id, server_id: c.server_id, type: c.type, name: c.name, topic: c.topic, parent_id: c.parent_id,
    position: c.position, slowmode: c.slowmode, last_message_id: c.last_message_id,
  };
}

function overwrites(channelId) {
  return all('SELECT target_type, target_id, allow, deny FROM channel_overwrites WHERE channel_id = ?', channelId);
}

function member(serverId, userId) {
  const m = get('SELECT * FROM members WHERE server_id = ? AND user_id = ?', serverId, userId);
  if (!m) return null;
  return {
    user: userById(userId),
    nickname: m.nickname,
    joined_at: m.joined_at,
    timeout_until: m.timeout_until && m.timeout_until > Date.now() ? m.timeout_until : null,
    roles: all('SELECT role_id FROM member_roles WHERE server_id = ? AND user_id = ?', serverId, userId).map((r) => r.role_id),
  };
}

function emoji(e) {
  return { id: e.id, server_id: e.server_id, name: e.name, animated: !!e.animated, creator_id: e.creator_id };
}

function dmChannel(c, viewerId) {
  const recipients = all('SELECT user_id FROM dm_members WHERE channel_id = ? AND user_id != ?', c.id, viewerId)
    .map((r) => userById(r.user_id));
  return {
    id: c.id, type: c.type, name: c.name, icon: c.icon, owner_id: c.owner_id,
    last_message_id: c.last_message_id, recipients,
  };
}

module.exports = { publicUser, selfUser, userById, message, role, channel, overwrites, member, emoji, dmChannel, reactionsFor, pollFor, customEmoji };
