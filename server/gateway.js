'use strict';
const { Server } = require('socket.io');
const { get, all, run } = require('./db');
const { userFromToken } = require('./auth');
const { channelPermissions, P, has } = require('./permissions');
const presence = require('./presence');
const ser = require('./serialize');
const config = require('./config');

let io = null;

// Voice: channelId -> Map(userId -> state)
const voice = new Map();
const socketVoice = new Map(); // socketId -> { channelId, userId }

const toUser = (userId, event, data) => io && io.to(`user:${userId}`).emit(event, data);
const toServer = (serverId, event, data) => io && io.to(`server:${serverId}`).emit(event, data);

function channelIsPublic(ch) {
  const everyone = get('SELECT id FROM roles WHERE server_id = ? AND is_default = 1', ch.server_id);
  const ids = [ch.id, ch.parent_id].filter(Boolean);
  for (const id of ids) {
    const ows = all('SELECT target_type, target_id, deny FROM channel_overwrites WHERE channel_id = ?', id);
    if (ows.some((o) => o.target_type === 'member' || o.target_id !== everyone?.id || (o.deny & P.VIEW_CHANNELS))) return false;
  }
  return true;
}

// Users who can see a channel.
function channelViewers(ch) {
  if (!ch.server_id) return all('SELECT user_id FROM dm_members WHERE channel_id = ?', ch.id).map((r) => r.user_id);
  const ids = all('SELECT user_id FROM members WHERE server_id = ?', ch.server_id).map((r) => r.user_id);
  if (channelIsPublic(ch)) return ids;
  return ids.filter((id) => has(channelPermissions(ch, id), P.VIEW_CHANNELS));
}

function toChannel(ch, event, data, exceptUserId) {
  if (!io) return;
  if (ch.server_id && channelIsPublic(ch) && !exceptUserId) return toServer(ch.server_id, event, data);
  for (const uid of channelViewers(ch)) if (uid !== exceptUserId) toUser(uid, event, data);
}

// Everyone who should hear about a user's presence/profile changes.
function relatedUsers(userId) {
  const set = new Set();
  for (const r of all(
    `SELECT DISTINCT m2.user_id FROM members m1 JOIN members m2 ON m1.server_id = m2.server_id WHERE m1.user_id = ?
     UNION SELECT other_id FROM relationships WHERE user_id = ? AND type != 'blocked'
     UNION SELECT d2.user_id FROM dm_members d1 JOIN dm_members d2 ON d1.channel_id = d2.channel_id WHERE d1.user_id = ?`,
    userId, userId, userId
  )) set.add(r.user_id);
  set.delete(userId);
  return set;
}

function broadcastUser(userId) {
  const u = get('SELECT * FROM users WHERE id = ?', userId);
  if (!u) return;
  const pub = ser.publicUser(u);
  for (const id of relatedUsers(userId)) toUser(id, 'user_update', pub);
  toUser(userId, 'self_update', ser.selfUser(u));
}

function broadcastPresence(userId) {
  const u = get('SELECT * FROM users WHERE id = ?', userId);
  if (!u) return;
  const data = { user_id: userId, status: presence.statusOf(u), custom_status: u.custom_status, custom_status_emoji: u.custom_status_emoji };
  for (const id of relatedUsers(userId)) toUser(id, 'presence', data);
}

function joinServerRoom(userId, serverId) {
  io?.in(`user:${userId}`).socketsJoin(`server:${serverId}`);
}
function leaveServerRoom(userId, serverId) {
  io?.in(`user:${userId}`).socketsLeave(`server:${serverId}`);
  // Leave any voice channel in that server.
  for (const [sid, v] of socketVoice) {
    if (v.userId === userId) {
      const ch = get('SELECT server_id FROM channels WHERE id = ?', v.channelId);
      if (ch?.server_id === serverId) leaveVoice(sid);
    }
  }
}
function disconnectUser(userId) {
  io?.in(`user:${userId}`).disconnectSockets(true);
}

// ---- Voice ----
function voiceStates(channelId) {
  return [...(voice.get(channelId)?.values() || [])];
}
function allVoiceStatesFor(userId) {
  // Voice states the user is allowed to see (server channels + their DMs).
  const out = [];
  for (const [cid, m] of voice) {
    const ch = get('SELECT * FROM channels WHERE id = ?', cid);
    if (!ch) continue;
    if (has(channelPermissions(ch, userId), P.VIEW_CHANNELS)) out.push({ channel_id: cid, states: [...m.values()] });
  }
  return out;
}
function emitVoice(channelId) {
  const ch = get('SELECT * FROM channels WHERE id = ?', channelId);
  if (!ch) return;
  toChannel(ch, 'voice_states', { channel_id: channelId, states: voiceStates(channelId) });
}
function leaveVoice(socketId) {
  const v = socketVoice.get(socketId);
  if (!v) return;
  socketVoice.delete(socketId);
  const m = voice.get(v.channelId);
  if (m) {
    const st = m.get(v.userId);
    if (st && st.socket_id === socketId) m.delete(v.userId);
    if (!m.size) voice.delete(v.channelId);
  }
  io?.to(`voice:${v.channelId}`).emit('voice_peer_left', { channel_id: v.channelId, user_id: v.userId, socket_id: socketId });
  io?.sockets.sockets.get(socketId)?.leave(`voice:${v.channelId}`);
  emitVoice(v.channelId);
}

function setup(httpServer) {
  io = new Server(httpServer, { cors: { origin: true, credentials: true }, maxHttpBufferSize: 1e6 });

  io.use((socket, next) => {
    const user = userFromToken(socket.handshake.auth?.token);
    if (!user) return next(new Error('unauthorized'));
    socket.data.userId = user.id;
    socket.data.tokenHash = user.token_hash;
    next();
  });

  io.on('connection', (socket) => {
    const userId = socket.data.userId;
    const wasOnline = presence.isOnline(userId);
    presence.add(userId, socket.id);
    socket.join(`user:${userId}`);
    socket.join(`session:${socket.data.tokenHash}`);
    for (const r of all('SELECT server_id FROM members WHERE user_id = ?', userId)) socket.join(`server:${r.server_id}`);
    if (!wasOnline) broadcastPresence(userId);
    socket.emit('voice_snapshot', allVoiceStatesFor(userId));

    socket.on('active', (active) => presence.setActive(userId, socket.id, active));

    socket.on('typing', (channelId) => {
      const ch = get('SELECT * FROM channels WHERE id = ?', Number(channelId));
      if (!ch || !has(channelPermissions(ch, userId), P.SEND_MESSAGES)) return;
      toChannel(ch, 'typing', { channel_id: ch.id, user_id: userId }, userId);
    });

    socket.on('voice_join', (channelId, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      const ch = get('SELECT * FROM channels WHERE id = ?', Number(channelId));
      if (!ch || !(ch.type === 'voice' || ch.type === 'dm' || ch.type === 'group')) return reply({ error: 'Not a voice channel.' });
      const perms = channelPermissions(ch, userId);
      if (!has(perms, P.CONNECT)) return reply({ error: 'You cannot connect to this channel.' });
      leaveVoice(socket.id);
      // One voice connection per user: kick other sessions out.
      for (const [sid, v] of socketVoice) if (v.userId === userId) { io.to(sid).emit('voice_kicked', { reason: 'Joined from another device.' }); leaveVoice(sid); }
      if (!voice.has(ch.id)) voice.set(ch.id, new Map());
      const state = {
        user_id: userId, socket_id: socket.id, channel_id: ch.id,
        muted: false, deafened: false, video: false, screen: false,
        server_muted: false, can_speak: has(perms, P.SPEAK), can_video: has(perms, P.VIDEO),
      };
      const peers = voiceStates(ch.id);
      voice.get(ch.id).set(userId, state);
      socketVoice.set(socket.id, { channelId: ch.id, userId });
      socket.join(`voice:${ch.id}`);
      reply({ ok: true, peers, ice_servers: config.iceServers, self: state });
      emitVoice(ch.id);
      if (!ch.server_id && peers.length === 0) {
        // Ring the other DM participants.
        const caller = ser.userById(userId);
        for (const r of all('SELECT user_id FROM dm_members WHERE channel_id = ? AND user_id != ?', ch.id, userId)) {
          toUser(r.user_id, 'call_ring', { channel_id: ch.id, caller });
        }
        require('./notify').callNotify(ch, userId);
      }
    });

    socket.on('voice_leave', () => leaveVoice(socket.id));

    socket.on('voice_update', (patch) => {
      const v = socketVoice.get(socket.id);
      if (!v || !patch || typeof patch !== 'object') return;
      const st = voice.get(v.channelId)?.get(userId);
      if (!st) return;
      for (const k of ['muted', 'deafened', 'video', 'screen', 'speaking']) if (k in patch) st[k] = !!patch[k];
      if (!st.can_video) { st.video = false; st.screen = false; }
      if (k_onlySpeaking(patch)) {
        io.to(`voice:${v.channelId}`).emit('voice_speaking', { user_id: userId, speaking: st.speaking });
      } else emitVoice(v.channelId);
    });

    // WebRTC signaling relay between peers in the same voice channel.
    socket.on('voice_signal', (msg) => {
      const v = socketVoice.get(socket.id);
      if (!v || !msg || typeof msg.to !== 'string') return;
      const target = socketVoice.get(msg.to);
      if (!target || target.channelId !== v.channelId) return;
      io.to(msg.to).emit('voice_signal', { from: socket.id, user_id: userId, data: msg.data });
    });

    socket.on('disconnect', () => {
      leaveVoice(socket.id);
      presence.remove(userId, socket.id);
      if (!presence.isOnline(userId)) broadcastPresence(userId);
    });
  });

  return io;
}

const k_onlySpeaking = (patch) => Object.keys(patch).length === 1 && 'speaking' in patch;

function serverMute(channelId, userId, muted) {
  const st = voice.get(channelId)?.get(userId);
  if (!st) return false;
  st.server_muted = !!muted;
  emitVoice(channelId);
  return true;
}
function disconnectVoiceUser(userId) {
  for (const [sid, v] of socketVoice) if (v.userId === userId) { io.to(sid).emit('voice_kicked', { reason: 'Disconnected by a moderator.' }); leaveVoice(sid); }
}
function voiceChannelOf(userId) {
  for (const v of socketVoice.values()) if (v.userId === userId) return v.channelId;
  return null;
}
function moveVoiceUser(userId, channelId) {
  for (const [sid, v] of socketVoice) if (v.userId === userId) io.to(sid).emit('voice_move', { channel_id: channelId });
}
function closeSession(tokenHash) {
  io?.in(`session:${tokenHash}`).disconnectSockets(true);
}

module.exports = {
  setup, toUser, toServer, toChannel, channelViewers, broadcastUser, broadcastPresence, joinServerRoom, leaveServerRoom,
  disconnectUser, serverMute, disconnectVoiceUser, voiceChannelOf, moveVoiceUser, closeSession, voiceStates,
};
