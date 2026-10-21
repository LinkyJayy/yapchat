// User profile popout and user context menu (with moderation actions).
import { $, el, esc, toast, errToast, copyText, fmtDate, fmtDuration } from '../dom.js';
import { icon } from '../icons.js';
import { state, P, has, getUser, cacheUser, displayName, sortedRoles, relationship, memberOf } from '../store.js';
import { GET, POST, PUT, PATCH, DEL } from '../api.js';
import { avatarHtml, customStatusHtml } from './components.js';
import { popout, closePopout, menu, modal, confirmDialog } from './layers.js';
import { navigate, channelPath } from '../router.js';
import { renderMarkdown } from '../markdown.js';
import { emojify } from '../emoji.js';

export async function openDM(userId) {
  try {
    const dm = await POST('/dms', { recipient: userId });
    navigate(channelPath('@me', dm.id));
  } catch (e) { errToast(e); }
}

function rolesHtml(s, m, canManage) {
  const roles = sortedRoles(s).filter((r) => !r.is_default && m.roles.includes(r.id));
  return `<div class="roles">${roles.map((r) => `<span class="role-chip"><span class="dot" style="background:${r.color || 'var(--offline)'}"></span>${esc(r.name)}${canManage ? `<button data-rmrole="${r.id}" title="Remove role">${icon('x')}</button>` : ''}</span>`).join('')}
    ${canManage ? `<button class="role-chip" data-addrole title="Add role">${icon('plus')}</button>` : ''}${!roles.length && !canManage ? '<span class="faint small">No roles</span>' : ''}</div>`;
}

export async function openProfile(userId, anchor, { serverId = null, side = 'right' } = {}) {
  let data;
  try { data = await GET(`/users/${userId}`); } catch (e) { return errToast(e); }
  const u = cacheUser(data.user);
  const s = serverId ? state.servers.get(serverId) : null;
  let m = s ? memberOf(s.id, userId) : null;
  if (s && !m) { try { m = (await import('./app.js').then((x) => x.getMember(s.id, userId))) || null; } catch { /* ignore */ } }
  const me = state.user.id === userId;
  const canManageRoles = s && m && has(s.permissions, P.MANAGE_ROLES);
  const rel = relationship(userId);
  const color = u.accent_color || 'var(--mint)';
  const node = el(`<div class="profile">
    <div class="banner" style="${u.banner ? `background-image:url('${esc(u.banner)}')` : `background:${color}`}"></div>
    <div class="av">${avatarHtml(u, { status: true })}</div>
    <div class="body">
      <div class="dn">${emojify(esc(s ? displayName(userId, s.id) : u.display_name || u.username))}</div>
      <div class="un">${esc(u.username)}${u.pronouns ? ` · ${esc(u.pronouns)}` : ''}</div>
      ${u.custom_status || u.custom_status_emoji ? `<div class="custom-status">${customStatusHtml(u)}</div>` : ''}
      ${u.bio ? `<div class="card"><h4>About Me</h4><div class="bio content">${renderMarkdown(u.bio)}</div></div>` : ''}
      <div class="card"><h4>Member Since</h4><div class="small">Yapper: ${fmtDate(u.created_at)}${m ? ` · ${esc(s.name)}: ${fmtDate(m.joined_at)}` : ''}</div></div>
      ${m ? `<div class="card"><h4>Roles</h4><div data-roles>${rolesHtml(s, m, canManageRoles)}</div></div>` : ''}
      ${m?.timeout_until ? `<div class="card"><h4>Timed Out</h4><div class="small">For ${fmtDuration(m.timeout_until - Date.now())} more.</div></div>` : ''}
      ${!me ? `<div class="card"><h4>Note</h4><textarea class="note" placeholder="Click to add a note" maxlength="256">${esc(data.note)}</textarea></div>` : ''}
      ${data.mutual_servers.length && !me ? `<div class="tiny muted" style="margin-top:10px">${data.mutual_servers.length} mutual server${data.mutual_servers.length === 1 ? '' : 's'}${data.mutual_friends.length ? ` · ${data.mutual_friends.length} mutual friend${data.mutual_friends.length === 1 ? '' : 's'}` : ''}</div>` : ''}
      <div class="row" style="margin-top:12px">
        ${me ? '<button class="btn block" data-edit>Edit Profile</button>' : `
          <button class="btn grow" data-msg>${icon('message')} Message</button>
          ${rel === 'friend' || rel === 'blocked' ? '' : rel === 'outgoing' ? '<button class="btn secondary" disabled>Request Sent</button>' : `<button class="btn secondary" data-add>${icon('userPlus')}</button>`}
          <button class="btn secondary" data-more>${icon('more')}</button>`}
      </div>
    </div></div>`);
  const pop = popout(node, anchor, { side });
  pop.style.setProperty('--status-ring', 'var(--bg-float)');

  node.addEventListener('click', async (e) => {
    if (e.target.closest('[data-edit]')) { closePopout(); return import('./settings.js').then((x) => x.openSettings('profile')); }
    if (e.target.closest('[data-msg]')) { closePopout(); return openDM(userId); }
    if (e.target.closest('[data-add]')) {
      try { await POST('/relationships', { user_id: userId }); toast('Friend request sent!', 'ok'); e.target.closest('[data-add]').outerHTML = '<button class="btn secondary" disabled>Request Sent</button>'; } catch (err) { errToast(err); }
      return;
    }
    const more = e.target.closest('[data-more]');
    if (more) return userMenu(userId, more, { serverId });
    const rm = e.target.closest('[data-rmrole]');
    if (rm) {
      const roles = m.roles.filter((r) => r !== Number(rm.dataset.rmrole));
      try { m = await PATCH(`/servers/${s.id}/members/${userId}`, { roles }); $('[data-roles]', node).innerHTML = rolesHtml(s, m, canManageRoles); } catch (err) { errToast(err); }
      return;
    }
    const add = e.target.closest('[data-addrole]');
    if (add) {
      const avail = sortedRoles(s).filter((r) => !r.is_default && !m.roles.includes(r.id));
      if (!avail.length) return toast('No more roles to add.');
      menu(avail.map((r) => ({
        html: `<span class="row" style="gap:8px"><span class="status-icon" style="background:${r.color || 'var(--offline)'}"></span>${esc(r.name)}</span>`,
        action: async () => {
          try { m = await PATCH(`/servers/${s.id}/members/${userId}`, { roles: [...m.roles, r.id] }); $('[data-roles]', node).innerHTML = rolesHtml(s, m, canManageRoles); } catch (err) { errToast(err); }
        },
      })), add);
    }
  });
  const note = $('.note', node);
  if (note) note.addEventListener('change', () => PUT(`/users/${userId}/note`, { note: note.value }).catch(errToast));
}

export function userMenu(userId, at, { serverId = null, voice = false } = {}) {
  const me = state.user.id === userId;
  const u = getUser(userId);
  const s = serverId ? state.servers.get(serverId) : null;
  const perms = s?.permissions || 0;
  const rel = relationship(userId);
  const isOwner = s?.owner_id === userId;
  const canMod = (flag) => s && !me && !isOwner && has(perms, flag);
  menu([
    { label: 'Profile', action: () => openProfile(userId, at instanceof Element ? at : { x: at.x, y: at.y }, { serverId }) },
    { label: 'Message', hidden: me, action: () => openDM(userId) },
    { label: 'Call', icon: 'phone', hidden: me || rel === 'blocked', action: async () => {
      try { const dm = await POST('/dms', { recipient: userId }); navigate(channelPath('@me', dm.id)); (await import('./voice.js')).join(dm.id); } catch (e) { errToast(e); }
    } },
    { sep: true },
    { label: 'Change Nickname', hidden: !s || !(me ? has(perms, P.CHANGE_NICKNAME) || has(perms, P.MANAGE_NICKNAMES) : has(perms, P.MANAGE_NICKNAMES)), action: () => import('./app.js').then((x) => x.editNickname(s, userId)) },
    { label: 'Roles', hidden: !s || !has(perms, P.MANAGE_ROLES), action: () => rolesModal(s, userId) },
    { label: 'Add Friend', hidden: me || rel === 'friend' || rel === 'outgoing' || rel === 'blocked', action: () => POST('/relationships', { user_id: userId }).then(() => toast('Friend request sent!', 'ok')).catch(errToast) },
    { label: 'Remove Friend', hidden: rel !== 'friend', action: () => import('./friends.js').then((x) => x.removeFriend(userId)) },
    { label: rel === 'blocked' ? 'Unblock' : 'Block', hidden: me, danger: rel !== 'blocked', action: () => (rel === 'blocked' ? DEL(`/relationships/${userId}`).catch(errToast) : import('./friends.js').then((x) => x.blockUser(userId))) },
    { sep: true, hidden: !s || me },
    { label: 'Server Mute', hidden: !voice || !canMod(P.MUTE_MEMBERS), action: () => PATCH(`/servers/${s.id}/members/${userId}`, { voice_mute: !(state.voice.get(voiceChannelOf(userId)) || []).find((v) => v.user_id === userId)?.server_muted }).catch(errToast) },
    { label: 'Disconnect', hidden: !voice || !canMod(P.MOVE_MEMBERS), danger: true, action: () => PATCH(`/servers/${s.id}/members/${userId}`, { voice_disconnect: true }).catch(errToast) },
    { label: `Timeout ${u?.username || ''}`, hidden: !canMod(P.MODERATE_MEMBERS), danger: true, action: () => timeoutModal(s, userId) },
    { label: `Kick ${u?.username || ''}`, hidden: !canMod(P.KICK_MEMBERS), danger: true, action: () => kick(s, userId) },
    { label: `Ban ${u?.username || ''}`, hidden: !canMod(P.BAN_MEMBERS), danger: true, action: () => ban(s, userId) },
    { sep: true },
    { label: 'Copy User ID', icon: 'copy', action: () => copyText(String(userId)) },
  ], at);
}

function voiceChannelOf(userId) {
  for (const [cid, states] of state.voice) if (states.some((v) => v.user_id === userId)) return cid;
  return null;
}

export async function rolesModal(s, userId) {
  const { getMember } = await import('./app.js');
  const m = await getMember(s.id, userId);
  const sel = new Set(m?.roles || []);
  modal({
    title: `Roles for ${displayName(userId, s.id)}`,
    body: `<div class="radio-list">${sortedRoles(s).filter((r) => !r.is_default).map((r) => `<label class="radio-item"><input type="checkbox" value="${r.id}" ${sel.has(r.id) ? 'checked' : ''}>
      <span class="status-icon" style="background:${r.color || 'var(--offline)'}"></span>${esc(r.name)}</label>`).join('') || '<div class="muted">This server has no roles yet. Create some in Server Settings → Roles.</div>'}</div>`,
    buttons: [{ label: 'Cancel', cls: 'ghost' }, {
      label: 'Save', action: async (mm) => {
        const roles = [...mm.body.querySelectorAll('input:checked')].map((x) => Number(x.value));
        try { await PATCH(`/servers/${s.id}/members/${userId}`, { roles }); toast('Roles updated.', 'ok'); } catch (e) { errToast(e); return false; }
      },
    }],
  });
}

export function timeoutModal(s, userId) {
  const opts = [[60, '60 seconds'], [300, '5 minutes'], [600, '10 minutes'], [3600, '1 hour'], [86400, '1 day'], [604800, '1 week']];
  const m = memberOf(s.id, userId);
  modal({
    title: `Timeout ${displayName(userId, s.id)}`,
    subtitle: 'Members who are timed out can still read messages but can\'t chat, react, or join voice.',
    body: `<div class="field"><label>Duration</label><div class="radio-list">${opts.map(([v, l], i) => `<label class="radio-item"><input type="radio" name="d" value="${v}" ${i === 1 ? 'checked' : ''}>${l}</label>`).join('')}</div></div>
      <div class="field"><label>Reason</label><input class="input" data-reason maxlength="512" placeholder="Optional"></div>`,
    buttons: [
      ...(m?.timeout_until ? [{ label: 'Remove Timeout', cls: 'secondary', action: () => PATCH(`/servers/${s.id}/members/${userId}`, { timeout_until: null }).catch(errToast) }] : []),
      { label: 'Cancel', cls: 'ghost' },
      { label: 'Timeout', cls: 'danger', action: async (mm) => {
        const secs = Number(mm.body.querySelector('input[name=d]:checked').value);
        try { await PATCH(`/servers/${s.id}/members/${userId}`, { timeout_until: Date.now() + secs * 1000, reason: mm.body.querySelector('[data-reason]').value }); toast('Member timed out.'); } catch (e) { errToast(e); return false; }
      } },
    ],
  });
}

async function kick(s, userId) {
  if (!(await confirmDialog({ title: `Kick ${esc(displayName(userId, s.id))}`, text: `Are you sure you want to kick <b>${esc(displayName(userId, s.id))}</b> from the server? They can rejoin with the PIN.`, confirm: 'Kick', danger: true }))) return;
  try { await DEL(`/servers/${s.id}/members/${userId}`); toast('Member kicked.'); } catch (e) { errToast(e); }
}

export function ban(s, userId) {
  modal({
    title: `Ban ${displayName(userId, s.id)}`,
    subtitle: 'Banned users can\'t rejoin with the PIN until they are unbanned.',
    body: `<div class="field"><label>Delete Message History</label><select class="input" data-del>
        <option value="0">Don't delete any</option><option value="3600">Previous hour</option><option value="86400">Previous 24 hours</option><option value="604800">Previous 7 days</option></select></div>
      <div class="field"><label>Reason</label><input class="input" data-reason maxlength="512" placeholder="Optional"></div>`,
    buttons: [{ label: 'Cancel', cls: 'ghost' }, {
      label: 'Ban', cls: 'danger', action: async (mm) => {
        try {
          await PUT(`/servers/${s.id}/bans/${userId}`, { reason: mm.body.querySelector('[data-reason]').value, delete_seconds: Number(mm.body.querySelector('[data-del]').value) });
          toast('User banned.');
        } catch (e) { errToast(e); return false; }
      },
    }],
  });
}
