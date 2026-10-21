// Emoji picker with Noto 3D emoji, custom server emojis (static + animated), search, recents and skin tones.
import { el, esc, place, debounce, isMobile } from '../dom.js';
import { icon } from '../icons.js';
import { layer } from './layers.js';
import { state } from '../store.js';
import { loadEmoji, emojiList, emojiHtml, customEmojiHtml, recentEmoji, pushRecent, skinTone, setSkinTone, withTone, emojiInfo } from '../emoji.js';
import { serverIconHtml } from './components.js';

const CATS = [
  ['people', 'smile', 'Smileys & People'],
  ['nature', 'leaf', 'Animals & Nature'],
  ['food', 'coffee', 'Food & Drink'],
  ['travel', 'car', 'Travel & Places'],
  ['activities', 'ball', 'Activities'],
  ['objects', 'bulb', 'Objects'],
  ['symbols', 'heart', 'Symbols'],
  ['flags', 'flag', 'Flags'],
];
const TONES = ['👋', '👋🏻', '👋🏼', '👋🏽', '👋🏾', '👋🏿'];

function allCustom() {
  const out = [];
  for (const id of state.serverOrder) {
    const s = state.servers.get(id);
    if (s?.emojis.length) out.push(s);
  }
  return out;
}
function findCustom(id) {
  for (const s of state.servers.values()) {
    const e = s.emojis.find((x) => x.id === Number(id));
    if (e) return e;
  }
  return null;
}

// onPick({ type: 'unicode', value }) or ({ type: 'custom', emoji })
export async function openPicker(anchor, onPick, { keepOpen = false, serverId = null } = {}) {
  await loadEmoji();
  const root = el(`<div class="picker" role="dialog" aria-label="Emoji picker">
    <div class="top"><input type="search" placeholder="Find the perfect emoji" aria-label="Search emoji">
      <button class="skin" title="Skin tone">${emojiHtml(TONES[skinTone()])}</button></div>
    <div class="mid"><nav class="cats"></nav><div class="grid-scroll"></div></div>
    <div class="foot"><span class="fp"></span><span class="fn"></span><span class="sc"></span></div>
  </div>`);
  const input = root.querySelector('input');
  const scroll = root.querySelector('.grid-scroll');
  const cats = root.querySelector('.cats');
  const foot = root.querySelector('.foot');

  const pick = (value, custom) => {
    if (custom) { pushRecent(`c:${custom.id}`); onPick({ type: 'custom', emoji: custom }); }
    else { pushRecent(value); onPick({ type: 'unicode', value }); }
    if (!keepOpen) entry.close();
  };

  function section(id, titleHtml, buttons) {
    if (!buttons.length) return '';
    return `<div data-sec="${id}"><div class="cat-title">${titleHtml}</div><div class="grid">${buttons.join('')}</div></div>`;
  }
  const uBtn = (ch, name) => `<button data-u="${esc(ch)}" data-n="${esc(name)}" title=":${esc(name)}:">${emojiHtml(ch)}</button>`;
  const cBtn = (e) => `<button data-c="${e.id}" data-n="${esc(e.name)}" title=":${esc(e.name)}:">${customEmojiHtml(e)}</button>`;

  function renderAll() {
    const tone = skinTone();
    const parts = [];
    const recents = recentEmoji().map((r) => {
      if (r.startsWith('c:')) { const e = findCustom(r.slice(2)); return e ? cBtn(e) : null; }
      const info = emojiInfo(r);
      return uBtn(r, info?.s?.[0] || info?.n || '');
    }).filter(Boolean);
    parts.push(section('recent', `${icon('clock')} Frequently Used`, recents));
    const servers = allCustom();
    if (serverId) servers.sort((a, b) => (b.id === serverId) - (a.id === serverId));
    for (const s of servers) parts.push(section(`s${s.id}`, esc(s.name), s.emojis.map(cBtn)));
    const list = emojiList();
    for (const [id, , title] of CATS) {
      parts.push(section(id, esc(title), list.filter((e) => e.g === id).map((e) => uBtn(withTone(e, tone), e.s[0] || e.n))));
    }
    scroll.innerHTML = parts.join('');
    cats.innerHTML = [
      recents.length ? `<button data-go="recent" title="Frequently Used">${icon('clock')}</button>` : '',
      ...servers.map((s) => `<button data-go="s${s.id}" title="${esc(s.name)}">${s.icon ? `<img src="${esc(s.icon)}" alt="">` : icon('star')}</button>`),
      ...CATS.map(([id, ic, title]) => `<button data-go="${id}" title="${esc(title)}">${icon(ic)}</button>`),
    ].join('');
  }

  function renderSearch(q) {
    q = q.toLowerCase().replace(/:/g, '');
    const tone = skinTone();
    const custom = [];
    for (const s of allCustom()) for (const e of s.emojis) if (e.name.toLowerCase().includes(q)) custom.push(cBtn(e));
    const uni = emojiList().filter((e) => e.n.includes(q) || e.s.some((s) => s.includes(q)) || e.k.includes(q))
      .slice(0, 200).map((e) => uBtn(withTone(e, tone), e.s[0] || e.n));
    scroll.innerHTML = section('results', 'Search Results', [...custom, ...uni]) || '<div class="empty">No emoji found. 🥲</div>';
  }

  renderAll();
  cats.onclick = (e) => {
    const b = e.target.closest('[data-go]');
    if (!b) return;
    const sec = scroll.querySelector(`[data-sec="${b.dataset.go}"]`);
    if (sec) scroll.scrollTop = sec.offsetTop - 4;
  };
  scroll.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.c) pick(null, findCustom(b.dataset.c));
    else if (b.dataset.u) pick(b.dataset.u);
  };
  scroll.onmouseover = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    foot.querySelector('.fp').innerHTML = b.innerHTML;
    foot.querySelector('.fn').textContent = '';
    foot.querySelector('.sc').textContent = `:${b.dataset.n}:`;
  };
  input.oninput = debounce(() => (input.value.trim() ? renderSearch(input.value.trim()) : renderAll()), 80);
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); scroll.querySelector('.grid button')?.click(); }
  };
  const openTones = (e) => {
    e.stopPropagation();
    const row = el(`<div class="skin-row">${TONES.map((t, i) => `<button class="skin" data-t="${i}">${emojiHtml(t)}</button>`).join('')}</div>`);
    const top = root.querySelector('.top');
    top.replaceChildren(row);
    row.onclick = (ev) => {
      const b = ev.target.closest('[data-t]');
      if (!b) return;
      setSkinTone(Number(b.dataset.t));
      top.replaceChildren(input, el(`<button class="skin" title="Skin tone">${emojiHtml(TONES[skinTone()])}</button>`));
      top.lastElementChild.onclick = openTones;
      renderAll();
    };
  };
  root.querySelector('.skin').onclick = openTones;

  const entry = layer(root);
  const rect = anchor instanceof Element ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
  if (!isMobile()) place(root, rect, { side: 'top' });
  if (!isMobile()) setTimeout(() => input.focus(), 20);
  return entry;
}
