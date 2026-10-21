// Emoji rendering: Noto 3D images everywhere except Apple devices (iOS, iPadOS, macOS),
// which keep their native Apple Color Emoji.
import { esc } from './dom.js';

export const isApple = /iPhone|iPad|iPod|Macintosh|Mac OS X/.test(navigator.userAgent) || (navigator.platform || '').startsWith('Mac');
if (isApple) document.documentElement.classList.add('apple');

let data = [];
let byChar = new Map();
let byCode = new Map();
let loading = null;

export function loadEmoji() {
  if (!loading) {
    loading = fetch('/emoji/data.json').then((r) => r.json()).then((list) => {
      data = list;
      byChar = new Map();
      byCode = new Map();
      for (const e of list) {
        byChar.set(strip(e.e), e);
        for (const s of e.s) if (!byCode.has(s)) byCode.set(s, e);
        if (e.t) e.t.forEach((t, i) => byChar.set(strip(t), { ...e, e: t, tone: i + 1, base: e }));
      }
      return list;
    }).catch(() => []);
  }
  return loading;
}

export const emojiList = () => data;
export const emojiByCode = (code) => byCode.get(code);
export const emojiInfo = (ch) => byChar.get(strip(ch));
const strip = (s) => s.replace(/️/g, '');

export function fileName(ch) {
  return [...ch].map((c) => c.codePointAt(0)).filter((c) => c !== 0xfe0f).map((c) => c.toString(16).padStart(4, '0')).join('-');
}
export const emojiUrl = (ch) => `/emoji/3d/${fileName(ch)}.webp`;

// HTML for a single unicode emoji.
export function emojiHtml(ch, cls = '') {
  if (isApple) return `<span class="emoji-native ${cls}">${esc(ch)}</span>`;
  return `<img class="emoji ${cls}" src="${emojiUrl(ch)}" alt="${esc(ch)}" draggable="false" loading="lazy">`;
}

export function customEmojiUrl(id) { return `/emoji/${id}`; }
export function customEmojiHtml(e, cls = '') {
  return `<img class="custom-emoji ${cls}" src="${customEmojiUrl(encodeURIComponent(String(e.id)))}" alt=":${esc(e.name)}:" title=":${esc(e.name)}:" draggable="false" loading="lazy">`;
}

// Any emoji value used by reactions / statuses: "c:<id>" for custom emoji, otherwise unicode.
export function anyEmojiHtml(value, custom, cls = '') {
  if (!value) return '';
  if (value.startsWith('c:')) return customEmojiHtml(custom || { id: value.slice(2), name: 'emoji' }, cls);
  return emojiHtml(value, cls);
}

let re;
try {
  re = new RegExp('\\p{RGI_Emoji}', 'gv');
} catch {
  re = /(?:\p{RI}\p{RI}|[#*0-9]️?⃣|\p{Extended_Pictographic}(?:️|\p{EMod})?(?:‍\p{Extended_Pictographic}(?:️|\p{EMod})?)*(?:[\u{E0020}-\u{E007E}]+\u{E007F})?)/gu;
}
export const emojiRegex = () => new RegExp(re.source, re.flags);

// Replace emoji in an already-escaped HTML text fragment (no tags inside).
export function emojify(text, cls = '') {
  if (isApple) return text;
  return text.replace(emojiRegex(), (m) => {
    // Plain text-presentation symbols like © ® ™ stay text unless followed by VS16.
    if (m.length === 1 && /[©®™↔-↙↩↪]/.test(m)) return m;
    return emojiHtml(m, cls);
  });
}

// Text-only check for "jumbo" emoji messages.
export function isEmojiOnly(raw) {
  const s = raw.replace(/<a?:\w+:\d+>/g, '').replace(emojiRegex(), '').replace(/\s+/g, '');
  if (s.length) return false;
  const count = (raw.match(/<a?:\w+:\d+>/g) || []).length + (raw.match(emojiRegex()) || []).length;
  return count > 0 && count <= 27;
}

// Fall back to native text if an image is missing.
document.addEventListener('error', (e) => {
  const t = e.target;
  if (t instanceof HTMLImageElement && t.classList.contains('emoji')) {
    const span = document.createElement('span');
    span.className = 'emoji-native';
    span.textContent = t.alt;
    t.replaceWith(span);
  }
}, true);

// ---------- Recents & skin tone ----------
const RECENT_KEY = 'yapper_recent_emoji';
export function recentEmoji() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; }
}
export function pushRecent(value) {
  const list = recentEmoji().filter((x) => x !== value);
  list.unshift(value);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 32))); } catch { /* ignore */ }
}
export function skinTone() {
  try { return Number(localStorage.getItem('yapper_skin') || 0); } catch { return 0; }
}
export function setSkinTone(n) {
  try { localStorage.setItem('yapper_skin', String(n)); } catch { /* ignore */ }
}
export const withTone = (e, tone = skinTone()) => (tone && e.t ? e.t[tone - 1] : e.e);
