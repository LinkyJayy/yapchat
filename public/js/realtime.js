// Socket.IO connection: keeps the store in sync and re-emits UI events.
import { state, emit, cacheUser, channelById } from './store.js';
import { token } from './api.js';

export let socket = null;

function upsertMessage(msg) {
  const box = state.messages.get(msg.channel_id);
  if (!box) return;
  const i = box.list.findIndex((m) => m.id === msg.id || (msg.nonce && m.nonce === msg.nonce));
  if (i >= 0) box.list[i] = { ...msg, nonce: undefined };
  else box.list.push(msg);
}

export function connect() {
  socket = window.io({ auth: { token: token.get() }, transports: ['websocket', 'polling'] });

  socket.on('connect', () => {
    emit('connection', true);
    reportActive();
  });
  socket.on('disconnect', () => emit('connection', false));
  socket.on('connect_error', (err) => {
    if (err.message === 'unauthorized') { token.clear(); location.href = '/login'; }
  });
  // After a reconnect, refetch everything that may have been missed.
  socket.io.on('reconnect', () => emit('resync'));

  socket.on('message_create', (msg) => {
    cacheUser(msg.author);
    const ch = channelById(msg.channel_id);
    if (ch) ch.last_message_id = Math.max(ch.last_message_id || 0, msg.id);
    if (state.dms.has(msg.channel_id)) {
      // Bump DM to the top.
      const dm = state.dms.get(msg.channel_id);
      state.dms.delete(msg.channel_id);
      state.dms = new Map([[dm.id, dm], ...state.dms]);
    }
    upsertMessage(msg);
    const t = state.typing.get(msg.channel_id);
    if (t?.delete(msg.author.id)) emit('typing', msg.channel_id);
    emit('message_create', msg);
    emit('unread');
  });
  socket.on('message_update', (msg) => {
    cacheUser(msg.author);
    const box = state.messages.get(msg.channel_id);
    if (box) { const i = box.list.findIndex((m) => m.id === msg.id); if (i >= 0) box.list[i] = msg; }
    emit('message_update', msg);
  });
  socket.on('message_delete', ({ id, channel_id }) => {
    const box = state.messages.get(channel_id);
    if (box) box.list = box.list.filter((m) => m.id !== id);
    emit('message_delete', { id, channel_id });
  });
  socket.on('reactions_update', ({ channel_id, message_id, reactions }) => {
    const m = state.messages.get(channel_id)?.list.find((x) => x.id === message_id);
    if (m) m.reactions = reactions;
    emit('message_patch', { channel_id, message_id });
  });
  socket.on('poll_update', ({ channel_id, message_id, poll }) => {
    const m = state.messages.get(channel_id)?.list.find((x) => x.id === message_id);
    if (m) m.poll = poll;
    emit('message_patch', { channel_id, message_id });
  });

  socket.on('typing', ({ channel_id, user_id }) => {
    if (!state.typing.has(channel_id)) state.typing.set(channel_id, new Map());
    state.typing.get(channel_id).set(user_id, Date.now() + 9000);
    emit('typing', channel_id);
    setTimeout(() => {
      const m = state.typing.get(channel_id);
      if (m && (m.get(user_id) || 0) <= Date.now()) { m.delete(user_id); emit('typing', channel_id); }
    }, 9100);
  });

  socket.on('server_create', (s) => {
    const isNew = !state.servers.has(s.id);
    state.servers.set(s.id, s);
    if (isNew) state.serverOrder.push(s.id);
    if (s.me) cacheUser(s.me.user);
    emit('servers');
  });
  socket.on('server_update', (s) => {
    if (!state.servers.has(s.id)) return;
    state.servers.set(s.id, s);
    if (s.me) {
      const mm = state.members.get(s.id);
      if (mm) mm.set(s.me.user.id, s.me);
    }
    emit('servers');
    emit('server_update', s.id);
  });
  socket.on('server_delete', ({ id }) => {
    state.servers.delete(id);
    state.serverOrder = state.serverOrder.filter((x) => x !== id);
    state.members.delete(id);
    emit('servers');
    emit('server_removed', id);
  });
  socket.on('server_order', ({ ids }) => {
    state.serverOrder = ids.filter((id) => state.servers.has(id)).concat(state.serverOrder.filter((id) => !ids.includes(id)));
    emit('servers');
  });
  socket.on('emojis_update', ({ server_id, emojis }) => {
    const s = state.servers.get(server_id);
    if (s) { s.emojis = emojis; emit('server_update', server_id); }
  });
  socket.on('member_add', ({ server_id, member }) => {
    cacheUser(member.user);
    state.members.get(server_id)?.set(member.user.id, member);
    const s = state.servers.get(server_id);
    if (s) s.member_count++;
    emit('members', server_id);
  });
  socket.on('member_update', ({ server_id, member }) => {
    cacheUser(member.user);
    state.members.get(server_id)?.set(member.user.id, member);
    const s = state.servers.get(server_id);
    if (s && member.user.id === state.user.id) s.me = member;
    emit('members', server_id);
    emit('member_update', { server_id, user_id: member.user.id });
  });
  socket.on('member_remove', ({ server_id, user_id }) => {
    state.members.get(server_id)?.delete(user_id);
    const s = state.servers.get(server_id);
    if (s) s.member_count = Math.max(0, s.member_count - 1);
    emit('members', server_id);
  });

  socket.on('user_update', (u) => { cacheUser(u); emit('user', u.id); });
  socket.on('self_update', (u) => { state.user = u; cacheUser(u); emit('self'); emit('user', u.id); });
  socket.on('presence', ({ user_id, status, custom_status, custom_status_emoji }) => {
    const u = state.users.get(user_id);
    if (u) Object.assign(u, { status, custom_status, custom_status_emoji });
    emit('presence', user_id);
  });
  socket.on('relationship', ({ type, user }) => {
    cacheUser(user);
    if (type) state.relationships.set(user.id, { type, created_at: Date.now() });
    else state.relationships.delete(user.id);
    emit('relationships');
  });
  socket.on('dm_create', (dm) => {
    dm.recipients.forEach(cacheUser);
    const rest = [...state.dms].filter(([id]) => id !== dm.id);
    state.dms = new Map([[dm.id, dm], ...rest]);
    emit('dms');
  });
  socket.on('dm_update', (dm) => {
    dm.recipients.forEach(cacheUser);
    if (state.dms.has(dm.id)) state.dms.set(dm.id, dm);
    emit('dms');
  });
  socket.on('dm_delete', ({ id }) => {
    state.dms.delete(id);
    emit('dms');
    emit('dm_removed', id);
  });
  socket.on('read_state', (rs) => {
    const cur = state.readStates.get(rs.channel_id);
    if (rs.manual || !cur || rs.last_read_id >= cur.last_read_id || rs.mention_count !== cur.mention_count) {
      state.readStates.set(rs.channel_id, { ...cur, ...rs });
    }
    emit('unread');
  });
  socket.on('notify_settings', (n) => { state.notify.set(n.target_id, n); emit('unread'); emit('notify_settings'); });

  socket.on('notify', (n) => emit('notify', n));

  for (const ev of ['voice_snapshot', 'voice_states', 'voice_speaking', 'voice_signal', 'voice_peer_left', 'voice_kicked', 'voice_move', 'call_ring']) {
    socket.on(ev, (d) => emit(ev, d));
  }
}

// Tell the server whether this client is actively being looked at (controls push vs in-app).
export function reportActive() {
  if (!socket?.connected) return;
  socket.emit('active', document.visibilityState === 'visible' && document.hasFocus());
}
document.addEventListener('visibilitychange', reportActive);
window.addEventListener('focus', reportActive);
window.addEventListener('blur', reportActive);

export const sendTyping = (channelId) => socket?.emit('typing', channelId);
