// Client-side state and a tiny event bus.

export const P = {
  VIEW_CHANNELS: 1 << 0, SEND_MESSAGES: 1 << 1, READ_HISTORY: 1 << 2, ADD_REACTIONS: 1 << 3, ATTACH_FILES: 1 << 4,
  EMBED_LINKS: 1 << 5, MENTION_EVERYONE: 1 << 6, USE_EXTERNAL_EMOJIS: 1 << 7, CREATE_POLLS: 1 << 8, CONNECT: 1 << 9,
  SPEAK: 1 << 10, VIDEO: 1 << 11, MANAGE_MESSAGES: 1 << 12, MANAGE_CHANNELS: 1 << 13, MANAGE_ROLES: 1 << 14,
  MANAGE_SERVER: 1 << 15, MANAGE_EMOJIS: 1 << 16, KICK_MEMBERS: 1 << 17, BAN_MEMBERS: 1 << 18, MODERATE_MEMBERS: 1 << 19,
  MANAGE_NICKNAMES: 1 << 20, CHANGE_NICKNAME: 1 << 21, VIEW_AUDIT_LOG: 1 << 22, MUTE_MEMBERS: 1 << 23, MOVE_MEMBERS: 1 << 24,
  ADMINISTRATOR: 1 << 30,
};
export const has = (perms, flag) => ((perms | 0) & flag) === flag;

export const state = {
  user: null,
  servers: new Map(),
  serverOrder: [],
  dms: new Map(),
  relationships: new Map(), // userId -> { type, user }
  users: new Map(), // userId -> public user (cache)
  readStates: new Map(),
  notify: new Map(),
  members: new Map(), // serverId -> Map(userId -> member)
  messages: new Map(), // channelId -> { list, hasMore, loading }
  typing: new Map(), // channelId -> Map(userId -> expires)
  voice: new Map(), // channelId -> states[]
  route: { serverId: '@me', channelId: null },
  limits: {},
  vapid: null,
  collapsed: new Set((() => { try { return JSON.parse(localStorage.getItem('yapper_collapsed') || '[]'); } catch { return []; } })()),
};

const handlers = new Map();
export function on(evt, fn) {
  if (!handlers.has(evt)) handlers.set(evt, new Set());
  handlers.get(evt).add(fn);
  return () => handlers.get(evt).delete(fn);
}
export function emit(evt, data) {
  for (const fn of handlers.get(evt) || []) {
    try { fn(data); } catch (e) { console.error(e); }
  }
}

export function cacheUser(u) {
  if (!u || !u.id) return u;
  const prev = state.users.get(u.id);
  const merged = prev ? { ...prev, ...u } : u;
  state.users.set(u.id, merged);
  return merged;
}
export const getUser = (id) => state.users.get(id) || (state.user?.id === id ? state.user : null);

export function loadReady(data) {
  state.user = data.user;
  cacheUser(data.user);
  state.servers.clear();
  state.serverOrder = [];
  for (const s of data.servers) { state.servers.set(s.id, s); state.serverOrder.push(s.id); }
  state.dms.clear();
  for (const d of data.dms) { state.dms.set(d.id, d); d.recipients.forEach(cacheUser); }
  state.relationships.clear();
  for (const r of data.relationships) { cacheUser(r.user); state.relationships.set(r.user.id, { type: r.type, created_at: r.created_at }); }
  state.readStates.clear();
  for (const r of data.read_states) state.readStates.set(r.channel_id, r);
  state.notify.clear();
  for (const n of data.notify_settings) state.notify.set(n.target_id, n);
  state.limits = data.limits;
  state.vapid = data.vapid_public_key;
  for (const s of data.servers) if (s.me) cacheUser(s.me.user);
}

// ---------- Derived helpers ----------
export const currentServer = () => (state.route.serverId === '@me' ? null : state.servers.get(state.route.serverId));
export function channelById(id) {
  if (state.dms.has(id)) return state.dms.get(id);
  for (const s of state.servers.values()) {
    const c = s.channels.find((x) => x.id === id);
    if (c) return c;
  }
  return null;
}
export const currentChannel = () => (state.route.channelId ? channelById(state.route.channelId) : null);

export function memberOf(serverId, userId) {
  return state.members.get(serverId)?.get(userId) || (state.servers.get(serverId)?.me?.user?.id === userId ? state.servers.get(serverId).me : null);
}

export function displayName(userId, serverId) {
  const u = getUser(userId);
  if (serverId) {
    const m = memberOf(serverId, userId);
    if (m?.nickname) return m.nickname;
  }
  return u?.display_name || u?.username || 'Unknown User';
}

export function sortedRoles(server) {
  return [...(server?.roles || [])].sort((a, b) => b.position - a.position);
}

export function memberColor(serverId, userId) {
  const s = state.servers.get(serverId);
  const m = memberOf(serverId, userId);
  if (!s || !m) return null;
  for (const r of sortedRoles(s)) if (!r.is_default && r.color && m.roles.includes(r.id)) return r.color;
  return null;
}

// Colors a member's name should use: the top role's own gradient, or a blend of
// their top (up to 3) colored roles when they have several.
export function memberPaint(serverId, userId) {
  const s = state.servers.get(serverId);
  const m = memberOf(serverId, userId);
  if (!s || !m) return null;
  const colored = sortedRoles(s).filter((r) => !r.is_default && r.color && m.roles.includes(r.id));
  if (!colored.length) return null;
  const top = colored[0];
  let used = [top];
  let colors = top.color2 ? [top.color, top.color2] : [top.color];
  if (!top.color2 && colored.length > 1) {
    used = colored.slice(0, 3);
    colors = [...new Set(used.map((r) => r.color))];
  }
  return { colors, animated: used.some((r) => r.animated) };
}

// Class + inline style for painting text with a solid, gradient or animated color.
export function paintStyle(paint) {
  if (!paint) return { cls: '', style: '' };
  const { colors, animated } = paint;
  if (colors.length === 1) return { cls: animated ? 'role-cycle' : '', style: `color:${colors[0]}` };
  return { cls: `role-gradient${animated ? ' role-animated' : ''}`, style: `--rg:linear-gradient(90deg,${[...colors, colors[0]].join(',')})` };
}

// Attribute string for a member's name element.
export function nameAttrs(serverId, userId, cls = '', extraStyle = '') {
  const p = paintStyle(serverId ? memberPaint(serverId, userId) : null);
  const style = [p.style, extraStyle].filter(Boolean).join(';');
  return `class="${[cls, p.cls].filter(Boolean).join(' ')}"${style ? ` style="${style}"` : ''}`;
}

// Attribute string for text painted in a role's own colors.
export function roleAttrs(r, cls = '') {
  const p = paintStyle(r?.color ? { colors: r.color2 ? [r.color, r.color2] : [r.color], animated: !!r.animated } : null);
  return `class="${[cls, p.cls].filter(Boolean).join(' ')}"${p.style ? ` style="${p.style}"` : ''}`;
}

// Background for a role's color dot / swatch.
export const roleSwatch = (r) => (r.color ? (r.color2 ? `linear-gradient(135deg,${r.color},${r.color2})` : r.color) : 'var(--offline)');

export function dmName(dm) {
  if (dm.name) return dm.name;
  if (!dm.recipients.length) return 'Empty Group';
  return dm.recipients.map((u) => displayName(u.id)).join(', ');
}

export function isUnread(ch) {
  if (!ch.last_message_id) return false;
  const rs = state.readStates.get(ch.id);
  return !rs || rs.last_read_id < ch.last_message_id;
}
export const mentionCount = (chId) => state.readStates.get(chId)?.mention_count || 0;

export function isMuted(targetId) { return !!state.notify.get(targetId)?.muted; }

export function serverUnread(s) {
  if (isMuted(s.id)) return false;
  return s.channels.some((c) => c.type !== 'category' && c.type !== 'voice' && !isMuted(c.id) && isUnread(c));
}
export const serverMentions = (s) => s.channels.reduce((a, c) => a + mentionCount(c.id), 0);
export const dmMentions = () => [...state.dms.values()].reduce((a, d) => a + mentionCount(d.id), 0);

export function settings() {
  return state.user?.settings || {};
}

export function relationship(userId) { return state.relationships.get(userId)?.type || null; }
export const isBlocked = (userId) => relationship(userId) === 'blocked';

export function saveCollapsed() {
  try { localStorage.setItem('yapper_collapsed', JSON.stringify([...state.collapsed])); } catch { /* ignore */ }
}

// People typing in a channel right now (excluding you and blocked users): [{ user_id, since }]
export function typingIn(channelId) {
  const m = state.typing.get(channelId);
  if (!m) return [];
  const now = Date.now();
  return [...m].filter(([id, t]) => id !== state.user?.id && t.expires > now && relationship(id) !== 'blocked')
    .map(([user_id, t]) => ({ user_id, since: t.since })).sort((a, b) => a.since - b.since);
}

// Everyone typing anywhere in a server: [{ user_id, since, channel }]
export function typingInServer(server) {
  const out = [];
  for (const c of server?.channels || []) for (const t of typingIn(c.id)) out.push({ ...t, channel: c });
  return out;
}

// Public member counter: online / total / in voice.
export function serverCounts(s) {
  const members = state.members.get(s.id);
  let online = null;
  if (members) {
    online = 0;
    for (const m of members.values()) {
      const u = m.user.id === state.user?.id ? null : getUser(m.user.id);
      const st = m.user.id === state.user?.id ? (state.user.set_status === 'invisible' ? 'offline' : 'online') : u?.status || m.user.status;
      if (st && st !== 'offline') online++;
    }
  }
  const inVoice = new Set();
  for (const c of s.channels) if (c.type === 'voice') for (const v of state.voice.get(c.id) || []) inVoice.add(v.user_id);
  return { total: s.member_count, online, voice: inVoice.size };
}
