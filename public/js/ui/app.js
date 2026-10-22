// App shell: server rail, sidebar (channels / DMs), main view, members list, user panel.
import { $, $$, el, esc, on as onEvt, toast, errToast, copyText, isMobile, fmtDuration } from '../dom.js';
import { icon } from '../icons.js';
import {
  state, on, emit, P, has, currentServer, currentChannel, channelById, displayName, nameAttrs, dmName, isUnread,
  mentionCount, serverUnread, serverMentions, dmMentions, isMuted, getUser, typingIn, typingInServer, serverCounts, cacheUser, saveCollapsed, sortedRoles, relationship,
} from '../store.js';
import { GET, POST, PUT, DEL, PATCH } from '../api.js';
import { navigate, channelPath } from '../router.js';
import { avatarHtml, statusOf, customStatusHtml, serverIconHtml, CHANNEL_ICON, STATUS_LABEL } from './components.js';
import { menu, modal, confirmDialog, promptDialog } from './layers.js';
import { mountChat } from './chat.js';
import { mountFriends } from './friends.js';
import { openProfile, userMenu } from './profile.js';
import { openSettings } from './settings.js';
import { openServerSettings, openCreateServer, openCreateChannel, openInvite } from './server-settings.js';
import { openChannelSettings } from './channel-settings.js';
import * as voice from './voice.js';
import { emojify } from '../emoji.js';

let shell;
let mainView = null; // { destroy }
let mainKey = '';

export function mountApp() {
  const app = document.getElementById('app');
  app.innerHTML = '';
  shell = el(`<div class="shell">
    <nav class="rail" aria-label="Servers"></nav>
    <aside class="sidebar"><div class="sb-head"></div><div class="sidebar-scroll"></div><div class="vp-slot"></div><div class="user-panel"></div></aside>
    <main class="main"><section class="chat-slot" style="min-width:0;min-height:0;display:flex;flex-direction:column"></section><aside class="members" hidden></aside></main>
    <div class="mobile-scrim"></div>
  </div>`);
  app.append(shell);

  $('.mobile-scrim', shell).onclick = () => shell.classList.remove('nav-open', 'members-open');

  const queue = new Set();
  let raf = 0;
  const schedule = (...parts) => {
    parts.forEach((p) => queue.add(p));
    if (!raf) raf = requestAnimationFrame(() => {
      raf = 0;
      const q = [...queue]; queue.clear();
      if (q.includes('rail')) renderRail();
      if (q.includes('sidebar')) renderSidebar();
      if (q.includes('main')) renderMain();
      if (q.includes('members')) renderMembers();
      if (q.includes('panel')) renderUserPanel();
      if (q.includes('voice')) renderVoicePanel();
    });
  };

  on('route', () => {
    fixRoute();
    schedule('rail', 'sidebar', 'main', 'members');
  });
  on('servers', () => { fixRoute(); schedule('rail', 'sidebar', 'main', 'members'); });
  on('server_update', () => schedule('sidebar', 'members'));
  on('dms', () => schedule('sidebar', 'rail'));
  on('unread', () => schedule('rail', 'sidebar'));
  on('typing', () => schedule('rail', 'sidebar'));
  on('reviews', () => schedule('sidebar'));
  on('notify_settings', () => schedule('rail', 'sidebar'));
  on('members', (sid) => { if (sid === state.route.serverId) schedule('members', 'sidebar'); });
  on('presence', () => schedule('members', 'sidebar'));
  on('user', () => schedule('members', 'sidebar', 'panel'));
  on('self', () => schedule('panel', 'members'));
  on('voice_changed', () => schedule('sidebar', 'voice'));
  on('relationships', () => schedule('sidebar'));
  on('server_removed', (id) => { if (state.route.serverId === id) navigate('/channels/@me', { replace: true }); });
  on('dm_removed', (id) => { if (state.route.channelId === id) navigate('/channels/@me', { replace: true }); });
  on('toggle_members', () => {
    if (isMobile()) shell.classList.toggle('members-open');
    else {
      const s = { ...(state.user.settings || {}) };
      s.hideMembers = !s.hideMembers;
      state.user.settings = s;
      PATCH('/users/@me', { settings: { hideMembers: s.hideMembers } }).catch(() => {});
      schedule('members');
    }
  });
  on('open_nav', () => shell.classList.add('nav-open'));

  fixRoute();
  schedule('rail', 'sidebar', 'main', 'members', 'panel', 'voice');
}

const closeNav = () => shell.classList.remove('nav-open');

// Fill in the channel when a server is opened without one; drop invalid routes.
function fixRoute() {
  const r = state.route;
  if (r.serverId === '@me') {
    if (r.channelId && !state.dms.has(r.channelId)) navigate('/channels/@me', { replace: true });
    return;
  }
  const s = state.servers.get(r.serverId);
  if (!s) { navigate('/channels/@me', { replace: true }); return; }
  const ch = r.channelId && s.channels.find((c) => c.id === r.channelId);
  if (!ch || ch.type === 'category') {
    const last = lastChannel(s.id);
    const first = (last && s.channels.find((c) => c.id === last && c.type !== 'category')) || orderedChannels(s).find((c) => c.type === 'text' || c.type === 'announcement') || orderedChannels(s).find((c) => c.type !== 'category');
    navigate(channelPath(s.id, first?.id), { replace: true });
  }
}
const lastChannel = (sid) => { try { return Number(localStorage.getItem(`yapper_last_${sid}`)) || null; } catch { return null; } };
const rememberChannel = (sid, cid) => { try { localStorage.setItem(`yapper_last_${sid}`, String(cid)); } catch { /* ignore */ } };

export function orderedChannels(s) {
  const cats = s.channels.filter((c) => c.type === 'category').sort((a, b) => a.position - b.position || a.id - b.id);
  const byParent = (pid) => s.channels.filter((c) => c.type !== 'category' && (c.parent_id || null) === pid)
    .sort((a, b) => (a.type === 'voice') - (b.type === 'voice') || a.position - b.position || a.id - b.id);
  const out = [...byParent(null)];
  for (const c of cats) out.push(c, ...byParent(c.id));
  return out;
}

// ---------- Rail ----------
function renderRail() {
  const rail = $('.rail', shell);
  const r = state.route;
  const dmUnread = [...state.dms.values()].filter((d) => mentionCount(d.id) > 0 && !isMuted(d.id));
  const homeMentions = dmMentions();
  rail.innerHTML = `
    <div class="rail-item home-item ${r.serverId === '@me' ? 'active' : ''}" title="Direct Messages">
      <span class="pill"></span>
      <button class="rail-btn home" data-home aria-label="Direct Messages"><img src="/icons/logo.png" alt=""></button>
      ${homeMentions ? `<span class="badge">${homeMentions}</span>` : ''}
    </div>
    ${anyUnread() ? `<div class="rail-item" title="Mark everything as read (Shift+Esc)"><button class="rail-btn action read-all" data-readall aria-label="Mark everything as read">${icon('checkAll')}</button></div>` : ''}
    ${dmUnread.slice(0, 5).map((d) => `<div class="rail-item has-icon" title="${esc(dmName(d))}">
      <span class="pill"></span><button class="rail-btn" data-dm="${d.id}">${d.type === 'dm' ? avatarHtml(d.recipients[0]) : `<span>${icon('users')}</span>`}</button>
      <span class="badge">${mentionCount(d.id)}</span></div>`).join('')}
    <div class="rail-sep"></div>
    ${state.serverOrder.map((id) => {
      const s = state.servers.get(id);
      if (!s) return '';
      const m = serverMentions(s);
      return `<div class="rail-item ${s.icon ? 'has-icon' : ''} ${r.serverId === s.id ? 'active' : ''} ${serverUnread(s) ? 'unread' : ''}" draggable="true" data-server="${s.id}" title="${esc(s.name)}">
        <span class="pill"></span><button class="rail-btn" aria-label="${esc(s.name)}">${serverIconHtml(s)}</button>
        ${m ? `<span class="badge">${m}</span>` : ''}
        ${typingInServer(s).length ? '<span class="rail-typing" title="Someone is typing"><i></i><i></i><i></i></span>' : ''}</div>`;
    }).join('')}
    <div class="rail-item" title="Add a Server"><button class="rail-btn action" data-add aria-label="Add a Server">${icon('plus')}</button></div>
  `;
  rail.onclick = (e) => {
    if (e.target.closest('[data-home]')) return navigate(lastHome());
    if (e.target.closest('[data-readall]')) return readAll();
    const dm = e.target.closest('[data-dm]');
    if (dm) return navigate(channelPath('@me', Number(dm.dataset.dm)));
    if (e.target.closest('[data-add]')) return openCreateServer();
    const s = e.target.closest('[data-server]');
    if (s) navigate(channelPath(Number(s.dataset.server), lastChannel(Number(s.dataset.server))));
  };
  rail.oncontextmenu = (e) => {
    const s = e.target.closest('[data-server]');
    if (!s) return;
    e.preventDefault();
    serverMenu(state.servers.get(Number(s.dataset.server)), { x: e.clientX, y: e.clientY });
  };
  // Drag to reorder servers.
  let dragId = null;
  rail.ondragstart = (e) => { const s = e.target.closest('[data-server]'); if (!s) return; dragId = Number(s.dataset.server); s.classList.add('dragging'); };
  rail.ondragend = () => { $$('.dragging, .drop-before', rail).forEach((x) => x.classList.remove('dragging', 'drop-before')); };
  rail.ondragover = (e) => {
    const s = e.target.closest('[data-server]');
    if (!dragId || !s) return;
    e.preventDefault();
    $$('.drop-before', rail).forEach((x) => x.classList.remove('drop-before'));
    s.classList.add('drop-before');
  };
  rail.ondrop = (e) => {
    const s = e.target.closest('[data-server]');
    if (!dragId || !s) return;
    e.preventDefault();
    const target = Number(s.dataset.server);
    const order = state.serverOrder.filter((x) => x !== dragId);
    order.splice(order.indexOf(target), 0, dragId);
    state.serverOrder = order;
    dragId = null;
    renderRail();
    PUT('/users/@me/server-order', { ids: order }).catch(errToast);
  };
}
function typingTitle(typers, serverId, where) {
  return typers.map((t) => `${displayName(t.user_id, serverId)} is typing in ${where} (for ${Math.max(1, Math.round((Date.now() - t.since) / 1000))}s)`).join('\n');
}

const anyUnread = () => [...state.servers.values()].some(serverUnread) || [...state.dms.values()].some((d) => isUnread(d) && !isMuted(d.id));

// Mark every server channel and DM as read.
export async function readAll() {
  for (const ch of [...state.dms.values(), ...[...state.servers.values()].flatMap((s) => s.channels)]) {
    if (ch.last_message_id) state.readStates.set(ch.id, { channel_id: ch.id, last_read_id: ch.last_message_id, mention_count: 0 });
  }
  emit('unread');
  try { await POST('/ack-all'); toast('All caught up! Everything is marked as read. ✅', 'ok'); } catch (e) { errToast(e); }
}

let lastHomePath = '/channels/@me';
const lastHome = () => lastHomePath;

export function serverMenu(s, at) {
  if (!s) return;
  const n = state.notify.get(s.id);
  const level = n?.level || 'default';
  const canManage = has(s.permissions, P.MANAGE_SERVER) || has(s.permissions, P.MANAGE_ROLES) || has(s.permissions, P.MANAGE_EMOJIS) || has(s.permissions, P.BAN_MEMBERS) || has(s.permissions, P.VIEW_AUDIT_LOG) || has(s.permissions, P.KICK_MEMBERS);
  menu([
    { label: 'Mark As Read', action: () => POST(`/servers/${s.id}/ack`).catch(errToast) },
    { sep: true },
    { label: 'Invite People (PIN)', icon: 'key', action: () => openInvite(s) },
    { label: 'Server Info & Reviews', icon: 'star', action: () => import('./server-info.js').then((m) => m.openServerInfo(s.id)) },
    { label: isMuted(s.id) ? 'Unmute Server' : 'Mute Server', icon: isMuted(s.id) ? 'bell' : 'bellOff', action: () => setNotify(s.id, { muted: !isMuted(s.id), level: n?.level ?? null }) },
    { header: 'Notifications' },
    ...[['default', 'Default'], ['all', 'All Messages'], ['mentions', 'Only @mentions'], ['none', 'Nothing']].map(([v, label]) => ({
      label, checked: level === v, action: () => setNotify(s.id, { level: v === 'default' ? null : v, muted: !!n?.muted }),
    })),
    { sep: true },
    { label: 'Server Settings', icon: 'settings', hidden: !canManage, action: () => openServerSettings(s.id) },
    { label: 'Create Channel', icon: 'plusCircle', hidden: !has(s.permissions, P.MANAGE_CHANNELS), action: () => openCreateChannel(s) },
    { label: 'Create Category', icon: 'plusCircle', hidden: !has(s.permissions, P.MANAGE_CHANNELS), action: () => openCreateChannel(s, { category: true }) },
    { label: 'Edit Server Profile', icon: 'edit', action: () => editNickname(s, state.user.id) },
    { sep: true },
    { label: 'Leave Server', danger: true, hidden: s.owner_id === state.user.id, action: () => leaveServer(s) },
    { label: 'Copy Server ID', icon: 'copy', action: () => copyText(String(s.id)) },
  ], at);
}

export async function setNotify(target, body) {
  try { await PUT(`/users/@me/notify/${target}`, body); } catch (e) { errToast(e); }
}

async function leaveServer(s) {
  if (!(await confirmDialog({ title: `Leave '${s.name}'`, text: `Are you sure you want to leave <b>${esc(s.name)}</b>? You'll need the PIN to rejoin.`, confirm: 'Leave Server', danger: true }))) return;
  try { await DEL(`/servers/${s.id}/members/@me`); toast(`You left ${s.name}.`); } catch (e) { errToast(e); }
}

export async function editNickname(s, userId) {
  const m = await getMember(s.id, userId);
  const v = await promptDialog({ title: userId === state.user.id ? 'Change Nickname' : `Change ${displayName(userId)}'s nickname`, label: 'Nickname', value: m?.nickname || '', placeholder: getUser(userId)?.display_name || getUser(userId)?.username, maxlength: 32, hint: 'Leave empty to reset.' });
  if (v == null) return;
  try { await PATCH(`/servers/${s.id}/members/${userId}`, { nickname: v }); } catch (e) { errToast(e); }
}

export async function loadMembers(serverId, force = false) {
  if (state.members.has(serverId) && !force) return state.members.get(serverId);
  const list = await GET(`/servers/${serverId}/members`);
  const map = new Map();
  for (const m of list) { cacheUser(m.user); map.set(m.user.id, m); }
  state.members.set(serverId, map);
  emit('members', serverId);
  return map;
}
export async function getMember(serverId, userId) {
  const map = await loadMembers(serverId);
  return map.get(userId);
}

// ---------- Sidebar ----------
function renderSidebar() {
  const head = $('.sb-head', shell);
  const scroll = $('.sidebar-scroll', shell);
  const s = currentServer();
  if (!s) {
    head.innerHTML = `<div class="sidebar-search"><button data-find>Find or start a conversation</button></div>`;
    head.onclick = (e) => { if (e.target.closest('[data-find]')) openNewDM(); };
    const r = state.route;
    const pending = [...state.relationships.values()].filter((x) => x.type === 'incoming').length;
    scroll.innerHTML = `
      <div class="nav-item ${!r.channelId ? 'active' : ''}" data-friends>${icon('users')}<span>Friends</span>${pending ? `<span class="badge">${pending}</span>` : ''}</div>
      <div class="nav-item" data-mentions>${icon('at')}<span>Mentions</span></div>
      <div class="section-title"><span>Direct Messages</span><button class="icon-btn" data-newdm title="Create DM">${icon('plus')}</button></div>
      ${[...state.dms.values()].map((d) => {
        const other = d.type === 'dm' ? d.recipients[0] : null;
        const dmTypers = typingIn(d.id);
        const sub = dmTypers.length
          ? `<span class="typing-dots inline"><i></i><i></i><i></i></span> ${esc(dmTypers.map((t) => displayName(t.user_id)).join(', '))} ${dmTypers.length === 1 ? 'is' : 'are'} typing…`
          : d.type === 'group' ? `${d.recipients.length + 1} Members` : other ? customStatusHtml(getUser(other.id)) : '';
        const mc = mentionCount(d.id);
        return `<div class="dm-item ${r.channelId === d.id ? 'active' : ''} ${isUnread(d) && !isMuted(d.id) ? 'unread' : ''}" data-dm="${d.id}">
          ${other ? avatarHtml(getUser(other.id) || other, { status: true }) : `<div class="avatar" style="background:var(--mint)">${icon('users')}</div>`}
          <div class="info"><div class="n">${emojify(esc(dmName(d)))}</div>${sub ? `<div class="s">${sub}</div>` : ''}</div>
          ${mc ? `<span class="badge">${mc}</span>` : ''}
          <button class="icon-btn close" data-close="${d.id}" title="Close DM">${icon('x')}</button>
        </div>`;
      }).join('') || '<div class="faint small" style="padding:8px">No conversations yet. Say hi to a friend!</div>'}
    `;
    scroll.onclick = (e) => {
      const c = e.target.closest('[data-close]');
      if (c) { e.stopPropagation(); DEL(`/channels/${c.dataset.close}`).catch(errToast); return; }
      if (e.target.closest('[data-friends], [data-dm]')) closeNav();
      if (e.target.closest('[data-friends]')) return navigate('/channels/@me');
      if (e.target.closest('[data-mentions]')) return import('./panels.js').then((m) => m.openMentions());
      if (e.target.closest('[data-newdm]')) return openNewDM();
      const d = e.target.closest('[data-dm]');
      if (d) navigate(channelPath('@me', Number(d.dataset.dm)));
    };
    scroll.oncontextmenu = (e) => {
      const d = e.target.closest('[data-dm]');
      if (!d) return;
      e.preventDefault();
      dmMenu(state.dms.get(Number(d.dataset.dm)), { x: e.clientX, y: e.clientY });
    };
    return;
  }

  if (!state.members.has(s.id)) loadMembers(s.id).catch(() => {});
  const counts = serverCounts(s);
  const counter = `<div class="member-counter" data-info title="Server info & reviews">
    <span><i class="dot online"></i>${counts.online ?? '–'} Online</span>
    <span><i class="dot"></i>${counts.total} Member${counts.total === 1 ? '' : 's'}</span>
    ${counts.voice ? `<span class="voice-count">${icon('volume')}${counts.voice} in Voice</span>` : ''}
    ${s.rating?.count ? `<span class="rating">★ ${s.rating.average}</span>` : ''}</div>`;
  head.innerHTML = (s.banner
    ? `<div class="sidebar-header banner" style="background-image:linear-gradient(rgba(0,0,0,.35),transparent 60%),url('${esc(s.banner)}')"><span class="name">${esc(s.name)}</span>${icon('chevron')}</div>`
    : `<div class="sidebar-header"><span class="name">${esc(s.name)}</span>${icon('chevron')}</div>`) + counter
    + `<div class="sidebar-search"><button data-searchserver>${icon('search')} Search ${esc(s.name)}</button></div>`;
  head.onclick = (e) => {
    if (e.target.closest('[data-info]')) return import('./server-info.js').then((m) => m.openServerInfo(s.id));
    if (e.target.closest('[data-searchserver]')) return import('./panels.js').then((m) => m.openSearch({ serverId: s.id }));
    const h = e.target.closest('.sidebar-header');
    if (h) serverMenu(s, h);
  };

  const canManage = has(s.permissions, P.MANAGE_CHANNELS);
  const chs = orderedChannels(s);
  let html = '';
  let collapsed = false;
  for (const c of chs) {
    if (c.type === 'category') {
      collapsed = state.collapsed.has(c.id);
      html += `<div class="category ${collapsed ? 'collapsed' : ''}" data-cat="${c.id}" ${canManage ? 'draggable="true"' : ''}>
        ${icon('chevron', 'chev')}<span class="name">${esc(c.name)}</span>
        ${canManage ? `<button class="icon-btn" data-create="${c.id}" title="Create Channel">${icon('plus')}</button>` : ''}</div>`;
      continue;
    }
    const active = state.route.channelId === c.id;
    const unread = c.type !== 'voice' && isUnread(c) && !isMuted(c.id);
    const vstates = state.voice.get(c.id) || [];
    if (collapsed && !active && !unread && !vstates.length) continue;
    const mc = mentionCount(c.id);
    const typers = typingIn(c.id);
    const priv = c.overwrites?.some((o) => o.deny & P.VIEW_CHANNELS);
    html += `<div class="channel ${active ? 'active' : ''} ${unread ? 'unread' : ''} ${isMuted(c.id) ? 'muted' : ''}" data-ch="${c.id}" ${canManage ? 'draggable="true"' : ''}>
      ${icon(priv && c.type === 'text' ? 'lock' : CHANNEL_ICON[c.type] || 'hash', 'ic')}<span class="name">${emojify(esc(c.name))}</span>
      ${typers.length ? `<span class="typing-dots" title="${esc(typingTitle(typers, s.id, `#${c.name}`))}"><i></i><i></i><i></i></span>` : ''}
      ${mc ? `<span class="badge">${mc}</span>` : ''}
      ${canManage ? `<span class="actions"><button class="icon-btn" data-edit="${c.id}" title="Edit Channel">${icon('settings')}</button></span>` : ''}
    </div>`;
    if (vstates.length) {
      html += `<div class="voice-users">${vstates.map((v) => `<div class="voice-user" data-user="${v.user_id}">
        ${avatarHtml(v.user_id, { size: 's24', cls: voice.isSpeaking(v.user_id) ? 'speaking' : '' })}<span>${esc(displayName(v.user_id, s.id))}</span>
        <span class="flags">${v.screen ? '<span class="live">LIVE</span>' : ''}${v.video ? icon('video') : ''}${v.muted || v.server_muted ? icon('micOff') : ''}${v.deafened ? icon('headphonesOff') : ''}</span></div>`).join('')}</div>`;
    }
  }
  scroll.innerHTML = html || '<div class="faint small" style="padding:12px">No channels you can see yet.</div>';

  scroll.onclick = (e) => {
    const ed = e.target.closest('[data-edit]');
    if (ed) { e.stopPropagation(); return openChannelSettings(Number(ed.dataset.edit)); }
    const cr = e.target.closest('[data-create]');
    if (cr) { e.stopPropagation(); return openCreateChannel(s, { parentId: Number(cr.dataset.create) }); }
    const cat = e.target.closest('[data-cat]');
    if (cat) {
      const id = Number(cat.dataset.cat);
      state.collapsed.has(id) ? state.collapsed.delete(id) : state.collapsed.add(id);
      saveCollapsed();
      return renderSidebar();
    }
    const vu = e.target.closest('.voice-user');
    if (vu) return openProfile(Number(vu.dataset.user), vu, { serverId: s.id });
    const ch = e.target.closest('[data-ch]');
    if (!ch) return;
    const c = s.channels.find((x) => x.id === Number(ch.dataset.ch));
    closeNav();
    if (c.type === 'voice') {
      if (voice.current()?.channelId !== c.id) voice.join(c.id);
    }
    navigate(channelPath(s.id, c.id));
  };
  scroll.oncontextmenu = (e) => {
    const ch = e.target.closest('[data-ch], [data-cat]');
    if (ch) { e.preventDefault(); return channelMenu(s, Number(ch.dataset.ch || ch.dataset.cat), { x: e.clientX, y: e.clientY }); }
    const vu = e.target.closest('.voice-user');
    if (vu) { e.preventDefault(); userMenu(Number(vu.dataset.user), { x: e.clientX, y: e.clientY }, { serverId: s.id, voice: true }); }
  };

  // Drag & drop channel ordering.
  if (canManage) {
    let drag = null;
    scroll.ondragstart = (e) => {
      const t = e.target.closest('[data-ch], [data-cat]');
      if (!t) return;
      drag = { id: Number(t.dataset.ch || t.dataset.cat), cat: !!t.dataset.cat };
      e.dataTransfer.effectAllowed = 'move';
    };
    scroll.ondragover = (e) => {
      if (!drag) return;
      const t = e.target.closest('[data-ch], [data-cat]');
      if (!t) return;
      e.preventDefault();
      $$('.drop-before, .drop-inside', scroll).forEach((x) => x.classList.remove('drop-before', 'drop-inside'));
      t.classList.add(t.dataset.cat && !drag.cat ? 'drop-inside' : 'drop-before');
    };
    scroll.ondragend = () => { drag = null; $$('.drop-before, .drop-inside', scroll).forEach((x) => x.classList.remove('drop-before', 'drop-inside')); };
    scroll.ondrop = async (e) => {
      const t = e.target.closest('[data-ch], [data-cat]');
      if (!drag || !t) return;
      e.preventDefault();
      const targetId = Number(t.dataset.ch || t.dataset.cat);
      const target = s.channels.find((c) => c.id === targetId);
      const moving = s.channels.find((c) => c.id === drag.id);
      if (!moving || !target || moving.id === target.id) return;
      let items;
      if (drag.cat) {
        const cats = s.channels.filter((c) => c.type === 'category').sort((a, b) => a.position - b.position).filter((c) => c.id !== moving.id);
        const tcat = target.type === 'category' ? target : s.channels.find((c) => c.id === target.parent_id);
        const idx = tcat ? cats.findIndex((c) => c.id === tcat.id) : cats.length;
        cats.splice(idx < 0 ? cats.length : idx, 0, moving);
        items = cats.map((c, i) => ({ id: c.id, position: i }));
      } else {
        const parent = target.type === 'category' ? target.id : target.parent_id || null;
        const siblings = s.channels.filter((c) => c.type !== 'category' && (c.parent_id || null) === parent && c.id !== moving.id)
          .sort((a, b) => a.position - b.position);
        const idx = target.type === 'category' ? siblings.length : siblings.findIndex((c) => c.id === target.id);
        siblings.splice(idx, 0, moving);
        items = siblings.map((c, i) => ({ id: c.id, position: i, parent_id: parent }));
      }
      drag = null;
      try { await PUT(`/servers/${s.id}/channels`, { channels: items }); } catch (err) { errToast(err); }
    };
  }
}

function channelMenu(s, id, at) {
  const c = s.channels.find((x) => x.id === id);
  if (!c) return;
  const n = state.notify.get(c.id);
  const canManage = has(s.permissions, P.MANAGE_CHANNELS);
  const isCat = c.type === 'category';
  menu([
    { label: 'Mark As Read', hidden: isCat || c.type === 'voice', action: () => POST(`/channels/${c.id}/ack`).catch(errToast) },
    { label: isMuted(c.id) ? `Unmute ${isCat ? 'Category' : 'Channel'}` : `Mute ${isCat ? 'Category' : 'Channel'}`, action: () => setNotify(c.id, { muted: !isMuted(c.id), level: n?.level ?? null }) },
    { header: 'Notifications', hidden: isCat },
    ...(isCat ? [] : [['default', 'Use Server Default'], ['all', 'All Messages'], ['mentions', 'Only @mentions'], ['none', 'Nothing']].map(([v, label]) => ({
      label, checked: (n?.level || 'default') === v, action: () => setNotify(c.id, { level: v === 'default' ? null : v, muted: !!n?.muted }),
    }))),
    { sep: true },
    { label: `Edit ${isCat ? 'Category' : 'Channel'}`, icon: 'settings', hidden: !canManage, action: () => openChannelSettings(c.id) },
    { label: 'Create Channel', icon: 'plusCircle', hidden: !canManage || !isCat, action: () => openCreateChannel(s, { parentId: c.id }) },
    { label: `Delete ${isCat ? 'Category' : 'Channel'}`, danger: true, hidden: !canManage, action: () => deleteChannel(c) },
    { sep: true },
    { label: 'Copy Link', icon: 'link', hidden: isCat, action: () => copyText(`${location.origin}${channelPath(s.id, c.id)}`) },
    { label: 'Copy Channel ID', icon: 'copy', action: () => copyText(String(c.id)) },
  ], at);
}

export async function deleteChannel(c) {
  if (!(await confirmDialog({ title: `Delete ${c.type === 'category' ? 'Category' : 'Channel'}`, text: `Are you sure you want to delete <b>${esc(c.name)}</b>? This cannot be undone.`, confirm: 'Delete', danger: true }))) return;
  try { await DEL(`/channels/${c.id}`); toast('Deleted.'); } catch (e) { errToast(e); }
}

function dmMenu(d, at) {
  if (!d) return;
  const other = d.type === 'dm' ? d.recipients[0] : null;
  menu([
    { label: 'Mark As Read', action: () => POST(`/channels/${d.id}/ack`).catch(errToast) },
    { label: 'Profile', hidden: !other, action: () => openProfile(other.id, at) },
    { label: 'Call', icon: 'phone', action: () => { navigate(channelPath('@me', d.id)); voice.join(d.id); } },
    { label: isMuted(d.id) ? 'Unmute Conversation' : 'Mute Conversation', action: () => setNotify(d.id, { muted: !isMuted(d.id) }) },
    { label: 'Rename Group', hidden: d.type !== 'group', action: async () => {
      const v = await promptDialog({ title: 'Rename Group', label: 'Group name', value: d.name || '' });
      if (v != null) PATCH(`/channels/${d.id}`, { name: v }).catch(errToast);
    } },
    { sep: true },
    { label: d.type === 'group' ? 'Leave Group' : 'Close DM', danger: d.type === 'group', action: () => DEL(`/channels/${d.id}`).catch(errToast) },
    { label: 'Copy ID', icon: 'copy', action: () => copyText(String(d.id)) },
  ], at);
}

export function openNewDM() {
  const friends = [...state.relationships].filter(([, r]) => r.type === 'friend').map(([id]) => getUser(id)).filter(Boolean);
  const picked = new Set();
  const m = modal({
    title: 'Select Friends',
    subtitle: 'Pick one friend for a DM, or up to 9 for a group chat.',
    body: `<input class="input" placeholder="Type the username of a friend" data-q style="margin-bottom:10px">
      <div data-list style="max-height:320px;overflow:auto"></div>`,
    buttons: [{ label: 'Cancel', cls: 'ghost' }, {
      label: 'Create DM', action: async () => {
        if (!picked.size) { toast('Pick at least one friend.', 'error'); return false; }
        try {
          const dm = await POST('/dms', { recipients: [...picked] });
          navigate(channelPath('@me', dm.id));
        } catch (e) { errToast(e); return false; }
      },
    }],
  });
  const list = $('[data-list]', m.body);
  const draw = () => {
    const q = $('[data-q]', m.body).value.trim().toLowerCase();
    const items = friends.filter((u) => !q || u.username.includes(q) || (u.display_name || '').toLowerCase().includes(q));
    list.innerHTML = items.map((u) => `<label class="friend-row" style="border:0"><input type="checkbox" value="${u.id}" ${picked.has(u.id) ? 'checked' : ''} style="accent-color:var(--mint);width:18px;height:18px">
      ${avatarHtml(u)}<div class="info"><div class="n">${esc(u.display_name || u.username)}</div><div class="s">${esc(u.username)}</div></div></label>`).join('')
      || '<div class="empty">No friends found. Add friends from the Friends tab.</div>';
  };
  draw();
  $('[data-q]', m.body).oninput = draw;
  list.onchange = (e) => {
    const id = Number(e.target.value);
    if (e.target.checked) { if (picked.size >= 9) { e.target.checked = false; return; } picked.add(id); } else picked.delete(id);
  };
}

// ---------- Main ----------
function renderMain() {
  const slot = $('.chat-slot', shell);
  const r = state.route;
  const ch = currentChannel();
  const key = r.serverId === '@me' && !r.channelId ? 'friends' : ch ? `ch:${ch.id}:${ch.type}` : 'none';
  if (key === mainKey && mainView) return;
  mainView?.destroy?.();
  mainView = null;
  mainKey = key;
  slot.innerHTML = '';
  if (r.serverId === '@me') lastHomePath = channelPath('@me', r.channelId);
  if (key === 'friends') { mainView = mountFriends(slot); return; }
  if (!ch) { slot.innerHTML = `<div class="empty" style="margin:auto"><img src="/icons/logo.png" alt=""><div>Pick a channel to start yapping.</div></div>`; return; }
  if (ch.server_id) rememberChannel(ch.server_id, ch.id);
  if (ch.type === 'voice') { mainView = voice.mountVoiceRoom(slot, ch); return; }
  mainView = mountChat(slot, ch);
}

// ---------- Members ----------
async function renderMembers() {
  const box = $('.members', shell);
  const s = currentServer();
  const ch = currentChannel();
  const hide = state.user.settings?.hideMembers && !isMobile();
  const show = ch && ch.type !== 'voice' && (s || ch.type === 'group');
  box.hidden = !show || hide;
  shell.classList.toggle('with-members', !!show && !hide);
  if (!show) { shell.classList.remove('members-open'); return; }
  if (ch.type === 'group') {
    const users = [state.user, ...ch.recipients.map((u) => getUser(u.id) || u)];
    box.innerHTML = `<div class="group">Members — ${users.length}</div>${users.map((u) => memberRow(u, null, ch.owner_id === u.id)).join('')}`;
    bindMemberClicks(box, null);
    return;
  }
  let map = state.members.get(s.id);
  if (!map) {
    box.innerHTML = '<div class="group">Loading…</div>';
    try { map = await loadMembers(s.id); } catch { return; }
    return; // loadMembers emits 'members' which re-renders.
  }
  const viewers = [...map.values()];
  const roles = sortedRoles(s).filter((r) => r.hoist && !r.is_default);
  const groups = new Map(roles.map((r) => [r.id, []]));
  const online = [], offline = [];
  for (const m of viewers) {
    const st = statusOf(getUser(m.user.id) || m.user);
    if (st === 'offline') { offline.push(m); continue; }
    const hoisted = roles.find((r) => m.roles.includes(r.id));
    (hoisted ? groups.get(hoisted.id) : online).push(m);
  }
  const byName = (a, b) => displayName(a.user.id, s.id).localeCompare(displayName(b.user.id, s.id));
  let html = '';
  for (const r of roles) {
    const list = groups.get(r.id);
    if (list.length) html += `<div class="group">${esc(r.name)} — ${list.length}</div>${list.sort(byName).map((m) => memberRow(m.user, s, s.owner_id === m.user.id)).join('')}`;
  }
  if (online.length) html += `<div class="group">Online — ${online.length}</div>${online.sort(byName).map((m) => memberRow(m.user, s, s.owner_id === m.user.id)).join('')}`;
  if (offline.length) html += `<div class="group">Offline — ${offline.length}</div>${offline.sort(byName).slice(0, 200).map((m) => memberRow(m.user, s, s.owner_id === m.user.id)).join('')}`;
  box.innerHTML = html;
  bindMemberClicks(box, s);
}

function memberRow(user, s, owner) {
  const u = getUser(user.id) || user;
  const st = statusOf(u);
  const m = s ? state.members.get(s.id)?.get(u.id) : null;
  const timedOut = m?.timeout_until && m.timeout_until > Date.now();
  return `<div class="member ${st === 'offline' ? 'offline' : ''}" data-user="${u.id}">
    ${avatarHtml(u, { status: true })}
    <div class="info"><div class="n"><span ${nameAttrs(s?.id, u.id, '', 'overflow:hidden;text-overflow:ellipsis')}>${emojify(esc(displayName(u.id, s?.id)))}</span>${owner ? `<span title="Owner">${icon('crown', 'crown')}</span>` : ''}${timedOut ? `<span title="Timed out for ${fmtDuration(m.timeout_until - Date.now())}">${icon('timer', 'crown')}</span>` : ''}</div>
    ${u.custom_status || u.custom_status_emoji ? `<div class="s">${customStatusHtml(u)}</div>` : ''}</div>
  </div>`;
}

function bindMemberClicks(box, s) {
  box.onclick = (e) => {
    const m = e.target.closest('[data-user]');
    if (m) openProfile(Number(m.dataset.user), m, { serverId: s?.id, side: 'left' });
  };
  box.oncontextmenu = (e) => {
    const m = e.target.closest('[data-user]');
    if (!m) return;
    e.preventDefault();
    userMenu(Number(m.dataset.user), { x: e.clientX, y: e.clientY }, { serverId: s?.id });
  };
}

// ---------- User panel ----------
function renderUserPanel() {
  const p = $('.user-panel', shell);
  const u = state.user;
  const st = statusOf(u);
  const v = voice.prefs();
  const bg = u.settings?.bgMusic || {};
  p.innerHTML = `
    <div class="me" title="Set status">${avatarHtml(u, { status: true })}
      <div style="min-width:0"><div class="n">${esc(u.display_name || u.username)}</div><div class="s">${customStatusHtml(u) || esc(STATUS_LABEL[u.set_status] || STATUS_LABEL[st])}</div></div></div>
    <button class="icon-btn ${v.muted ? 'danger active' : ''}" data-mute title="${v.muted ? 'Unmute' : 'Mute'}">${icon(v.muted ? 'micOff' : 'mic')}</button>
    <button class="icon-btn ${v.deafened ? 'danger active' : ''}" data-deaf title="${v.deafened ? 'Undeafen' : 'Deafen'}">${icon(v.deafened ? 'headphonesOff' : 'headphones')}</button>
    ${bg.url ? `<button class="icon-btn ${bg.enabled ? 'active' : ''}" data-music title="${bg.enabled ? 'Pause' : 'Play'} background music">${icon(bg.enabled ? 'music' : 'musicOff')}</button>` : ''}
    <button class="icon-btn" data-settings title="User Settings">${icon('settings')}</button>`;
  p.onclick = (e) => {
    if (e.target.closest('[data-settings]')) return openSettings();
    if (e.target.closest('[data-music]')) return import('../music.js').then((m) => m.toggle());
    if (e.target.closest('[data-mute]')) { voice.toggleMute(); return renderUserPanel(); }
    if (e.target.closest('[data-deaf]')) { voice.toggleDeafen(); return renderUserPanel(); }
    const me = e.target.closest('.me');
    if (me) statusMenu(me);
  };
}
on('voice_prefs', () => renderUserPanel());
on('music', () => renderUserPanel());

function statusMenu(anchor) {
  const set = (status) => PATCH('/users/@me', { status }).then((u) => { state.user = u; emit('self'); }).catch(errToast);
  const dot = (s) => `<span class="status-icon status-dot ${s}" style="position:static;border:0;width:10px;height:10px;display:inline-block;margin-right:8px"></span>`;
  menu([
    { html: `${dot('online')}Online`, action: () => set('online') },
    { html: `${dot('idle')}Idle`, action: () => set('idle') },
    { html: `${dot('dnd')}Do Not Disturb`, action: () => set('dnd') },
    { html: `${dot('offline')}Invisible`, action: () => set('invisible') },
    { sep: true },
    { label: state.user.custom_status || state.user.custom_status_emoji ? 'Edit Custom Status' : 'Set Custom Status', icon: 'smile', action: () => import('./settings.js').then((m) => m.openCustomStatus()) },
    { label: 'Edit Profile', icon: 'edit', action: () => openSettings('profile') },
    { label: 'Copy User ID', icon: 'copy', action: () => copyText(String(state.user.id)) },
  ], anchor);
}

// ---------- Voice panel ----------
function renderVoicePanel() {
  const slot = $('.vp-slot', shell);
  const v = voice.current();
  if (!v) { slot.innerHTML = ''; return; }
  const ch = channelById(v.channelId);
  const s = ch?.server_id ? state.servers.get(ch.server_id) : null;
  const where = ch ? (s ? `${esc(ch.name)} / ${esc(s.name)}` : esc(dmName(ch))) : '';
  slot.innerHTML = `<div class="voice-panel">
    <div class="status"><div class="grow" style="cursor:pointer" data-go><div class="t">${v.connecting ? 'Connecting…' : 'Voice Connected'}</div><div class="where">${where}</div></div>
      <button class="icon-btn danger" data-leave title="Disconnect">${icon('phoneOff')}</button></div>
    <div class="controls">
      <button class="btn ${v.video ? 'on' : ''}" data-video title="Camera">${icon(v.video ? 'video' : 'videoOff')}</button>
      <button class="btn ${v.screen ? 'on' : ''}" data-screen title="Share Screen">${icon('screen')}</button>
    </div></div>`;
  slot.onclick = (e) => {
    if (e.target.closest('[data-leave]')) return voice.leave();
    if (e.target.closest('[data-video]')) return voice.toggleVideo();
    if (e.target.closest('[data-screen]')) return voice.toggleScreen();
    if (e.target.closest('[data-go]') && ch) navigate(channelPath(ch.server_id || '@me', ch.id));
  };
}

