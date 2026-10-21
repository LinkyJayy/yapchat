// Reusable HTML fragments.
import { esc } from '../dom.js';
import { getUser, state } from '../store.js';
import { anyEmojiHtml, emojify } from '../emoji.js';

const DEFAULT_COLORS = ['#00d087', '#00a39a', '#2f9e6b', '#0aa7c9', '#6c8f7f'];

export function avatarHtml(userOrId, { size = '', status = false, cls = '' } = {}) {
  const u = typeof userOrId === 'object' && userOrId ? userOrId : getUser(userOrId) || { id: userOrId };
  const st = status ? `<span class="status-dot ${statusOf(u)}"></span>` : '';
  if (u.avatar) return `<div class="avatar ${size} ${cls}" data-user="${u.id}"><img src="${esc(u.avatar)}" alt="" loading="lazy" draggable="false">${st}</div>`;
  const color = DEFAULT_COLORS[(Number(u.id) || 0) % DEFAULT_COLORS.length];
  return `<div class="avatar default ${size} ${cls}" data-user="${u.id}" style="background:${color}"><img src="/icons/logo.png" alt="" draggable="false">${st}</div>`;
}

export function statusOf(u) {
  if (!u) return 'offline';
  if (state.user && u.id === state.user.id) {
    const s = state.user.set_status;
    return s === 'invisible' ? 'offline' : s || 'online';
  }
  return getUser(u.id)?.status || u.status || 'offline';
}

export const STATUS_LABEL = { online: 'Online', idle: 'Idle', dnd: 'Do Not Disturb', offline: 'Offline', invisible: 'Invisible' };

export function customStatusHtml(u) {
  if (!u?.custom_status && !u?.custom_status_emoji) return '';
  return `${u.custom_status_emoji ? anyEmojiHtml(u.custom_status_emoji, null) + ' ' : ''}${emojify(esc(u.custom_status || ''))}`;
}

export function serverIconHtml(s) {
  if (s.icon) return `<img src="${esc(s.icon)}" alt="" draggable="false">`;
  const initials = s.name.split(/\s+/).filter(Boolean).slice(0, 3).map((w) => [...w][0]).join('');
  return esc(initials || '?');
}

// File input that previews an image; returns { node, file(), removed() }.
export function imagePickerHtml(name, current, { banner = false, label = 'Change' } = {}) {
  return `<div class="img-picker" data-picker="${name}">
    <div class="prev ${banner ? 'banner' : ''}">${current ? `<img src="${esc(current)}" alt="">` : '<span class="tiny">No image</span>'}</div>
    <div class="row wrap">
      <label class="btn small">${esc(label)}<input type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/avif" hidden></label>
      <button type="button" class="btn small secondary" data-remove>Remove</button>
    </div>
  </div>`;
}

export function bindImagePicker(root, name) {
  const box = root.querySelector(`[data-picker="${name}"]`);
  const input = box.querySelector('input[type=file]');
  const prev = box.querySelector('.prev');
  const st = { file: null, removed: false };
  input.onchange = () => {
    const f = input.files[0];
    if (!f) return;
    st.file = f; st.removed = false;
    prev.innerHTML = `<img src="${URL.createObjectURL(f)}" alt="">`;
    box.dispatchEvent(new Event('change', { bubbles: true }));
  };
  box.querySelector('[data-remove]').onclick = () => {
    st.file = null; st.removed = true; input.value = '';
    prev.innerHTML = '<span class="tiny">No image</span>';
    box.dispatchEvent(new Event('change', { bubbles: true }));
  };
  return st;
}

export const CHANNEL_ICON = { text: 'hash', voice: 'volume', announcement: 'megaphone', category: 'chevron' };
