// Side panels: search, pinned messages, mentions inbox.
import { $, el, esc, errToast, fmtStamp, debounce } from '../dom.js';
import { icon } from '../icons.js';
import { state, emit, displayName, channelById, dmName, nameAttrs, getUser, cacheUser } from '../store.js';
import { GET, DEL } from '../api.js';
import { renderMarkdown } from '../markdown.js';
import { avatarHtml } from './components.js';
import { layer } from './layers.js';
import { navigate, channelPath } from '../router.js';

let current = null;

function panel(title, { filter = '' } = {}) {
  current?.close();
  const root = el(`<aside class="side-panel"><div class="sp-head"><span class="row grow" style="gap:8px;min-width:0">${title}</span><button class="icon-btn" data-x title="Close">${icon('x')}</button></div>
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
  const atts = m.attachments.length ? `<div class="tiny muted">📎 ${m.attachments.map((a) => esc(a.name)).join(', ')}</div>` : '';
  return `<div class="result-card" data-ch="${m.channel_id}" data-m="${m.id}">
    ${showWhere ? `<div class="where">${where}</div>` : ''}
    <div class="msg first" style="margin-top:4px"><div class="avatar-wrap">${avatarHtml(getUser(m.author.id) || m.author)}</div>
      <div class="head"><span ${nameAttrs(sid, m.author.id, 'author')}>${esc(displayName(m.author.id, sid))}</span><span class="time">${fmtStamp(m.created_at)}</span>
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

// Wrap query matches in <mark> inside rendered message text.
function highlight(rootEl, q) {
  if (!q) return;
  const needle = q.toLowerCase();
  for (const content of rootEl.querySelectorAll('.result-card .content')) {
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const text = node.nodeValue;
      let i = text.toLowerCase().indexOf(needle);
      if (i < 0) continue;
      const frag = document.createDocumentFragment();
      let last = 0;
      while (i >= 0) {
        frag.append(text.slice(last, i));
        const mark = document.createElement('mark');
        mark.textContent = text.slice(i, i + q.length);
        frag.append(mark);
        last = i + q.length;
        i = text.toLowerCase().indexOf(needle, last);
      }
      frag.append(text.slice(last));
      node.replaceWith(frag);
    }
  }
}

const dayStart = (v) => (v ? new Date(`${v}T00:00:00`).getTime() : 0);

export async function openSearch({ serverId, channelId, query = '', inChannel = null }) {
  if (serverId && !state.members.has(serverId)) {
    try { await (await import('./app.js')).loadMembers(serverId); } catch { /* ignore */ }
  }
  const servers = state.serverOrder.map((id) => state.servers.get(id)).filter(Boolean);
  const textChannels = (sid) => (state.servers.get(sid)?.channels || []).filter((c) => c.type === 'text' || c.type === 'announcement');
  const { body, root, entry } = panel(`${icon('search')} Search Messages`, {
    filter: `<input class="input" data-q placeholder="Search messages" value="${esc(query)}" style="flex-basis:100%">
      ${serverId ? `<select class="input" data-server title="Server">${servers.map((sv) => `<option value="${sv.id}" ${sv.id === serverId ? 'selected' : ''}>${esc(sv.name)}</option>`).join('')}</select>
        <select class="input" data-in title="Channel"></select>
        <select class="input" data-from title="Author"></select>` : ''}
      <select class="input" data-has title="Content"><option value="">Any content</option><option value="file">Has file</option><option value="link">Has link</option><option value="poll">Has poll</option><option value="pin">Pinned</option></select>
      <label class="date-filter">After <input type="date" class="input" data-after></label>
      <label class="date-filter">Before <input type="date" class="input" data-before></label>
      <select class="input" data-sort title="Sort"><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select>`,
  });
  const $f = (sel) => root.querySelector(sel);
  const q = $f('[data-q]');

  const fillServerFilters = (selectedChannel = null) => {
    if (!serverId) return;
    const sid = Number($f('[data-server]').value);
    $f('[data-in]').innerHTML = `<option value="">All channels</option>${textChannels(sid).map((c) => `<option value="${c.id}" ${c.id === selectedChannel ? 'selected' : ''}>#${esc(c.name)}</option>`).join('')}`;
    const members = [...(state.members.get(sid)?.values() || [])].map((m) => m.user);
    $f('[data-from]').innerHTML = `<option value="">From anyone</option>${members.map((u) => `<option value="${u.id}">${esc(displayName(u.id, sid))}</option>`).join('')}`;
  };
  fillServerFilters(inChannel);

  let offset = 0;
  const run = async (more = false) => {
    if (!more) offset = 0;
    const params = new URLSearchParams();
    if (serverId) {
      params.set('server_id', $f('[data-server]').value);
      if ($f('[data-in]').value) params.set('in_channel', $f('[data-in]').value);
      if ($f('[data-from]').value) params.set('author_id', $f('[data-from]').value);
    } else params.set('channel_id', channelId);
    const text = q.value.trim();
    if (text) params.set('q', text);
    if ($f('[data-has]').value) params.set('has', $f('[data-has]').value);
    const after = dayStart($f('[data-after]').value), before = dayStart($f('[data-before]').value);
    if (after) params.set('after', after);
    if (before) params.set('before', before + 864e5); // inclusive of the chosen day
    params.set('sort', $f('[data-sort]').value);
    params.set('offset', offset);
    const filtered = text || params.has('author_id') || params.has('has') || params.has('after') || params.has('before') || params.has('in_channel');
    if (!filtered) { body.innerHTML = '<div class="empty">Type something or pick a filter to search.</div>'; return; }
    try {
      const r = await GET(`/search?${params}`);
      const html = r.results.map((m) => resultCard(m)).join('');
      if (more) { body.querySelector('[data-more]')?.parentElement.remove(); body.insertAdjacentHTML('beforeend', html); }
      else body.innerHTML = `<div class="label" style="padding:4px 12px">${r.total} Result${r.total === 1 ? '' : 's'}</div>${html || '<div class="empty">No results found.</div>'}`;
      highlight(body, text);
      offset += r.results.length;
      if (offset < r.total) body.insertAdjacentHTML('beforeend', '<div class="center" style="padding:12px"><button class="btn secondary small" data-more>Load more</button></div>');
    } catch (e) { errToast(e); }
  };
  q.addEventListener('input', debounce(() => run(), 350));
  root.querySelector('.sp-filter').addEventListener('change', async (e) => {
    if (e.target.matches('[data-server]')) {
      const sid = Number(e.target.value);
      if (!state.members.has(sid)) { try { await (await import('./app.js')).loadMembers(sid); } catch { /* ignore */ } }
      fillServerFilters();
    }
    if (e.target !== q) run();
  });
  body.addEventListener('click', (e) => { if (e.target.closest('[data-more]')) run(true); });
  bindJump(body, () => { if (matchMedia('(max-width: 860px)').matches) entry.close(); });
  body.innerHTML = '<div class="empty">Type something or pick a filter to search.</div>';
  if (query || inChannel) run();
  setTimeout(() => q.focus(), 30);
}
