// Server creation/joining, PIN invites, and full server settings.
import { $, $$, el, esc, toast, errToast, copyText, fmtStamp, isMobile } from '../dom.js';
import { icon } from '../icons.js';
import { state, P, has, sortedRoles, displayName, getUser, cacheUser, emit, roleAttrs, roleSwatch, nameAttrs } from '../store.js';
import { GET, POST, PATCH, PUT, DEL, api } from '../api.js';
import { modal, layer, confirmDialog } from './layers.js';
import { navigate, channelPath } from '../router.js';
import { imagePickerHtml, bindImagePicker, avatarHtml } from './components.js';
import { PERM_GROUPS } from './perms.js';
import { customEmojiHtml } from '../emoji.js';

// ---------- Create / Join ----------
export function openCreateServer() {
  const m = modal({
    title: 'Create or Join a Server',
    subtitle: 'Your server is where you and your friends hang out. Make yours and start yapping.',
    body: `<div class="radio-list" style="margin-bottom:8px">
      <button class="radio-item" data-create style="justify-content:flex-start">${icon('plusCircle')}<b>Create My Own</b></button>
      <button class="radio-item" data-join style="justify-content:flex-start">${icon('key')}<b>Join a Server with a PIN</b></button></div>`,
  });
  $('[data-create]', m.body).onclick = () => { m.close(); createServer(); };
  $('[data-join]', m.body).onclick = () => { m.close(); joinServer(); };
}

function createServer() {
  const m = modal({
    title: 'Customize Your Server',
    subtitle: 'Give your new server a personality with a name and an icon. You can always change it later.',
    body: `<div class="field" style="align-items:center">${imagePickerHtml('icon', null, { label: 'Upload Icon' })}</div>
      <div class="field"><label>Server Name</label><input class="input" data-name maxlength="100" value="${esc(`${state.user.display_name || state.user.username}'s server`)}"></div>
      <p class="tiny muted">Every server gets a unique PIN. Only people with the PIN can join.</p>`,
    buttons: [{ label: 'Back', cls: 'ghost', action: () => { setTimeout(openCreateServer); } }, {
      label: 'Create', action: async (mm) => {
        const form = new FormData();
        form.append('name', $('[data-name]', mm.body).value);
        if (ic.file) form.append('icon', ic.file);
        try {
          const s = await api('POST', '/servers', form);
          if (!state.servers.has(s.id)) { state.servers.set(s.id, s); state.serverOrder.push(s.id); emit('servers'); }
          navigate(channelPath(s.id, s.channels.find((c) => c.type === 'text')?.id));
          setTimeout(() => openInvite(state.servers.get(s.id) || s, true), 300);
        } catch (e) { errToast(e); return false; }
      },
    }],
  });
  const ic = bindImagePicker(m.body, 'icon');
}

export function joinServer() {
  modal({
    title: 'Join a Server',
    subtitle: 'Enter the server PIN you were given.',
    body: `<div class="field"><label>Server PIN</label><input class="input pin-input" data-pin inputmode="numeric" autocomplete="off" maxlength="12" placeholder="••••••••"></div>
      <p class="tiny muted">PINs are 8 digits (or a custom 6–12 digit PIN set by the owner).</p>`,
    buttons: [{ label: 'Back', cls: 'ghost', action: () => { setTimeout(openCreateServer); } }, {
      label: 'Next', action: async (mm) => {
        const pin = $('[data-pin]', mm.body).value;
        try {
          const preview = await POST('/servers/preview', { pin });
          setTimeout(() => previewServer(preview, pin));
        } catch (e) { errToast(e); return false; }
      },
    }],
  });
}

// Show who's there and what people think before joining.
async function previewServer(p, pin) {
  const { counterHtml, ratingSummaryHtml, reviewHtml } = await import('./server-info.js');
  const { serverIconHtml } = await import('./components.js');
  modal({
    title: p.member ? "You're already in this server" : 'Join this server?',
    wide: true,
    body: `<div class="server-hero" ${p.banner ? `style="background-image:linear-gradient(transparent,var(--bg-modal)),url('${esc(p.banner)}')"` : ''}>
        <div class="hero-icon">${serverIconHtml(p)}</div>
        <div><div class="hero-name">${esc(p.name)}</div>${p.description ? `<div class="muted small">${esc(p.description)}</div>` : ''}</div></div>
      ${counterHtml(p.counts)}
      <h3 style="margin:18px 0 10px">Reviews</h3>
      ${ratingSummaryHtml(p.rating)}
      <div class="reviews">${p.reviews.map((r) => reviewHtml(r)).join('')}</div>
      ${p.banned ? '<div class="form-error" style="margin-top:12px">You are banned from this server.</div>' : ''}`,
    buttons: [{ label: 'Back', cls: 'ghost', action: () => { setTimeout(joinServer); } }, ...(p.banned ? [] : [{
      label: p.member ? 'Open Server' : 'Join Server', action: async () => {
        try {
          const s = await POST('/servers/join', { pin });
          if (!state.servers.has(s.id)) { state.servers.set(s.id, s); state.serverOrder.push(s.id); emit('servers'); }
          navigate(channelPath(s.id));
          if (!p.member) toast(`Welcome to ${s.name}!`, 'ok');
        } catch (e) { errToast(e); return false; }
      },
    }])],
  });
}

export function openInvite(s, justCreated = false) {
  const fresh = state.servers.get(s.id) || s;
  if (!fresh.pin) {
    modal({ title: `Invite friends to ${fresh.name}`, body: `<p class="muted">Ask a server admin for the PIN. Only members with the <b>Manage Server</b> permission can see it.</p>`, buttons: [{ label: 'Got it' }] });
    return;
  }
  modal({
    title: justCreated ? 'Your server is ready! 🎉' : `Invite friends to ${fresh.name}`,
    subtitle: 'Share this PIN with people you want to join. Anyone with it can join, so keep it between friends.',
    body: `<div class="pin-box"><div class="pin">${esc(fresh.pin)}</div><button class="btn" data-copy>${icon('copy')} Copy</button></div>
      <p class="tiny muted" style="margin-top:12px">To join: tap + in the server list → "Join a Server with a PIN". You can change or regenerate the PIN in Server Settings.</p>`,
    buttons: [{ label: 'Done' }],
  }).body.querySelector('[data-copy]').onclick = () => copyText(fresh.pin);
}

export function openCreateChannel(s, { category = false, parentId = null } = {}) {
  const types = category ? [] : [['text', 'hash', 'Text', 'Send messages, images, polls, emoji and opinions.'], ['voice', 'volume', 'Voice', 'Hang out together with voice, video, and screen share.'], ['announcement', 'megaphone', 'Announcement', 'Important updates only moderators can post.']];
  const m = modal({
    title: category ? 'Create Category' : 'Create Channel',
    subtitle: parentId ? `in ${esc(s.channels.find((c) => c.id === parentId)?.name || '')}` : '',
    body: `${types.length ? `<div class="field"><label>Channel Type</label><div class="radio-list">${types.map(([v, ic, l, d], i) => `<label class="radio-item"><input type="radio" name="type" value="${v}" ${i === 0 ? 'checked' : ''}>${icon(ic)}<div><b>${l}</b><div class="tiny muted">${d}</div></div></label>`).join('')}</div></div>` : ''}
      <div class="field"><label>${category ? 'Category' : 'Channel'} Name</label><input class="input" data-name maxlength="100" placeholder="${category ? 'New Category' : 'new-channel'}"></div>
      <label class="toggle-row" style="border:0"><div><div class="t">${icon('lock')} Private ${category ? 'Category' : 'Channel'}</div><div class="d">Only you (and roles/members you add later) can see it.</div></div><span class="switch"><input type="checkbox" data-private><span></span></span></label>`,
    buttons: [{ label: 'Cancel', cls: 'ghost' }, {
      label: category ? 'Create Category' : 'Create Channel', action: async (mm) => {
        const type = category ? 'category' : mm.body.querySelector('input[name=type]:checked').value;
        try {
          const c = await POST(`/servers/${s.id}/channels`, { type, name: $('[data-name]', mm.body).value, parent_id: parentId, private: $('[data-private]', mm.body).checked });
          if (type !== 'category') setTimeout(() => navigate(channelPath(s.id, c.id)), 200);
        } catch (e) { errToast(e); return false; }
      },
    }],
  });
}

// ---------- Settings ----------
export function openServerSettings(serverId, section) {
  const s0 = state.servers.get(serverId);
  if (!s0) return;
  const p = s0.permissions;
  const isOwner = s0.owner_id === state.user.id;
  const sections = [
    ['h', esc(s0.name)],
    has(p, P.MANAGE_SERVER) && ['overview', 'Overview'],
    has(p, P.MANAGE_SERVER) && ['pin', 'PIN & Invites'],
    has(p, P.MANAGE_ROLES) && ['roles', 'Roles'],
    has(p, P.MANAGE_EMOJIS) && ['emoji', 'Emoji'],
    ['h', 'Moderation'],
    ['members', 'Members'],
    has(p, P.BAN_MEMBERS) && ['bans', 'Bans'],
    has(p, P.VIEW_AUDIT_LOG) && ['audit', 'Audit Log'],
  ].filter(Boolean);
  const root = el(`<div class="settings show-body" role="dialog" aria-label="Server Settings">
    <nav class="s-nav"><div>${sections.map(([k, l]) => (k === 'h' ? `<div class="h">${l}</div>` : `<button data-s="${k}">${l}</button>`)).join('')}
      ${isOwner ? '<div class="divider"></div><button data-s="owner">Ownership</button><button class="danger" data-s="delete">Delete Server</button>' : ''}</div></nav>
    <div class="s-body"><div class="inner"></div></div>
    <div class="close-col"><button class="close-btn" title="Close (Esc)">${icon('x')}</button></div></div>`);
  const entry = layer(root, { outsideClose: false });
  $('.close-btn', root).onclick = () => entry.close();
  const inner = $('.inner', root);
  const S = () => state.servers.get(serverId);
  const show = (k) => {
    $$('[data-s]', root).forEach((b) => b.classList.toggle('active', b.dataset.s === k));
    root.classList.add('show-body');
    inner.innerHTML = `<button class="btn ghost small mobile-back" data-back>${icon('back')} Back</button>`;
    const body = el('<div></div>');
    inner.append(body);
    ({ overview, pin, roles, emoji, members, bans, audit, owner, delete: del })[k](body, S, entry);
  };
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-s]');
    if (b) show(b.dataset.s);
    if (e.target.closest('[data-back]')) root.classList.remove('show-body');
  });
  const first = section || sections.find(([k]) => k !== 'h')?.[0] || 'members';
  if (isMobile() && !section) root.classList.remove('show-body');
  show(first);
}

function overview(body, S) {
  const s = S();
  const textChannels = s.channels.filter((c) => c.type === 'text');
  body.innerHTML = `<h1>Server Overview</h1>
    <div class="row wrap" style="align-items:flex-start;gap:24px">
      <div class="field">${imagePickerHtml('icon', s.icon, { label: 'Change Icon' })}<div class="hint">Animated icons (GIF/WebP) are supported.</div></div>
      <div class="field grow"><label>Server Name</label><input class="input" data-name maxlength="100" value="${esc(s.name)}"></div></div>
    <div class="field"><label>Server Banner</label>${imagePickerHtml('banner', s.banner, { banner: true, label: 'Change Banner' })}<div class="hint">Shown at the top of your channel list. Animated banners work.</div></div>
    <div class="field"><label>Description</label><textarea class="input" data-desc maxlength="300" rows="3">${esc(s.description || '')}</textarea></div>
    <div class="field"><label>System Messages Channel</label><select class="input" data-sys><option value="">No system messages</option>
      ${textChannels.map((c) => `<option value="${c.id}" ${s.system_channel_id === c.id ? 'selected' : ''}>#${esc(c.name)}</option>`).join('')}</select>
      <div class="hint">Where we post join, leave and other notices.</div></div>
    <button class="btn" data-save>Save Changes</button>`;
  const ic = bindImagePicker(body, 'icon');
  const bn = bindImagePicker(body, 'banner');
  $('[data-save]', body).onclick = async () => {
    const form = new FormData();
    form.append('name', $('[data-name]', body).value);
    form.append('description', $('[data-desc]', body).value);
    form.append('system_channel_id', $('[data-sys]', body).value);
    if (ic.file) form.append('icon', ic.file); else if (ic.removed) form.append('remove_icon', 'true');
    if (bn.file) form.append('banner', bn.file); else if (bn.removed) form.append('remove_banner', 'true');
    try { await api('PATCH', `/servers/${s.id}`, form); toast('Saved!', 'ok'); } catch (e) { errToast(e); }
  };
}

function pin(body, S) {
  const draw = () => {
    const s = S();
    body.innerHTML = `<h1>PIN & Invites</h1>
      <p class="muted">People can only join <b>${esc(s.name)}</b> with this PIN. Changing it stops the old PIN from working.</p>
      <div class="pin-box"><div class="pin">${esc(s.pin)}</div><button class="btn" data-copy>${icon('copy')} Copy</button><button class="btn secondary" data-regen>${icon('refresh')} New PIN</button></div>
      <h3>Custom PIN</h3>
      <div class="row"><input class="input pin-input" data-custom inputmode="numeric" maxlength="12" placeholder="6–12 digits" style="font-size:1.25rem;max-width:280px"><button class="btn" data-set>Set PIN</button></div>`;
  };
  draw();
  body.onclick = async (e) => {
    if (e.target.closest('[data-copy]')) return copyText(S().pin);
    try {
      if (e.target.closest('[data-regen]')) {
        if (!(await confirmDialog({ title: 'Generate a new PIN?', text: 'The current PIN will stop working immediately.', confirm: 'Generate' }))) return;
        const r = await POST(`/servers/${S().id}/pin`);
        S().pin = r.pin; draw(); toast('New PIN generated.', 'ok');
      }
      if (e.target.closest('[data-set]')) {
        const r = await POST(`/servers/${S().id}/pin`, { pin: $('[data-custom]', body).value });
        S().pin = r.pin; draw(); toast('PIN updated.', 'ok');
      }
    } catch (err) { errToast(err); }
  };
}

function roles(body, S) {
  let selected = null;
  const myTop = () => {
    const s = S();
    if (s.owner_id === state.user.id) return Infinity;
    const mine = s.me?.roles || [];
    return Math.max(0, ...s.roles.filter((r) => mine.includes(r.id)).map((r) => r.position));
  };
  const draw = () => {
    const s = S();
    const list = sortedRoles(s);
    if (!selected || !list.some((r) => r.id === selected)) selected = list[0]?.id;
    const r = list.find((x) => x.id === selected);
    const editable = r && (r.is_default || r.position < myTop());
    body.innerHTML = `<h1>Roles</h1><p class="muted">Use roles to group members and assign permissions. Higher roles are listed first. The server owner can do anything.</p>
      <div class="role-editor">
        <div class="role-list"><button class="btn small block" data-new style="margin-bottom:8px">${icon('plus')} Create Role</button>
          ${list.map((x, i) => `<button class="${x.id === selected ? 'active' : ''}" data-role="${x.id}"><span class="dot" style="background:${roleSwatch(x)}"></span><span class="grow" style="overflow:hidden;text-overflow:ellipsis">${esc(x.name)}</span>
            ${!x.is_default && x.position < myTop() ? `<span class="mv"><span class="icon-btn" data-up="${x.id}" title="Move up" ${i === 0 ? 'hidden' : ''}>${icon('chevron')}</span></span>` : ''}</button>`).join('')}</div>
        <div>${r ? `
          <div class="field"><label>Role Name</label><input class="input" data-name maxlength="100" value="${esc(r.name)}" ${r.is_default || !editable ? 'disabled' : ''}></div>
          <div class="field"><label>Role Color</label><div class="color-row">
            ${['', '#00d087', '#1abc9c', '#3498db', '#9b59b6', '#e91e63', '#f1c40f', '#e67e22', '#e74c3c', '#95a5a6'].map((c) => `<button class="color-swatch ${(r.color || '') === c ? 'sel' : ''}" data-color="${c}" style="background:${c || 'var(--offline)'}" title="${c || 'Default'}" ${!editable ? 'disabled' : ''}></button>`).join('')}
            <input type="color" class="input" data-colorpick value="${r.color || '#00d087'}" ${!editable ? 'disabled' : ''}></div></div>
          ${r.is_default ? '' : `<div class="field"><label>Gradient</label>
            <div class="row wrap"><input type="color" class="input" data-color2 value="${r.color2 || r.color || '#3498db'}" ${!editable || !r.color ? 'disabled' : ''} title="Gradient end color">
              ${r.color2 ? `<button class="btn small secondary" data-nograd ${!editable ? 'disabled' : ''}>Remove gradient</button>` : ''}
              <span class="role-preview"><span ${roleAttrs(r)}>${esc(r.name)}</span></span></div>
            <div class="hint">${r.color ? 'Pick a second color to fade this role\'s name from the role color into it.' : 'Choose a role color first.'} Members with several colored roles automatically get a gradient of their top role colors.</div></div>
          <div class="toggle-row"><div><div class="t">Animated color</div><div class="d">Gradients flow across the name and solid colors cycle through the rainbow.</div></div>
            <label class="switch"><input type="checkbox" data-animated ${r.animated ? 'checked' : ''} ${!editable || !r.color ? 'disabled' : ''}><span></span></label></div>`}
          ${r.is_default ? '' : `<div class="toggle-row"><div><div class="t">Display role members separately from online members</div></div><label class="switch"><input type="checkbox" data-hoist ${r.hoist ? 'checked' : ''} ${!editable ? 'disabled' : ''}><span></span></label></div>
          <div class="toggle-row"><div><div class="t">Allow anyone to @mention this role</div></div><label class="switch"><input type="checkbox" data-mentionable ${r.mentionable ? 'checked' : ''} ${!editable ? 'disabled' : ''}><span></span></label></div>`}
          <h3>Permissions</h3>
          ${PERM_GROUPS.map(([g, perms]) => `<div class="label" style="margin-top:16px">${g}</div>${perms.map(([k, l, d]) => `<div class="perm-row"><div><div class="t">${l}</div><div class="d">${d}</div></div>
            <label class="switch"><input type="checkbox" data-perm="${k}" ${has(r.permissions, P[k]) ? 'checked' : ''} ${!editable ? 'disabled' : ''}><span></span></label></div>`).join('')}`).join('')}
          ${!r.is_default && editable ? `<div class="divider"></div><button class="btn outline-danger" data-delrole>Delete Role</button>` : ''}
          ${!editable ? '<p class="muted small">You can only edit roles below your highest role.</p>' : ''}` : ''}</div></div>`;
  };
  const save = async (patch) => {
    try { await PATCH(`/servers/${S().id}/roles/${selected}`, patch); } catch (e) { errToast(e); draw(); }
  };
  body.onclick = async (e) => {
    const up = e.target.closest('[data-up]');
    if (up) {
      e.stopPropagation();
      const ids = sortedRoles(S()).filter((x) => !x.is_default).map((x) => x.id);
      const i = ids.indexOf(Number(up.dataset.up));
      if (i > 0) { [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]]; try { await PUT(`/servers/${S().id}/roles`, { ids }); } catch (err) { errToast(err); } }
      return;
    }
    const rb = e.target.closest('[data-role]');
    if (rb) { selected = Number(rb.dataset.role); return draw(); }
    if (e.target.closest('[data-new]')) {
      try { const r = await POST(`/servers/${S().id}/roles`, { name: 'new role' }); selected = r.id; draw(); } catch (err) { errToast(err); }
      return;
    }
    if (e.target.closest('[data-nograd]')) return save({ color2: null });
    const c = e.target.closest('[data-color]');
    if (c && !c.disabled) return save({ color: c.dataset.color || null });
    if (e.target.closest('[data-delrole]')) {
      const r = S().roles.find((x) => x.id === selected);
      if (await confirmDialog({ title: 'Delete Role', text: `Are you sure you want to delete <b>${esc(r.name)}</b>?`, confirm: 'Delete', danger: true })) {
        try { await DEL(`/servers/${S().id}/roles/${selected}`); selected = null; } catch (err) { errToast(err); }
      }
    }
  };
  body.onchange = (e) => {
    const t = e.target;
    if (t.matches('[data-name]')) save({ name: t.value });
    if (t.matches('[data-colorpick]')) save({ color: t.value });
    if (t.matches('[data-color2]')) save({ color2: t.value });
    if (t.matches('[data-animated]')) save({ animated: t.checked });
    if (t.matches('[data-hoist]')) save({ hoist: t.checked });
    if (t.matches('[data-mentionable]')) save({ mentionable: t.checked });
    if (t.dataset.perm) {
      let perms = 0;
      $$('[data-perm]', body).forEach((x) => { if (x.checked) perms |= P[x.dataset.perm]; });
      save({ permissions: perms });
    }
  };
  const off = onServer(S().id, draw);
  watchDetach(body, off);
  draw();
}

function emoji(body, S) {
  const draw = () => {
    const s = S();
    body.innerHTML = `<h1>Emoji</h1>
      <p class="muted">Add up to 250 custom emoji that anyone in your server can use — static or animated, totally free. Emoji names must be at least 2 characters and can only contain letters, numbers and underscores.</p>
      <label class="upload-zone">${icon('upload')}<div><b>Upload Emoji</b><div class="tiny">PNG, JPG, GIF, WebP or APNG · max 2 MB · you can pick multiple files</div></div>
        <input type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/avif" multiple hidden data-file></label>
      <div class="emoji-table" style="margin-top:16px">
        <div class="label" style="margin-bottom:8px">Emoji — ${s.emojis.length}</div>
        ${s.emojis.map((e) => `<div class="list-row">${customEmojiHtml(e)}<input class="input grow" value="${esc(e.name)}" data-rename="${e.id}" maxlength="32" style="min-height:32px;padding:4px 8px">
          ${e.animated ? '<span class="tiny muted">animated</span>' : ''}<span class="tiny muted">${esc(getUser(e.creator_id)?.username || '')}</span>
          <button class="icon-btn danger" data-del="${e.id}" title="Delete">${icon('trash')}</button></div>`).join('')}
      </div>`;
  };
  body.onchange = async (e) => {
    if (e.target.matches('[data-file]')) {
      for (const f of e.target.files) {
        const form = new FormData();
        form.append('image', f);
        form.append('name', f.name.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 32));
        try { await api('POST', `/servers/${S().id}/emojis`, form); } catch (err) { errToast(err); }
      }
      return;
    }
    const r = e.target.dataset.rename;
    if (r) PATCH(`/servers/${S().id}/emojis/${r}`, { name: e.target.value }).catch(errToast);
  };
  body.onclick = async (e) => {
    const d = e.target.closest('[data-del]');
    if (d && await confirmDialog({ title: 'Delete Emoji', text: 'Remove this emoji from the server?', confirm: 'Delete', danger: true })) DEL(`/servers/${S().id}/emojis/${d.dataset.del}`).catch(errToast);
  };
  watchDetach(body, onServer(S().id, draw));
  draw();
}

async function members(body, S) {
  const { loadMembers } = await import('./app.js');
  let q = '';
  const draw = async () => {
    const s = S();
    const map = await loadMembers(s.id);
    const list = [...map.values()].filter((m) => !q || m.user.username.includes(q) || displayName(m.user.id, s.id).toLowerCase().includes(q))
      .sort((a, b) => a.joined_at - b.joined_at);
    const roleName = (id) => s.roles.find((r) => r.id === id);
    body.querySelector('[data-list]').innerHTML = list.map((m) => `<div class="list-row" data-user="${m.user.id}">${avatarHtml(getUser(m.user.id) || m.user)}
      <div class="grow"><div class="t"><span ${nameAttrs(s.id, m.user.id)}>${esc(displayName(m.user.id, s.id))}</span> <span class="muted small">${esc(m.user.username)}</span>${s.owner_id === m.user.id ? ` ${icon('crown', 'crown')}` : ''}</div>
      <div class="d">Joined ${fmtStamp(m.joined_at)} · ${m.roles.map(roleName).filter(Boolean).map((r) => `<span ${roleAttrs(r)}>${esc(r.name)}</span>`).join(', ') || 'No roles'}</div></div>
      <button class="icon-btn" data-more="${m.user.id}" title="Actions">${icon('more')}</button></div>`).join('');
  };
  body.innerHTML = `<h1>Server Members</h1><input class="input" data-q placeholder="Search members" style="margin-bottom:12px"><div data-list>Loading…</div>`;
  $('[data-q]', body).oninput = (e) => { q = e.target.value.toLowerCase(); draw(); };
  body.onclick = async (e) => {
    const m = e.target.closest('[data-more]');
    if (m) { const { userMenu } = await import('./profile.js'); userMenu(Number(m.dataset.more), m, { serverId: S().id }); }
  };
  const { on } = await import('../store.js');
  watchDetach(body, on('members', (sid) => { if (sid === S().id) draw(); }));
  draw();
}

async function bans(body, S) {
  body.innerHTML = '<h1>Bans</h1><div data-list>Loading…</div>';
  const load = async () => {
    try {
      const list = await GET(`/servers/${S().id}/bans`);
      list.forEach((b) => cacheUser(b.user));
      $('[data-list]', body).innerHTML = list.map((b) => `<div class="list-row">${avatarHtml(b.user)}<div class="grow"><div class="t">${esc(b.user.display_name || b.user.username)} <span class="muted small">${esc(b.user.username)}</span></div>
        <div class="d">${b.reason ? `Reason: ${esc(b.reason)}` : 'No reason given'} · ${fmtStamp(b.created_at)}</div></div><button class="btn small secondary" data-unban="${b.user.id}">Revoke Ban</button></div>`).join('')
        || '<div class="empty"><img src="/icons/logo.png" alt=""><div>No bans. Peaceful!</div></div>';
    } catch (e) { errToast(e); }
  };
  body.onclick = async (e) => {
    const u = e.target.closest('[data-unban]');
    if (u) { try { await DEL(`/servers/${S().id}/bans/${u.dataset.unban}`); load(); } catch (err) { errToast(err); } }
  };
  load();
}

const AUDIT_TEXT = {
  server_update: 'updated the server', pin_update: 'changed the server PIN', owner_transfer: 'transferred ownership to',
  member_nick: "changed the nickname of", member_roles: 'updated roles for', member_timeout: 'timed out', member_timeout_remove: 'removed the timeout for',
  member_kick: 'kicked', member_ban: 'banned', member_unban: 'unbanned', role_create: 'created a role', role_update: 'updated a role', role_delete: 'deleted a role',
  emoji_create: 'added an emoji', emoji_delete: 'removed an emoji', channel_create: 'created a channel', channel_update: 'updated a channel', channel_delete: 'deleted a channel',
  channel_permissions: 'changed channel permissions', message_delete: "deleted a message by", message_bulk_delete: 'bulk deleted messages',
};
async function audit(body, S) {
  body.innerHTML = '<h1>Audit Log</h1><div data-list>Loading…</div><div class="center" style="margin-top:12px"><button class="btn secondary small" data-more hidden>Load more</button></div>';
  let before = '';
  const load = async () => {
    try {
      const list = await GET(`/servers/${S().id}/audit-log${before ? `?before=${before}` : ''}`);
      const html = list.map((a) => {
        if (a.user) cacheUser(a.user);
        const d = a.details || {};
        const extra = d.name ? ` <b>${esc(d.name)}</b>` : d.channel ? ` in <b>#${esc(d.channel)}</b>` : '';
        const changes = d.added || d.removed ? ` (${[...(d.added || []).map((x) => `+${esc(x)}`), ...(d.removed || []).map((x) => `−${esc(x)}`)].join(', ')})` : '';
        return `<div class="list-row">${avatarHtml(a.user || {})}<div class="grow"><div><b>${esc(a.user?.display_name || a.user?.username || 'Someone')}</b> ${AUDIT_TEXT[a.action] || esc(a.action)}${a.target_user ? ` <b>${esc(a.target_user.display_name || a.target_user.username)}</b>` : ''}${extra}${changes}${d.reason ? ` — “${esc(d.reason)}”` : ''}</div>
          <div class="d">${fmtStamp(a.created_at)}</div></div></div>`;
      }).join('');
      const listEl = $('[data-list]', body);
      if (!before) listEl.innerHTML = html || '<div class="empty">Nothing here yet.</div>'; else listEl.insertAdjacentHTML('beforeend', html);
      if (list.length) before = list[list.length - 1].id;
      $('[data-more]', body).hidden = list.length < 50;
    } catch (e) { errToast(e); }
  };
  $('[data-more]', body).onclick = load;
  load();
}

async function owner(body, S) {
  const { loadMembers } = await import('./app.js');
  const s = S();
  const map = await loadMembers(s.id);
  body.innerHTML = `<h1>Transfer Ownership</h1><p class="muted">The owner can do anything in the server. Transferring ownership is permanent unless the new owner gives it back.</p>
    <div class="field"><label>New owner</label><select class="input" data-to>${[...map.values()].filter((m) => m.user.id !== state.user.id).map((m) => `<option value="${m.user.id}">${esc(displayName(m.user.id, s.id))} (${esc(m.user.username)})</option>`).join('')}</select></div>
    <button class="btn danger" data-go>Transfer Ownership</button>`;
  $('[data-go]', body).onclick = async () => {
    const to = Number($('[data-to]', body).value);
    if (!to) return;
    if (!(await confirmDialog({ title: 'Transfer Ownership', text: `Transfer <b>${esc(s.name)}</b> to <b>${esc(displayName(to, s.id))}</b>?`, confirm: 'Transfer', danger: true }))) return;
    try { await POST(`/servers/${s.id}/transfer`, { user_id: to }); toast('Ownership transferred.'); document.querySelector('.settings .close-btn')?.click(); } catch (e) { errToast(e); }
  };
}

function del(body, S, entry) {
  const s = S();
  body.innerHTML = `<h1>Delete '${esc(s.name)}'</h1><p class="muted">This will permanently delete the server, all channels, messages, roles and emoji. This cannot be undone.</p>
    <div class="field"><label>Enter server name to confirm</label><input class="input" data-name></div>
    <button class="btn danger" data-go>Delete Server</button>`;
  $('[data-go]', body).onclick = async () => {
    try { await DEL(`/servers/${s.id}`, { name: $('[data-name]', body).value }); entry.close(); toast('Server deleted.'); } catch (e) { errToast(e); }
  };
}

// Helpers
function onServer(serverId, fn) {
  let off1, off2;
  import('../store.js').then(({ on }) => {
    off1 = on('server_update', (sid) => { if (sid === serverId) fn(); });
    off2 = on('servers', fn);
  });
  return () => { off1?.(); off2?.(); };
}
function watchDetach(node, off) {
  const obs = new MutationObserver(() => { if (!node.isConnected) { off(); obs.disconnect(); } });
  obs.observe(document.getElementById('layers'), { childList: true, subtree: true });
}

