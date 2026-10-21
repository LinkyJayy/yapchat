// Modals, context menus, popouts and the image lightbox.
import { el, esc, place, $ } from '../dom.js';
import { icon } from '../icons.js';

const layers = () => document.getElementById('layers');
const stack = [];

function closeTop() {
  const top = stack.pop();
  if (top) top.close(true);
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && stack.length) { e.preventDefault(); e.stopPropagation(); closeTop(); }
}, true);
window.addEventListener('popstate', () => { while (stack.length) closeTop(); });

function push(entry) {
  stack.push(entry);
  return entry;
}
function remove(entry) {
  const i = stack.indexOf(entry);
  if (i >= 0) stack.splice(i, 1);
}

// ---------- Modal ----------
// opts: { title, subtitle, body (html|Node), wide, buttons: [{label, cls, action(close)->bool|Promise}], onClose }
export function modal({ title = '', subtitle = '', body = '', wide = false, buttons = [], onClose, className = '' } = {}) {
  const root = el(`<div class="backdrop">
    <div class="modal ${wide ? 'wide' : ''} ${className}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      ${title ? `<div class="modal-head"><h2>${esc(title)}</h2>${subtitle ? `<p>${subtitle}</p>` : ''}
        <button class="icon-btn x" aria-label="Close">${icon('x')}</button></div>` : ''}
      <div class="modal-body"></div>
      ${buttons.length ? '<div class="modal-foot"></div>' : ''}
    </div></div>`);
  const bodyEl = $('.modal-body', root);
  if (typeof body === 'string') bodyEl.innerHTML = body; else if (body) bodyEl.append(body);
  let closed = false;
  const entry = {
    root, body: bodyEl,
    close(fromStack) {
      if (closed) return;
      closed = true;
      if (!fromStack) remove(entry);
      root.remove();
      onClose?.();
    },
  };
  const foot = $('.modal-foot', root);
  for (const b of buttons) {
    const btn = el(`<button class="btn ${b.cls || ''}">${esc(b.label)}</button>`);
    btn.onclick = async () => {
      if (!b.action) return entry.close();
      btn.disabled = true;
      try {
        const r = await b.action(entry);
        if (r !== false) entry.close();
      } finally { btn.disabled = false; }
    };
    foot.append(btn);
  }
  $('.x', root)?.addEventListener('click', () => entry.close());
  root.addEventListener('mousedown', (e) => { if (e.target === root) entry.close(); });
  layers().append(root);
  push(entry);
  setTimeout(() => $('input:not([type=hidden]):not([type=file]), textarea, select', bodyEl)?.focus(), 30);
  // Enter submits the primary button for single-line inputs.
  bodyEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && e.target.tagName === 'INPUT') {
      e.preventDefault();
      foot?.lastElementChild?.click();
    }
  });
  return entry;
}

export function confirmDialog({ title, text, confirm = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let ok = false;
    modal({
      title, body: `<p class="muted" style="margin:0 0 8px">${text}</p>`,
      buttons: [
        { label: 'Cancel', cls: 'ghost' },
        { label: confirm, cls: danger ? 'danger' : '', action: () => { ok = true; } },
      ],
      onClose: () => resolve(ok),
    });
  });
}

export function promptDialog({ title, label = '', value = '', placeholder = '', confirm = 'Save', maxlength = 100, hint = '' }) {
  return new Promise((resolve) => {
    let result = null;
    const m = modal({
      title,
      body: `<div class="field"><label>${esc(label)}</label><input class="input" maxlength="${maxlength}" value="${esc(value)}" placeholder="${esc(placeholder)}">${hint ? `<div class="hint">${hint}</div>` : ''}</div>`,
      buttons: [
        { label: 'Cancel', cls: 'ghost' },
        { label: confirm, action: (mm) => { result = $('input', mm.body).value; } },
      ],
      onClose: () => resolve(result),
    });
    $('input', m.body).select();
  });
}

// ---------- Context menu ----------
// items: [{label, action, danger, icon, checked, sep, header, hidden}]
let openMenu = null;
export function menu(items, at) {
  closeMenu();
  const root = el('<div class="menu" role="menu"></div>');
  for (const it of items) {
    if (!it || it.hidden) continue;
    if (it.sep) { root.append(el('<div class="menu-sep"></div>')); continue; }
    if (it.header) { root.append(el(`<div class="menu-label">${esc(it.header)}</div>`)); continue; }
    const b = el(`<button class="menu-item ${it.danger ? 'danger' : ''}" role="menuitem">
      <span>${it.html || esc(it.label)}</span>${it.checked != null ? `<input type="checkbox" class="chk" tabindex="-1" ${it.checked ? 'checked' : ''}>` : it.icon ? icon(it.icon) : ''}</button>`);
    b.onclick = (e) => { e.stopPropagation(); closeMenu(); it.action?.(); };
    root.append(b);
  }
  layers().append(root);
  const rect = at instanceof Element ? at.getBoundingClientRect() : { left: at.x, right: at.x, top: at.y, bottom: at.y };
  place(root, rect, { side: at instanceof Element ? 'bottom' : 'right', gap: at instanceof Element ? 4 : 0 });
  const entry = { close: () => closeMenu() };
  openMenu = { root, entry };
  push(entry);
  setTimeout(() => {
    document.addEventListener('mousedown', outside, true);
    document.addEventListener('touchstart', outside, true);
  });
  return root;
}
function outside(e) {
  if (openMenu && !openMenu.root.contains(e.target)) closeMenu();
}
export function closeMenu() {
  if (!openMenu) return;
  openMenu.root.remove();
  remove(openMenu.entry);
  openMenu = null;
  document.removeEventListener('mousedown', outside, true);
  document.removeEventListener('touchstart', outside, true);
}

// ---------- Popout ----------
let openPop = null;
export function popout(node, anchor, { side = 'right', className = 'popout' } = {}) {
  closePopout();
  const root = el(`<div class="${className}"></div>`);
  root.append(node);
  layers().append(root);
  const rect = anchor instanceof Element ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
  place(root, rect, { side });
  const entry = { close: () => closePopout() };
  openPop = { root, entry, anchor };
  push(entry);
  setTimeout(() => document.addEventListener('mousedown', outsidePop, true));
  return root;
}
function outsidePop(e) {
  if (!openPop) return;
  if (openPop.root.contains(e.target)) return;
  if (e.target.closest?.('.menu, .backdrop, .picker')) return;
  closePopout();
}
export function closePopout() {
  if (!openPop) return;
  openPop.root.remove();
  remove(openPop.entry);
  openPop = null;
  document.removeEventListener('mousedown', outsidePop, true);
}
export const popoutOpen = () => !!openPop;

// ---------- Generic layer (pickers, panels) ----------
export function layer(node, { onClose, outsideClose = true } = {}) {
  layers().append(node);
  let closed = false;
  const entry = {
    close(fromStack) {
      if (closed) return;
      closed = true;
      if (!fromStack) remove(entry);
      node.remove();
      document.removeEventListener('mousedown', out, true);
      onClose?.();
    },
  };
  const out = (e) => { if (!node.contains(e.target) && !e.target.closest?.('.menu')) entry.close(); };
  if (outsideClose) setTimeout(() => document.addEventListener('mousedown', out, true));
  push(entry);
  return entry;
}

// ---------- Lightbox ----------
export function lightbox(url, kind = 'image', name = '') {
  const media = kind === 'video' ? `<video src="${esc(url)}" controls autoplay></video>` : `<img src="${esc(url)}" alt="${esc(name)}">`;
  const root = el(`<div class="lightbox">${media}<a class="open" href="${esc(url)}" target="_blank" rel="noopener">Open original</a></div>`);
  const entry = layer(root, { outsideClose: false });
  root.addEventListener('click', (e) => { if (e.target === root || e.target.tagName === 'IMG') entry.close(); });
}
