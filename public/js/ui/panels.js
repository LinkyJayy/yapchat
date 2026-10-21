// Side panels: search, pinned messages, mentions inbox.
import { $, el, esc, errToast, fmtStamp, debounce } from '../dom.js';
import { icon } from '../icons.js';
import { state, emit, displayName, channelById, dmName, memberColor, getUser, cacheUser } from '../store.js';
import { GET, DEL } from '../api.js';
import { renderMarkdown } from '../markdown.js';
import { avatarHtml } from './components.js';
import { layer } from './layers.js';
import { navigate, channelPath } from '../router.js';

let current = null;

function panel(title, { filter = '' } = {}) {
  current?.close();
  const root = el(`<aside class="side-panel"><div class="sp-head">${title}<span class="grow"></span><button class="icon-btn" data-x title="Close">${icon('x')}</button></div>
    ${filter ? `<div class="sp-filter">${filter}</div>` : ''}<div class="sp-body"></div></aside>`);
  const entry = layer(root, { onClose: () => { if (current === entry) current = null; } });
  current = entry;
  $('[data-x]', root).onclick = () => entry.close();
  return { root, body: $('.sp-body', root), entry };
}

function resultCard(m, { showWhere = true, unpin = false } = {}) {
  cacheUser(m.author);
  const ch = channelById(m.channel_id);
  const sid = ch?.server_id || null;
  const where = !ch ? '' : ch.server_id ? `${esc(state.servers.get(ch.server_id)?.name || '')} › #${esc(ch.name)}` : esc(dmName(ch));
  const color = sid ? memberColor(sid, m.author.id) : null;
  const atts = m.attachments.length ? `<div class="tiny muted">📎 ${m.attachments.map((a) => esc(a.name)).join(', ')}</div>` : '';
  return `<div class="result-card" data-ch="${m.channel_id}" data-m="${m.id}">
    ${showWhere ? `<div class="where">${where}</div>` : ''}
    <div class="msg first" style="margin-top:4px"><div class="avatar-wrap">${avatarHtml(getUser(m.author.id) || m.author)}</div>
      <div class="head"><span class="author" ${color ? `style="color:${color}"` : ''}>${esc(displayName(m.author.id, sid))}</span><span class="time">${fmtStamp(m.created_at)}</span>
      ${unpin ? `<button class="icon-btn" data-unpin="${m.id}" title="Unpin" style="margin-left:auto;width:24px;height:24px">${icon('x')}</button>` : ''}</div>
      <div class="content">${m.type === 'poll' ? `📊 ${esc(m.content)}` : renderMarkdown(m.content, { serverId: sid })}</div>${atts}</div></div>`;
}

function bindJump(body, closeAfter) {
  body.addEventListener('click', (e) => {
    if (e.target.closest('[data-unpin]')) return;
    const c = e.target.closest('.result-card');
    if (!c) return;
    const chId = Number(c.dataset.ch), mid = Number(c.dataset.m);
    const ch = channelById(chId);
    if (!ch) return;
    if (state.route.channelId === chId) emit('jump', { channelId: chId, messageId: mid });
    else navigate(`${channelPath(ch.server_id || '@me', chId)}?m=${mid}`);
    if (closeAfter) closeAfter();
  });
}

export async function openPins(ch) {
  const { body, entry } = panel(`${icon('pin')} Pinned Messages`);
  body.innerHTML = '<div class="empty">Loading…</div>';
  const load = async () => {
    try {
      const list = await GET(`/channels/${ch.id}/pins`);
      const canUnpin = !ch.server_id || ((ch.permissions | 0) & (1 << 12));
      body.innerHTML = list.map((m) => resultCard(m, { showWhere: false, unpin: canUnpin })).join('') || `<div class="empty"><img src="/icons/logo.png" alt=""><div>This channel doesn't have any pinned messages... yet.</div></div>`;
    } catch (e) { errToast(e); }
  };
  body.addEventListener('click', async (e) => {
    const u = e.target.closest('[data-unpin]');
    if (u) { try { await DEL(`/channels/${ch.id}/pins/${u.dataset.unpin}`); load(); } catch (err) { errToast(err); } }
  });
  bindJump(body, () => entry.close());
  load();
}

export async function openMentions() {
  const { body, entry } = panel(`${icon('at')} Recent Mentions`);
  body.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const list = await GET('/mentions');
    body.innerHTML = list.map((m) => resultCard(m)).join('') || `<div class="empty"><img src="/icons/logo.png" alt=""><div>No recent mentions. When someone @mentions you, it'll show up here.</div></div>`;
  } catch (e) { errToast(e); }
  bindJump(body, () => entry.close());
}

export function openSearch({ serverId, channelId }) {
  const members = serverId ? [...(state.members.get(serverId)?.values() || [])].map((m) => m.user) : [];
  const { body, root, entry } = panel(`${icon('search')} Search`, {
    filter: `<input class="input grow" data-q placeholder="Search messages" style="min-width:160px">
      ${serverId ? `<select class="input" data-from style="width:auto"><option value="">From anyone</option>${members.map((u) => `<option value="${u.id}">${esc(displayName(u.id, serverId))}</option>`).join('')}</select>` : ''}
      <select class="input" data-has style="width:auto"><option value="">Any content</option><option value="file">Has file</option><option value="poll">Has poll</option><option value="pin">Pinned</option></select>`,
  });
  const q = $('[data-q]', root);
  let offset = 0;
  const run = async (more = false) => {
    if (!more) offset = 0;
    const params = new URLSearchParams();
    if (serverId) params.set('server_id', serverId); else params.set('channel_id', channelId);
    if (q.value.trim()) params.set('q', q.value.trim());
    const from = $('[data-from]', root)?.value;
    if (from) params.set('author_id', from);
    const hs = $('[data-has]', root).value;
    if (hs) params.set('has', hs);
    params.set('offset', offset);
    if (!q.value.trim() && !from && !hs) { body.innerHTML = '<div class="empty">Type something to search.</div>'; return; }
    try {
      const r = await GET(`/search?${params}`);
      const html = r.results.map((m) => resultCard(m)).join('');
      if (more) { body.querySelector('[data-more]')?.remove(); body.insertAdjacentHTML('beforeend', html); }
      else body.innerHTML = `<div class="label" style="padding:4px 12px">${r.total} Result${r.total === 1 ? '' : 's'}</div>${html || '<div class="empty">No results found.</div>'}`;
      offset += r.results.length;
      if (offset < r.total) body.insertAdjacentHTML('beforeend', '<div class="center" style="padding:12px"><button class="btn secondary small" data-more>Load more</button></div>');
    } catch (e) { errToast(e); }
  };
  q.addEventListener('input', debounce(() => run(), 350));
  root.querySelectorAll('select').forEach((s) => s.addEventListener('change', () => run()));
  body.addEventListener('click', (e) => { if (e.target.closest('[data-more]')) run(true); });
  bindJump(body, () => { if (matchMedia('(max-width: 860px)').matches) entry.close(); });
  body.innerHTML = '<div class="empty">Type something to search.</div>';
  setTimeout(() => q.focus(), 30);
}
