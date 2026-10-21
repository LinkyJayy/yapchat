'use strict';
const { get, all } = require('./db');

const P = {
  VIEW_CHANNELS: 1 << 0,
  SEND_MESSAGES: 1 << 1,
  READ_HISTORY: 1 << 2,
  ADD_REACTIONS: 1 << 3,
  ATTACH_FILES: 1 << 4,
  EMBED_LINKS: 1 << 5,
  MENTION_EVERYONE: 1 << 6,
  USE_EXTERNAL_EMOJIS: 1 << 7,
  CREATE_POLLS: 1 << 8,
  CONNECT: 1 << 9,
  SPEAK: 1 << 10,
  VIDEO: 1 << 11,
  MANAGE_MESSAGES: 1 << 12,
  MANAGE_CHANNELS: 1 << 13,
  MANAGE_ROLES: 1 << 14,
  MANAGE_SERVER: 1 << 15,
  MANAGE_EMOJIS: 1 << 16,
  KICK_MEMBERS: 1 << 17,
  BAN_MEMBERS: 1 << 18,
  MODERATE_MEMBERS: 1 << 19,
  MANAGE_NICKNAMES: 1 << 20,
  CHANGE_NICKNAME: 1 << 21,
  VIEW_AUDIT_LOG: 1 << 22,
  MUTE_MEMBERS: 1 << 23,
  MOVE_MEMBERS: 1 << 24,
  ADMINISTRATOR: 1 << 30,
};
const ALL = Object.values(P).reduce((a, b) => a | b, 0);

const DEFAULT_EVERYONE =
  P.VIEW_CHANNELS | P.SEND_MESSAGES | P.READ_HISTORY | P.ADD_REACTIONS | P.ATTACH_FILES |
  P.EMBED_LINKS | P.USE_EXTERNAL_EMOJIS | P.CREATE_POLLS | P.CONNECT | P.SPEAK | P.VIDEO |
  P.CHANGE_NICKNAME;

// Permissions a timed-out member keeps.
const TIMEOUT_MASK = P.VIEW_CHANNELS | P.READ_HISTORY;

function memberRoleIds(serverId, userId) {
  return all('SELECT role_id FROM member_roles WHERE server_id = ? AND user_id = ?', serverId, userId).map((r) => r.role_id);
}

function serverPermissions(serverId, userId) {
  const server = get('SELECT owner_id FROM servers WHERE id = ?', serverId);
  if (!server) return 0;
  const member = get('SELECT timeout_until FROM members WHERE server_id = ? AND user_id = ?', serverId, userId);
  if (!member) return 0;
  if (server.owner_id === userId) return ALL;
  const everyone = get('SELECT permissions FROM roles WHERE server_id = ? AND is_default = 1', serverId);
  let perms = everyone ? everyone.permissions : 0;
  for (const r of all(
    'SELECT r.permissions FROM member_roles mr JOIN roles r ON r.id = mr.role_id WHERE mr.server_id = ? AND mr.user_id = ?',
    serverId, userId
  )) perms |= r.permissions;
  if (perms & P.ADMINISTRATOR) return ALL;
  if (member.timeout_until && member.timeout_until > Date.now()) perms &= TIMEOUT_MASK;
  return perms;
}

function applyOverwrites(perms, channelId, serverId, userId) {
  const ows = all('SELECT target_type, target_id, allow, deny FROM channel_overwrites WHERE channel_id = ?', channelId);
  if (!ows.length) return perms;
  const everyone = get('SELECT id FROM roles WHERE server_id = ? AND is_default = 1', serverId);
  const roleIds = new Set(memberRoleIds(serverId, userId));
  const ev = everyone && ows.find((o) => o.target_type === 'role' && o.target_id === everyone.id);
  if (ev) perms = (perms & ~ev.deny) | ev.allow;
  let allow = 0, deny = 0;
  for (const o of ows) {
    if (o.target_type === 'role' && roleIds.has(o.target_id)) { allow |= o.allow; deny |= o.deny; }
  }
  perms = (perms & ~deny) | allow;
  const mo = ows.find((o) => o.target_type === 'member' && o.target_id === userId);
  if (mo) perms = (perms & ~mo.deny) | mo.allow;
  return perms;
}

function channelPermissions(channel, userId) {
  if (!channel) return 0;
  if (!channel.server_id) {
    const m = get('SELECT 1 FROM dm_members WHERE channel_id = ? AND user_id = ?', channel.id, userId);
    if (!m) return 0;
    return P.VIEW_CHANNELS | P.SEND_MESSAGES | P.READ_HISTORY | P.ADD_REACTIONS | P.ATTACH_FILES |
      P.EMBED_LINKS | P.USE_EXTERNAL_EMOJIS | P.CREATE_POLLS | P.CONNECT | P.SPEAK | P.VIDEO;
  }
  const base = serverPermissions(channel.server_id, userId);
  if (!base) return 0;
  // Owners and administrators bypass channel overwrites.
  if (base === ALL) return ALL;
  let perms = base;
  if (channel.parent_id) perms = applyOverwrites(perms, channel.parent_id, channel.server_id, userId);
  perms = applyOverwrites(perms, channel.id, channel.server_id, userId);
  const member = get('SELECT timeout_until FROM members WHERE server_id = ? AND user_id = ?', channel.server_id, userId);
  if (member?.timeout_until && member.timeout_until > Date.now()) perms &= TIMEOUT_MASK;
  if (!(perms & P.VIEW_CHANNELS)) return 0;
  return perms;
}

const has = (perms, flag) => (perms & flag) === flag;

// Highest role position a member holds (owner = Infinity). Used for hierarchy checks.
function topPosition(serverId, userId) {
  const server = get('SELECT owner_id FROM servers WHERE id = ?', serverId);
  if (server && server.owner_id === userId) return Infinity;
  const r = get(
    'SELECT MAX(r.position) AS p FROM member_roles mr JOIN roles r ON r.id = mr.role_id WHERE mr.server_id = ? AND mr.user_id = ?',
    serverId, userId
  );
  return r && r.p != null ? r.p : 0;
}

function canActOn(serverId, actorId, targetId) {
  if (actorId === targetId) return false;
  const server = get('SELECT owner_id FROM servers WHERE id = ?', serverId);
  if (server.owner_id === targetId) return false;
  if (server.owner_id === actorId) return true;
  return topPosition(serverId, actorId) > topPosition(serverId, targetId);
}

module.exports = { P, ALL, DEFAULT_EVERYONE, serverPermissions, channelPermissions, has, topPosition, canActOn, memberRoleIds };
