// Channel settings: overview + permission overwrites.
import { $, $$, el, esc, toast, errToast } from '../dom.js';
import { icon } from '../icons.js';
import { state, on, P, has, channelById, sortedRoles, displayName, roleAttrs, roleSwatch } from '../store.js';
import { PATCH, PUT } from '../api.js';
import { layer, menu } from './layers.js';
import { CHANNEL_PERM_KEYS, permLabel } from './perms.js';
import { deleteChannel, loadMembers } from './app.js';

const SLOWMODES = [[0, 'Off'], [5, '5s'], [10, '10s'], [15, '15s'], [30, '30s'], [60, '1m'], [120, '2m'], [300, '5m'], [600, '10m'], [900, '15m'], [1800, '30m'], [3600, '1h'], [7200, '2h'], [21600, '6h']];

export function openChannelSettings(channelId, section = 'overview') {
  const C = () => channelById(channelId);
  const c0 = C();
  if (!c0) return;
  const S = () => state.servers.get(c0.server_id);
  const isCat = c0.type === 'category';
  const canRoles = has(S().permissions, P.MANAGE_ROLES);
  const root = el(`<div class="settings show-body" role="dialog">
    <nav class="s-nav"><div><div class="h">${isCat ? 'Category' : '#'} ${esc(c0.name)}</div>
      <button data-s="overview">Overview</button>${canRoles ? '<button data-s="perms">Permissions</button>' : ''}
      <div class="divider"></div><button class="danger" data-delete>Delete ${isCat ? 'Category' : 'Channel'}</button></div></nav>
    <div class="s-body"><div class="inner"></div></div>
    <div class="close-col"><button class="close-btn">${icon('x')}</button></div></div>`);
  const entry = layer(root, { outsideClose: false });
  $('.close-btn', root).onclick = () => entry.close();
  const inner = $('.inner', root);
  const show = (k) => {
    $$('[data-s]', root).forEach((b) => b.classList.toggle('active', b.dataset.s === k));
    root.classList.add('show-body');
    inner.innerHTML = `<button class="btn ghost small mobile-back" data-back>${icon('back')} Back</button>`;
    const body = el('<div></div>');
    inner.append(body);
    (k === 'overview' ? overview : perms)(body, C, S);
  };
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-s]');
    if (b) show(b.dataset.s);
    if (e.target.closest('[data-back]')) root.classList.remove('show-body');
    if (e.target.closest('[data-delete]')) deleteChannel(C()).then(() => { if (!C()) entry.close(); });
  });
  const off = on('servers', () => { if (!C()) entry.close(); });
  const obs = new MutationObserver(() => { if (!root.isConnected) { off(); obs.disconnect(); } });
  obs.observe(document.getElementById('layers'), { childList: true });
  show(section);
}

function overview(body, C, S) {
  const c = C();
  const isText = c.type === 'text' || c.type === 'announcement';
  const cats = S().channels.filter((x) => x.type === 'category');
  body.innerHTML = `<h1>Overview</h1>
    <div class="field"><label>${c.type === 'category' ? 'Category' : 'Channel'} Name</label><input class="input" data-name maxlength="100" value="${esc(c.name)}"></div>
    ${isText ? `<div class="field"><label>Channel Topic</label><textarea class="input" data-topic maxlength="1024" rows="3" placeholder="Let everyone know how to use this channel!">${esc(c.topic || '')}</textarea></div>
    <div class="field"><label>Slowmode</label><select class="input" data-slow>${SLOWMODES.map(([v, l]) => `<option value="${v}" ${c.slowmode === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <div class="hint">Members will be limited to one message per this interval, unless they have Manage Channel or Manage Messages.</div></div>
    <div class="toggle-row"><div><div class="t">Announcement Channel</div><div class="d">Only members with Manage Messages can post.</div></div><label class="switch"><input type="checkbox" data-ann ${c.type === 'announcement' ? 'checked' : ''}><span></span></label></div>` : ''}
    ${c.type !== 'category' ? `<div class="field" style="margin-top:16px"><label>Category</label><select class="input" data-parent><option value="">No category</option>${cats.map((x) => `<option value="${x.id}" ${c.parent_id === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div>` : ''}
    <button class="btn" data-save>Save Changes</button>`;
  $('[data-save]', body).onclick = async () => {
    const patch = { name: $('[data-name]', body).value };
    if (isText) {
      patch.topic = $('[data-topic]', body).value;
      patch.slowmode = Number($('[data-slow]', body).value);
      patch.type = $('[data-ann]', body).checked ? 'announcement' : 'text';
    }
    if (c.type !== 'category') patch.parent_id = $('[data-parent]', body).value || null;
    try { await PATCH(`/channels/${c.id}`, patch); toast('Saved!', 'ok'); } catch (e) { errToast(e); }
  };
}

function perms(body, C, S) {
  let target = null; // { type, id }
  const draw = () => {
    const c = C();
    const s = S();
    if (!c) return;
    const everyone = s.roles.find((r) => r.is_default);
    const ows = c.overwrites || [];
    const targets = [{ type: 'role', id: everyone.id }, ...ows.filter((o) => !(o.target_type === 'role' && o.target_id === everyone.id)).map((o) => ({ type: o.target_type, id: o.target_id }))];
    if (!target || !targets.some((t) => t.type === target.type && t.id === target.id)) target = targets[0];
    const ow = ows.find((o) => o.target_type === target.type && o.target_id === target.id) || { allow: 0, deny: 0 };
    const name = (t) => (t.type === 'role' ? s.roles.find((r) => r.id === t.id)?.name || 'deleted role' : `@${displayName(t.id, s.id)}`);
    const isPrivate = ows.some((o) => o.target_type === 'role' && o.target_id === everyone.id && (o.deny & P.VIEW_CHANNELS));
    body.innerHTML = `<h1>Channel Permissions</h1>
      <div class="toggle-row"><div><div class="t">${icon('lock')} Private ${c.type === 'category' ? 'Category' : 'Channel'}</div><div class="d">Only selected members and roles will be able to view it.</div></div>
        <label class="switch"><input type="checkbox" data-private ${isPrivate ? 'checked' : ''}><span></span></label></div>
      <h3>Advanced Permissions</h3>
      <div class="role-editor">
        <div class="role-list"><button class="btn small block secondary" data-add style="margin-bottom:8px">${icon('plus')} Add Role or Member</button>
          ${targets.map((t) => `<button class="${t.type === target.type && t.id === target.id ? 'active' : ''}" data-t="${t.type}:${t.id}">${t.type === 'role' ? `<span class="dot" style="background:${roleSwatch(s.roles.find((r) => r.id === t.id) || {})}"></span>` : icon('users')}<span>${esc(name(t))}</span></button>`).join('')}</div>
        <div>${CHANNEL_PERM_KEYS.map((k) => {
          const { label, desc, bit } = permLabel(k);
          const st = ow.allow & bit ? 'allow' : ow.deny & bit ? 'deny' : 'inherit';
          return `<div class="perm-row"><div><div class="t">${label}</div><div class="d">${desc}</div></div>
            <div class="tri" data-bit="${bit}"><button class="deny ${st === 'deny' ? 'sel' : ''}" data-v="deny" title="Deny">${icon('x')}</button>
            <button class="inherit ${st === 'inherit' ? 'sel' : ''}" data-v="inherit" title="Inherit">${icon('slash')}</button>
            <button class="allow ${st === 'allow' ? 'sel' : ''}" data-v="allow" title="Allow">${icon('check')}</button></div></div>`;
        }).join('')}</div></div>`;
  };
  const setOw = async (t, allow, deny) => {
    try { await PUT(`/channels/${C().id}/overwrites/${t.type}/${t.id}`, { allow, deny }); } catch (e) { errToast(e); }
  };
  body.onclick = async (e) => {
    const t = e.target.closest('[data-t]');
    if (t) { const [type, id] = t.dataset.t.split(':'); target = { type, id: Number(id) }; return draw(); }
    const btn = e.target.closest('.tri button');
    if (btn) {
      const bit = Number(btn.closest('.tri').dataset.bit);
      const ow = (C().overwrites || []).find((o) => o.target_type === target.type && o.target_id === target.id) || { allow: 0, deny: 0 };
      let { allow, deny } = ow;
      allow &= ~bit; deny &= ~bit;
      if (btn.dataset.v === 'allow') allow |= bit;
      if (btn.dataset.v === 'deny') deny |= bit;
      return setOw(target, allow, deny);
    }
    const add = e.target.closest('[data-add]');
    if (add) {
      const s = S();
      const ows = C().overwrites || [];
      const map = await loadMembers(s.id);
      const items = [
        { header: 'Roles' },
        ...sortedRoles(s).filter((r) => !r.is_default && !ows.some((o) => o.target_type === 'role' && o.target_id === r.id)).map((r) => ({
          html: `<span ${roleAttrs(r)}>${esc(r.name)}</span>`, action: () => { target = { type: 'role', id: r.id }; setOw(target, P.VIEW_CHANNELS, 0); },
        })),
        { header: 'Members' },
        ...[...map.values()].filter((m) => !ows.some((o) => o.target_type === 'member' && o.target_id === m.user.id)).slice(0, 50).map((m) => ({
          label: displayName(m.user.id, s.id), action: () => { target = { type: 'member', id: m.user.id }; setOw(target, P.VIEW_CHANNELS, 0); },
        })),
      ];
      menu(items, add);
    }
  };
  body.onchange = (e) => {
    if (!e.target.matches('[data-private]')) return;
    const s = S();
    const everyone = s.roles.find((r) => r.is_default);
    const ow = (C().overwrites || []).find((o) => o.target_type === 'role' && o.target_id === everyone.id) || { allow: 0, deny: 0 };
    const deny = e.target.checked ? ow.deny | P.VIEW_CHANNELS : ow.deny & ~P.VIEW_CHANNELS;
    setOw({ type: 'role', id: everyone.id }, ow.allow & ~P.VIEW_CHANNELS, deny);
  };
  const off = on('servers', draw);
  const obs = new MutationObserver(() => { if (!body.isConnected) { off(); obs.disconnect(); } });
  obs.observe(document.getElementById('layers'), { childList: true, subtree: true });
  draw();
}
