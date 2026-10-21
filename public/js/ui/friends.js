// Friends page (home).
import { $, el, esc, toast, errToast } from '../dom.js';
import { icon } from '../icons.js';
import { state, on, emit, getUser } from '../store.js';
import { POST, PUT, DEL } from '../api.js';
import { avatarHtml, statusOf, customStatusHtml, STATUS_LABEL } from './components.js';
import { navigate, channelPath } from '../router.js';
import { openProfile, userMenu } from './profile.js';
import { confirmDialog } from './layers.js';
import { emojify } from '../emoji.js';

let tab = 'online';

export function mountFriends(slot) {
  const root = el(`<div class="friends">
    <header class="chat-header">
      <button class="icon-btn menu-btn" data-nav aria-label="Open navigation">${icon('menu')}</button>
      <div class="title">${icon('users')}<span>Friends</span></div>
      <div class="tabs" style="margin-left:12px"></div>
    </header>
    <div class="install-slot"></div>
    <div class="friends-body"></div>
  </div>`);
  slot.append(root);
  const body = $('.friends-body', root);
  const tabs = $('.tabs', root);

  const render = () => {
    const rel = [...state.relationships.entries()].map(([id, r]) => ({ user: getUser(id), ...r })).filter((x) => x.user);
    const pending = rel.filter((r) => r.type === 'incoming' || r.type === 'outgoing');
    const incoming = pending.filter((r) => r.type === 'incoming').length;
    tabs.innerHTML = [
      ['online', 'Online'], ['all', 'All'], ['pending', `Pending${incoming ? ` <span class="badge">${incoming}</span>` : ''}`], ['blocked', 'Blocked'],
    ].map(([k, l]) => `<button class="tab ${tab === k ? 'active' : ''}" data-tab="${k}">${l}</button>`).join('') +
      `<button class="tab primary ${tab === 'add' ? 'active' : ''}" data-tab="add">Add Friend</button>`;

    if (tab === 'add') {
      body.innerHTML = `<h3 style="margin:0 0 4px;color:var(--text-strong)">Add Friend</h3>
        <p class="muted" style="margin:0 0 16px">You can add friends with their Yapper username.</p>
        <form class="row" data-add style="background:var(--bg-input);border-radius:10px;padding:8px 8px 8px 14px;border:1px solid var(--border)">
          <input class="grow" style="background:none;border:0;outline:none;min-height:36px" placeholder="You can add friends with their Yapper username." autocomplete="off" autocapitalize="none" maxlength="33">
          <button class="btn" type="submit">Send Request</button></form>
        <div class="empty"><img src="/icons/logo.png" alt=""><div>Yapper is better with friends!</div></div>`;
      const form = $('[data-add]', body);
      form.onsubmit = async (e) => {
        e.preventDefault();
        const v = form.querySelector('input').value.trim();
        if (!v) return;
        try { await POST('/relationships', { username: v }); toast(`Friend request sent to ${v}!`, 'ok'); form.querySelector('input').value = ''; } catch (err) { errToast(err); }
      };
      setTimeout(() => form.querySelector('input').focus(), 30);
      return;
    }
    let list;
    if (tab === 'online') list = rel.filter((r) => r.type === 'friend' && statusOf(r.user) !== 'offline');
    else if (tab === 'all') list = rel.filter((r) => r.type === 'friend');
    else if (tab === 'pending') list = pending;
    else list = rel.filter((r) => r.type === 'blocked');
    list.sort((a, b) => (a.user.display_name || a.user.username).localeCompare(b.user.display_name || b.user.username));
    const label = { online: 'Online', all: 'All Friends', pending: 'Pending', blocked: 'Blocked' }[tab];
    body.innerHTML = `<div class="label" style="margin-bottom:8px">${label} — ${list.length}</div>` + (list.map((r) => {
      const u = r.user;
      const st = statusOf(u);
      const sub = r.type === 'incoming' ? 'Incoming Friend Request' : r.type === 'outgoing' ? 'Outgoing Friend Request' : r.type === 'blocked' ? 'Blocked' : (customStatusHtml(u) || STATUS_LABEL[st]);
      let acts = '';
      if (r.type === 'friend') acts = `<button class="icon-btn" data-msg="${u.id}" title="Message">${icon('message')}</button><button class="icon-btn" data-more="${u.id}" title="More">${icon('more')}</button>`;
      else if (r.type === 'incoming') acts = `<button class="icon-btn ok" data-accept="${u.id}" title="Accept">${icon('check')}</button><button class="icon-btn danger" data-ignore="${u.id}" title="Ignore">${icon('x')}</button>`;
      else acts = `<button class="icon-btn danger" data-ignore="${u.id}" title="${r.type === 'blocked' ? 'Unblock' : 'Cancel'}">${icon('x')}</button>`;
      return `<div class="friend-row" data-user="${u.id}">${avatarHtml(u, { status: true, size: 's40' })}
        <div class="info"><div class="n">${emojify(esc(u.display_name || u.username))} <span class="muted small" style="font-weight:400">${esc(u.username)}</span></div><div class="s">${sub}</div></div>
        <div class="acts">${acts}</div></div>`;
    }).join('') || `<div class="empty"><img src="/icons/logo.png" alt=""><div>${tab === 'online' ? "No one's around to yap with right now." : tab === 'pending' ? 'There are no pending friend requests.' : tab === 'blocked' ? "You haven't blocked anyone." : "You don't have any friends yet. Add some!"}</div></div>`);
  };

  root.addEventListener('click', async (e) => {
    if (e.target.closest('[data-nav]')) return emit('open_nav');
    const t = e.target.closest('[data-tab]');
    if (t) { tab = t.dataset.tab; return render(); }
    const msg = e.target.closest('[data-msg]');
    if (msg) {
      try { const dm = await POST('/dms', { recipient: Number(msg.dataset.msg) }); navigate(channelPath('@me', dm.id)); } catch (err) { errToast(err); }
      return;
    }
    const acc = e.target.closest('[data-accept]');
    if (acc) return POST('/relationships', { user_id: Number(acc.dataset.accept) }).catch(errToast);
    const ig = e.target.closest('[data-ignore]');
    if (ig) return DEL(`/relationships/${ig.dataset.ignore}`).catch(errToast);
    const more = e.target.closest('[data-more]');
    if (more) return userMenu(Number(more.dataset.more), more, {});
    const row = e.target.closest('.friend-row');
    if (row) openProfile(Number(row.dataset.user), row);
  });

  const unsubs = [on('relationships', render), on('presence', render), on('user', render)];
  render();
  import('../notifications.js').then((n) => n.renderInstallTip($('.install-slot', root)));
  return { destroy: () => unsubs.forEach((u) => u()) };
}

export async function removeFriend(userId) {
  const u = getUser(userId);
  if (!(await confirmDialog({ title: `Remove '${esc(u?.display_name || u?.username)}'`, text: `Are you sure you want to remove <b>${esc(u?.display_name || u?.username)}</b> from your friends?`, confirm: 'Remove Friend', danger: true }))) return;
  DEL(`/relationships/${userId}`).catch(errToast);
}
export async function blockUser(userId) {
  const u = getUser(userId);
  if (!(await confirmDialog({ title: `Block ${esc(u?.display_name || u?.username)}?`, text: "They won't be able to message you, and their messages will be hidden. Blocking will also remove them from your friends.", confirm: 'Block', danger: true }))) return;
  PUT(`/relationships/${userId}/block`).catch(errToast);
}
