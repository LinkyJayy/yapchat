// Small DOM helpers shared by every view.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

// Build an element from an HTML string (single root).
export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function on(root, event, selector, handler, opts) {
  root.addEventListener(event, (e) => {
    const t = e.target.closest?.(selector);
    if (t && root.contains(t)) handler(e, t);
  }, opts);
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function toast(text, type = '') {
  const box = document.getElementById('toasts');
  const t = el(`<div class="toast ${type}">${esc(text)}</div>`);
  box.append(t);
  setTimeout(() => t.remove(), 3500);
}

export const errToast = (e) => toast(e?.message || String(e), 'error');

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dateFmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
const shortDate = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' });
const fullFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export const fmtTime = (ts) => timeFmt.format(ts);
export const fmtDate = (ts) => dateFmt.format(ts);
export const fmtFull = (ts) => fullFmt.format(ts);
export function fmtStamp(ts) {
  const d = new Date(ts);
  const now = new Date();
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return `Today at ${fmtTime(ts)}`;
  if (d.toDateString() === yest.toDateString()) return `Yesterday at ${fmtTime(ts)}`;
  return `${shortDate.format(ts)} ${fmtTime(ts)}`;
}
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
export function fmtRelative(ts) {
  const diff = (ts - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day');
  if (abs < 86400 * 365) return rtf.format(Math.round(diff / (86400 * 30)), 'month');
  return rtf.format(Math.round(diff / (86400 * 365)), 'year');
}
export function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${s}s`;
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied!', 'ok'); } catch { toast('Could not copy.', 'error'); }
}

export const isMobile = () => matchMedia('(max-width: 860px)').matches;

// Position a floating element next to an anchor rect, keeping it on-screen.
export function place(node, rect, { side = 'right', gap = 8 } = {}) {
  node.style.left = '0px'; node.style.top = '0px';
  const w = node.offsetWidth, h = node.offsetHeight;
  const vw = innerWidth, vh = innerHeight;
  let x, y;
  if (side === 'right') { x = rect.right + gap; y = rect.top; if (x + w > vw - 8) x = rect.left - w - gap; }
  else if (side === 'left') { x = rect.left - w - gap; y = rect.top; if (x < 8) x = rect.right + gap; }
  else if (side === 'top') { x = rect.left; y = rect.top - h - gap; if (y < 8) y = rect.bottom + gap; }
  else { x = rect.left; y = rect.bottom + gap; if (y + h > vh - 8) y = rect.top - h - gap; }
  x = Math.min(Math.max(8, x), vw - w - 8);
  y = Math.min(Math.max(8, y), vh - h - 8);
  node.style.left = `${x}px`; node.style.top = `${y}px`;
}
