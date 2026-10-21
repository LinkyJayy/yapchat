// Text channel / DM view: header, message list, composer.
import { $, $$, el, esc, toast, errToast, copyText, fmtStamp, fmtTime, fmtFull, fmtDate, fmtBytes, fmtDuration, isMobile, debounce } from '../dom.js';
import { icon } from '../icons.js';
import { state, on, emit, P, has, displayName, memberColor, dmName, getUser, cacheUser, isMuted } from '../store.js';
import { GET, POST, PUT, DEL, PATCH, upload } from '../api.js';
import { renderMarkdown, plainText } from '../markdown.js';
import { emojiHtml, anyEmojiHtml, isEmojiOnly, emojify, emojiByCode, emojiList, loadEmoji, withTone, customEmojiHtml, recentEmoji } from '../emoji.js';
import { avatarHtml, CHANNEL_ICON } from './components.js';
import { menu, modal, confirmDialog, lightbox } from './layers.js';
import { openPicker } from './picker.js';
import { openProfile, userMenu } from './profile.js';
import { sendTyping } from '../realtime.js';
import { navigate, channelPath } from '../router.js';
import * as voice from './voice.js';
import { openPollComposer } from './poll.js';

const drafts = new Map();
const PAGE = 50;
let replyPing = true;

export function mountChat(slot, ch) {
  const server = ch.server_id ? state.servers.get(ch.server_id) : null;
  const sid = server?.id || null;
  const perms = () => (server ? (state.servers.get(sid)?.channels.find((c) => c.id === ch.id)?.permissions ?? 0) : ~0);
  const isDM = !server;
  const other = ch.type === 'dm' ? getUser(ch.recipients[0]?.id) || ch.recipients[0] : null;
  const title = isDM ? dmName(ch) : ch.name;

  const root = el(`<div class="chat">
    <header class="chat-header">
      <button class="icon-btn menu-btn" data-nav aria-label="Open navigation">${icon('menu')}</button>
      <div class="title">${isDM ? (other ? avatarHtml(other, { size: 's24', status: true }) : icon('users')) : icon(CHANNEL_ICON[ch.type] || 'hash')}<span>${emojify(esc(title))}</span></div>
      ${!isDM && ch.topic ? `<div class="topic" data-topic>${renderMarkdown(ch.topic, { serverId: sid, inline: true })}</div>` : '<div class="grow"></div>'}
      <div class="tools">
        ${isDM ? `<button class="icon-btn" data-call title="Start Voice Call">${icon('phone')}</button><button class="icon-btn" data-vcall title="Start Video Call">${icon('video')}</button>` : ''}
        <button class="icon-btn hide-mobile" data-pins title="Pinned Messages">${icon('pin')}</button>
        <button class="icon-btn hide-mobile" data-mute title="Notification Settings">${icon(isMuted(ch.id) ? 'bellOff' : 'bell')}</button>
        ${!isDM || ch.type === 'group' ? `<button class="icon-btn" data-members title="Member List">${icon('users')}</button>` : ''}
        <button class="icon-btn" data-search title="Search">${icon('search')}</button>
      </div>
    </header>
    <div class="call-slot"></div>
    <div class="messages" tabindex="-1"><div class="messages-inner"><div class="top-slot"></div><div class="list"></div></div></div>
    <div class="composer-wrap"></div>
  </div>`);
  slot.append(root);

  const scroller = $('.messages', root);
  const listEl = $('.list', root);
  const topSlot = $('.top-slot', root);
  const composerWrap = $('.composer-wrap', root);
  let box = state.messages.get(ch.id);
  let stick = true;
  let destroyed = false;
  let firstUnreadId = null;
  const unsubs = [];

  // ---------- Header ----------
  $('.chat-header', root).onclick = (e) => {
    if (e.target.closest('[data-nav]')) return emit('open_nav');
    if (e.target.closest('[data-members]')) return emit('toggle_members');
    if (e.target.closest('[data-search]')) return import('./panels.js').then((m) => m.openSearch({ serverId: sid, channelId: isDM ? ch.id : null }));
    if (e.target.closest('[data-pins]')) return import('./panels.js').then((m) => m.openPins(ch));
    if (e.target.closest('[data-call]')) return voice.join(ch.id);
    if (e.target.closest('[data-vcall]')) return voice.join(ch.id, { video: true });
    const mt = e.target.closest('[data-mute]');
    if (mt) return import('./app.js').then((m) => menu([
      { label: isMuted(ch.id) ? 'Unmute' : 'Mute', action: () => m.setNotify(ch.id, { muted: !isMuted(ch.id), level: state.notify.get(ch.id)?.level ?? null }) },
      ...(isDM ? [] : [{ header: 'Notifications' }, ...[['default', 'Use Server Default'], ['all', 'All Messages'], ['mentions', 'Only @mentions'], ['none', 'Nothing']].map(([v, l]) => ({
        label: l, checked: (state.notify.get(ch.id)?.level || 'default') === v, action: () => m.setNotify(ch.id, { level: v === 'default' ? null : v, muted: isMuted(ch.id) }),
      }))]),
    ], mt));
    if (e.target.closest('[data-topic]')) modal({ title: `#${ch.name}`, body: `<div class="content" style="white-space:pre-wrap">${renderMarkdown(ch.topic, { serverId: sid })}</div>` });
    const t = e.target.closest('.title');
    if (t && other) openProfile(other.id, t);
  };

  // Active DM call banner.
  const renderCall = () => {
    const callSlot = $('.call-slot', root);
    if (!isDM) return;
    const states = state.voice.get(ch.id) || [];
    const inCall = voice.current()?.channelId === ch.id;
    if (!states.length && !inCall) { callSlot.innerHTML = ''; return; }
    if (inCall) { if (!callSlot.querySelector('.voice-room')) { callSlot.innerHTML = ''; voiceView = voice.mountVoiceRoom(callSlot, ch, { compact: true }); } return; }
    voiceView?.destroy(); voiceView = null;
    callSlot.innerHTML = `<div class="call-banner">${icon('phone')}<div class="grow">${states.map((s) => esc(displayName(s.user_id))).join(', ')} ${states.length === 1 ? 'is' : 'are'} in a call.</div><button class="btn small" data-join>Join Call</button></div>`;
    $('[data-join]', callSlot).onclick = () => voice.join(ch.id);
  };
  let voiceView = null;
  unsubs.push(on('voice_changed', renderCall));
  renderCall();

  // ---------- Messages ----------
  const isMentioned = (m) => {
    const me = state.user.id;
    if (m.author.id === me) return false;
    if (m.mentions.includes(me) || m.mention_everyone) return true;
    if (sid && m.mention_roles.length) {
      const my = state.servers.get(sid)?.me?.roles || [];
      return m.mention_roles.some((r) => my.includes(r));
    }
    return false;
  };

  const grouped = (m, prev) => prev && prev.type !== 'system' && m.type !== 'system' && prev.author.id === m.author.id && !m.reply
    && m.created_at - prev.created_at < 7 * 60_000 && new Date(m.created_at).toDateString() === new Date(prev.created_at).toDateString()
    && m.id !== firstUnreadId;

  function authorName(u) {
    const color = sid ? memberColor(sid, u.id) : null;
    return `<span class="author" data-user="${u.id}" ${color ? `style="color:${color}"` : ''}>${emojify(esc(displayName(u.id, sid)))}</span>`;
  }

  function attachmentsHtml(m) {
    if (!m.attachments.length) return '';
    return `<div class="attachments">${m.attachments.map((a, i) => {
      const spoiler = a.name.startsWith('SPOILER_');
      const wrap = (inner) => (spoiler ? `<div class="spoiler-media hidden-spoiler" data-spoiler>${inner}</div>` : inner);
      if (a.kind === 'image') return wrap(`<img class="att-img" src="${esc(a.url)}" alt="${esc(a.name)}" loading="lazy" data-att="${i}">`);
      if (a.kind === 'video') return wrap(`<video class="att-video" src="${esc(a.url)}" controls preload="metadata"></video>`);
      if (a.kind === 'audio') return `<div class="att-file">${icon('volume')}<div class="meta"><a href="${esc(a.url)}?name=${encodeURIComponent(a.name)}" target="_blank" rel="noopener">${esc(a.name)}</a><audio class="att-audio" src="${esc(a.url)}" controls preload="none"></audio></div></div>`;
      return `<div class="att-file">${icon('file')}<div class="meta"><a href="${esc(a.url)}?name=${encodeURIComponent(a.name)}" download="${esc(a.name)}">${esc(a.name)}</a><span>${fmtBytes(a.size)}</span></div>
        <a class="icon-btn" href="${esc(a.url)}?name=${encodeURIComponent(a.name)}" download="${esc(a.name)}" title="Download">${icon('download')}</a></div>`;
    }).join('')}</div>`;
  }

  function reactionsHtml(m) {
    if (!m.reactions.length) return '';
    const me = state.user.id;
    return `<div class="reactions">${m.reactions.map((r) => {
      const names = r.users.slice(0, 10).map((id) => displayName(id, sid)).join(', ') + (r.users.length > 10 ? ` and ${r.users.length - 10} more` : '');
      return `<button class="reaction ${r.users.includes(me) ? 'me' : ''}" data-react="${esc(r.emoji)}" title="${esc(names)} reacted">${anyEmojiHtml(r.emoji, r.custom)}<span>${r.users.length}</span></button>`;
    }).join('')}${has(perms(), P.ADD_REACTIONS) ? `<button class="reaction add" data-addreact title="Add Reaction">${icon('smilePlus')}</button>` : ''}</div>`;
  }

  function pollHtml(m) {
    const p = m.poll;
    if (!p) return '';
    const me = state.user.id;
    const total = new Set(p.votes.flat()).size;
    const voted = p.votes.some((v) => v.includes(me));
    const showResults = voted || p.ended;
    const max = Math.max(...p.votes.map((v) => v.length));
    const left = p.expires_at - Date.now();
    return `<div class="poll ${p.multi ? 'multi' : ''}" data-poll>
      <div class="q">${emojify(esc(p.question))}</div>
      <div class="sub">${p.multi ? 'Select one or more answers' : 'Select one answer'}</div>
      ${p.options.map((o, i) => {
        const n = p.votes[i].length;
        const pct = total ? Math.round((n / total) * 100) : 0;
        const mine = p.votes[i].includes(me);
        return `<button class="poll-opt ${mine ? 'mine' : ''} ${p.ended && n === max && n > 0 ? 'winner' : ''}" data-opt="${i}" ${p.ended ? 'disabled' : ''}>
          ${showResults ? `<span class="bar" style="width:${pct}%"></span>` : ''}
          ${o.emoji ? anyEmojiHtml(o.emoji, null) : ''}<span class="txt">${emojify(esc(o.text))}</span>
          ${showResults ? `<span class="pct">${n} · ${pct}%</span>` : ''}<span class="check">${mine ? icon('check') : ''}</span></button>`;
      }).join('')}
      <div class="foot"><span>${total} vote${total === 1 ? '' : 's'}</span><span>·</span>
        <span class="grow">${p.ended ? 'Poll closed' : `${fmtDuration(left)} left`}</span>
        ${voted && !p.ended ? '<button class="btn small secondary" data-unvote>Remove Vote</button>' : ''}
        ${!p.ended && (m.author.id === me || (sid && has(perms(), P.MANAGE_MESSAGES))) ? '<button class="btn small secondary" data-endpoll>End Poll</button>' : ''}
      </div></div>`;
  }

  function systemHtml(m) {
    const who = `<span class="who" data-user="${m.author.id}">${esc(displayName(m.author.id, sid))}</span>`;
    let text, ic = 'arrowRight';
    if (m.content === 'join') text = `${who} joined the server. Say hi! 👋`;
    else if (m.content === 'leave') { text = `${who} left the server.`; ic = 'door'; }
    else if (m.content === 'pin') { text = `${who} pinned <a href="#" data-jump="${m.reply?.id}">a message</a> to this channel. See all <a href="#" data-allpins>pinned messages</a>.`; ic = 'pin'; }
    else text = esc(m.content);
    return `<div class="msg system" data-id="${m.id}">${icon(ic, 'sys-icon')}<span>${emojify(text)}</span> <span class="time" title="${esc(fmtFull(m.created_at))}">${fmtStamp(m.created_at)}</span></div>`;
  }

  function messageHtml(m, prev) {
    if (m.type === 'system') return systemHtml(m);
    const g = grouped(m, prev);
    const blocked = state.relationships.get(m.author.id)?.type === 'blocked';
    if (blocked) return `<div class="msg ${g ? '' : 'first'}" data-id="${m.id}"><span class="faint small">Blocked message — <a href="#" data-showblocked>show</a></span></div>`;
    const jumbo = m.type !== 'poll' && !m.attachments.length && isEmojiOnly(m.content);
    const author = getUser(m.author.id) || m.author;
    let reply = '';
    if (m.reply) {
      reply = m.reply.deleted
        ? `<div class="reply-ctx"><span class="rc faint">Original message was deleted</span></div>`
        : `<div class="reply-ctx" data-jump="${m.reply.id}">${avatarHtml(m.reply.author, { size: '' })}<span class="ra">@${esc(displayName(m.reply.author.id, sid))}</span>
           <span class="rc">${m.reply.content ? renderMarkdown(plainText(m.reply.content, sid).slice(0, 200), { serverId: sid, inline: true }) : '<i>Click to see attachment</i>'}</span></div>`;
    }
    const content = m.type === 'poll' ? '' : renderMarkdown(m.content, { serverId: sid, jumbo });
    const edited = m.edited_at ? `<span class="edited" title="${esc(fmtFull(m.edited_at))}">(edited)</span>` : '';
    const head = g ? `<span class="side-time" title="${esc(fmtFull(m.created_at))}">${fmtTime(m.created_at)}</span>`
      : `<div class="avatar-wrap" data-user="${author.id}">${avatarHtml(author)}</div>
         <div class="head">${authorName(author)}<span class="time" title="${esc(fmtFull(m.created_at))}">${fmtStamp(m.created_at)}</span></div>`;
    return `<div class="msg ${g ? '' : 'first'} ${isMentioned(m) ? 'mentioned' : ''} ${m.pending ? 'pending' : ''} ${m.failed ? 'failed' : ''}" data-id="${m.id}">
      ${reply}${head}
      <div class="content ${jumbo ? 'jumbo-wrap' : ''}">${content}${edited}</div>
      ${pollHtml(m)}${attachmentsHtml(m)}${reactionsHtml(m)}
      ${m.pending ? '' : actionsHtml(m)}
    </div>`;
  }

  function actionsHtml(m) {
    const quick = recentEmoji().filter((x) => !x.startsWith('c:')).slice(0, 3);
    while (quick.length < 3) for (const d of ['👍', '😂', '❤️']) if (quick.length < 3 && !quick.includes(d)) quick.push(d);
    const canReact = has(perms(), P.ADD_REACTIONS);
    return `<div class="msg-actions">
      ${canReact ? `<div class="quick">${quick.map((q) => `<button data-quick="${esc(q)}" title="React">${emojiHtml(q)}</button>`).join('')}</div>
      <button class="icon-btn" data-addreact title="Add Reaction">${icon('smilePlus')}</button>` : ''}
      ${m.author.id === state.user.id && m.type !== 'poll' ? `<button class="icon-btn" data-edit title="Edit">${icon('edit')}</button>` : ''}
      ${has(perms(), P.SEND_MESSAGES) ? `<button class="icon-btn" data-reply title="Reply">${icon('reply')}</button>` : ''}
      <button class="icon-btn" data-more title="More">${icon('more')}</button>
    </div>`;
  }

  function renderAll() {
    const list = box?.list || [];
    let html = '';
    let prev = null;
    for (const m of list) {
      if (!prev || new Date(prev.created_at).toDateString() !== new Date(m.created_at).toDateString()) {
        html += `<div class="day-divider">${fmtDate(m.created_at)}</div>`;
      }
      if (m.id === firstUnreadId) html += '<div class="new-divider"><span>NEW</span></div>';
      html += messageHtml(m, prev);
      prev = m;
    }
    listEl.innerHTML = html;
    renderTop();
  }

  function renderTop() {
    if (box?.hasMore) { topSlot.innerHTML = '<div class="load-more">Loading older messages…</div>'; return; }
    const big = isDM ? (other ? avatarHtml(other, { size: 's80' }) : `<div class="big-icon">${icon('users')}</div>`) : `<div class="big-icon">${icon(CHANNEL_ICON[ch.type] || 'hash')}</div>`;
    topSlot.innerHTML = `<div class="welcome">${big}<h2>${isDM ? emojify(esc(title)) : `Welcome to #${emojify(esc(ch.name))}!`}</h2>
      <p>${isDM ? (other ? `This is the beginning of your direct message history with <b>${esc(displayName(other.id))}</b>.` : 'Welcome to the beginning of this group.') : `This is the start of the #${esc(ch.name)} channel.`}</p></div>`;
  }

  function rerender(id) {
    const list = box?.list || [];
    const i = list.findIndex((m) => m.id === id);
    const node = listEl.querySelector(`.msg[data-id="${id}"]`);
    if (i < 0 || !node) return;
    const fresh = el(messageHtml(list[i], list[i - 1]));
    node.replaceWith(fresh);
  }

  const atBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  const toBottom = () => { scroller.scrollTop = scroller.scrollHeight; };
  new ResizeObserver(() => { if (stick) toBottom(); }).observe($('.messages-inner', root));

  async function loadInitial(around) {
    if (!has(perms(), P.READ_HISTORY) && server) {
      box = { list: [], hasMore: false };
      renderAll();
      return;
    }
    const rs = state.readStates.get(ch.id);
    firstUnreadId = null;
    if (!box || around) {
      listEl.innerHTML = '';
      topSlot.innerHTML = '<div class="load-more">Loading…</div>';
      try {
        const list = await GET(`/channels/${ch.id}/messages?limit=${PAGE}${around ? `&around=${around}` : ''}`);
        if (destroyed) return;
        list.forEach((m) => cacheUser(m.author));
        box = { list, hasMore: list.length >= (around ? PAGE / 2 : PAGE), hasNewer: !!around };
        if (!around) state.messages.set(ch.id, box);
      } catch (e) { errToast(e); return; }
    }
    if (rs && ch.last_message_id && rs.last_read_id < ch.last_message_id) {
      firstUnreadId = box.list.find((m) => m.id > rs.last_read_id && m.author.id !== state.user.id)?.id || null;
    }
    renderAll();
    if (around) {
      stick = false;
      const node = listEl.querySelector(`.msg[data-id="${around}"]`);
      if (node) { node.scrollIntoView({ block: 'center' }); node.classList.add('highlight'); setTimeout(() => node.classList.remove('highlight'), 2000); }
    } else {
      const div = listEl.querySelector('.new-divider');
      if (div && div.offsetTop < scroller.scrollHeight - scroller.clientHeight * 1.5) { stick = false; scroller.scrollTop = div.offsetTop - 80; }
      else { stick = true; toBottom(); }
    }
    ack();
  }

  async function loadOlder() {
    if (!box?.hasMore || box.loading) return;
    box.loading = true;
    const oldest = box.list[0]?.id;
    try {
      const list = await GET(`/channels/${ch.id}/messages?limit=${PAGE}&before=${oldest}`);
      if (destroyed) return;
      list.forEach((m) => cacheUser(m.author));
      box.list = [...list, ...box.list];
      box.hasMore = list.length >= PAGE;
      const h = scroller.scrollHeight, t = scroller.scrollTop;
      renderAll();
      scroller.scrollTop = scroller.scrollHeight - h + t;
    } catch (e) { errToast(e); } finally { box.loading = false; }
  }

  async function loadNewer() {
    if (!box?.hasNewer || box.loading) return;
    box.loading = true;
    try {
      const list = await GET(`/channels/${ch.id}/messages?limit=${PAGE}&after=${box.list[box.list.length - 1].id}`);
      if (destroyed) return;
      box.list.push(...list);
      if (list.length < PAGE) { box.hasNewer = false; state.messages.set(ch.id, box); }
      renderAll();
    } catch (e) { errToast(e); } finally { box.loading = false; }
  }

  scroller.addEventListener('scroll', () => {
    stick = atBottom();
    if (scroller.scrollTop < 400) loadOlder();
    if (stick) { if (box?.hasNewer) loadNewer(); else ack(); }
  }, { passive: true });

  const ack = debounce(() => {
    if (destroyed || document.visibilityState !== 'visible' || !stick && box?.list.length > 10) return;
    const last = box?.list[box.list.length - 1]?.id || ch.last_message_id;
    const rs = state.readStates.get(ch.id);
    if (!last || (rs && rs.last_read_id >= last && !rs.mention_count)) return;
    state.readStates.set(ch.id, { channel_id: ch.id, last_read_id: last, mention_count: 0 });
    emit('unread');
    POST(`/channels/${ch.id}/ack`, { message_id: last }).catch(() => {});
  }, 300);
  const onVis = () => { if (document.visibilityState === 'visible' && stick) ack(); };
  document.addEventListener('visibilitychange', onVis);

  // Store events.
  unsubs.push(on('message_create', (m) => {
    if (m.channel_id !== ch.id || box?.hasNewer) return;
    if (!box) return;
    const existing = listEl.querySelector(`.msg[data-id="${m.id}"]`) || (m.nonce && listEl.querySelector(`.msg[data-nonce="${m.nonce}"]`));
    const i = box.list.findIndex((x) => x.id === m.id);
    const wasStuck = stick || m.author.id === state.user.id;
    if (existing) { existing.replaceWith(el(messageHtml(box.list[i], box.list[i - 1]))); }
    else {
      const prev = box.list[i - 1];
      if (prev && new Date(prev.created_at).toDateString() !== new Date(m.created_at).toDateString()) listEl.append(el(`<div class="day-divider">${fmtDate(m.created_at)}</div>`));
      listEl.append(el(messageHtml(m, prev)));
    }
    if (wasStuck) { stick = true; toBottom(); }
    ack();
  }));
  unsubs.push(on('message_update', (m) => { if (m.channel_id === ch.id) rerender(m.id); }));
  unsubs.push(on('message_patch', ({ channel_id, message_id }) => { if (channel_id === ch.id) rerender(message_id); }));
  unsubs.push(on('message_delete', ({ id, channel_id }) => {
    if (channel_id !== ch.id) return;
    const node = listEl.querySelector(`.msg[data-id="${id}"]`);
    const next = node?.nextElementSibling?.dataset.id;
    node?.remove();
    if (next) rerender(Number(next));
  }));
  unsubs.push(on('jump', ({ channelId, messageId }) => { if (channelId === ch.id) jumpTo(messageId); }));
  unsubs.push(on('members', (s) => { if (s === sid) renderAll(); }));
  unsubs.push(on('server_update', (s) => { if (s === sid) renderComposer(); }));
  unsubs.push(on('resync', () => { state.messages.delete(ch.id); box = null; loadInitial(); }));

  function jumpTo(id) {
    const node = listEl.querySelector(`.msg[data-id="${id}"]`);
    if (node) {
      stick = false;
      node.scrollIntoView({ block: 'center', behavior: 'smooth' });
      node.classList.add('highlight');
      setTimeout(() => node.classList.remove('highlight'), 2000);
    } else loadInitial(id);
  }

  // Message interactions.
  const msgOf = (node) => box?.list.find((m) => m.id === Number(node.closest('.msg')?.dataset.id));

  listEl.addEventListener('click', async (e) => {
    const t = e.target;
    const u = t.closest('[data-user]');
    if (u && (t.closest('.author') || t.closest('.avatar-wrap') || t.closest('.mention') || t.closest('.who'))) {
      return openProfile(Number(u.dataset.user), u, { serverId: sid });
    }
    const chm = t.closest('[data-channel]');
    if (chm) {
      const target = Number(chm.dataset.channel);
      const s = [...state.servers.values()].find((x) => x.channels.some((c) => c.id === target));
      if (s) navigate(channelPath(s.id, target));
      return;
    }
    const sp = t.closest('.spoiler');
    if (sp) return sp.classList.add('shown');
    const spm = t.closest('[data-spoiler].hidden-spoiler');
    if (spm) { e.preventDefault(); return spm.classList.remove('hidden-spoiler'); }
    const img = t.closest('.att-img');
    if (img) return lightbox(img.src, 'image', img.alt);
    const jump = t.closest('[data-jump]');
    if (jump) { e.preventDefault(); return jumpTo(Number(jump.dataset.jump)); }
    if (t.closest('[data-allpins]')) { e.preventDefault(); return import('./panels.js').then((mm) => mm.openPins(ch)); }
    if (t.closest('[data-showblocked]')) {
      e.preventDefault();
      const m = msgOf(t);
      const node = t.closest('.msg');
      const prevBlocked = state.relationships.get(m.author.id);
      state.relationships.delete(m.author.id);
      node.replaceWith(el(messageHtml(m, null)));
      state.relationships.set(m.author.id, prevBlocked);
      return;
    }
    const m = msgOf(t);
    if (!m) return;
    const r = t.closest('[data-react]');
    if (r) return toggleReaction(m, r.dataset.react);
    const q = t.closest('[data-quick]');
    if (q) return toggleReaction(m, q.dataset.quick);
    if (t.closest('[data-addreact]')) {
      return openPicker(t.closest('[data-addreact]'), (p) => toggleReaction(m, p.type === 'custom' ? `c:${p.emoji.id}` : p.value, true), { serverId: sid });
    }
    if (t.closest('[data-reply]')) return startReply(m);
    if (t.closest('[data-edit]')) return startEdit(m);
    if (t.closest('[data-more]')) return messageMenu(m, t.closest('[data-more]'));
    const opt = t.closest('[data-opt]');
    if (opt) return vote(m, Number(opt.dataset.opt));
    if (t.closest('[data-unvote]')) return PUT(`/channels/${ch.id}/messages/${m.id}/poll`, { answers: [] }).catch(errToast);
    if (t.closest('[data-endpoll]')) {
      if (await confirmDialog({ title: 'End Poll Now?', text: 'This will end the poll for everyone and show the final results.', confirm: 'End Poll' })) {
        POST(`/channels/${ch.id}/messages/${m.id}/poll/end`).catch(errToast);
      }
    }
  });

  listEl.addEventListener('contextmenu', (e) => {
    const u = e.target.closest('.author, .avatar-wrap, .mention[data-user]');
    if (u) { e.preventDefault(); return userMenu(Number(u.dataset.user || u.closest('[data-user]').dataset.user), { x: e.clientX, y: e.clientY }, { serverId: sid }); }
    if (e.target.closest('a, .att-img, video, audio')) return;
    const m = msgOf(e.target);
    if (m && m.type !== 'system') { e.preventDefault(); messageMenu(m, { x: e.clientX, y: e.clientY }); }
  });

  // Long-press opens the message menu on touch devices.
  let pressTimer;
  listEl.addEventListener('touchstart', (e) => {
    const m = msgOf(e.target);
    if (!m || m.type === 'system' || e.target.closest('button, a, img, video, .poll')) return;
    const t = e.touches[0];
    pressTimer = setTimeout(() => { navigator.vibrate?.(10); messageMenu(m, { x: t.clientX, y: t.clientY }); }, 450);
  }, { passive: true });
  ['touchend', 'touchmove', 'touchcancel'].forEach((ev) => listEl.addEventListener(ev, () => clearTimeout(pressTimer), { passive: true }));

  async function toggleReaction(m, emoji, forceAdd = false) {
    const mine = m.reactions.find((r) => r.emoji === emoji)?.users.includes(state.user.id);
    const path = `/channels/${ch.id}/messages/${m.id}/reactions/${encodeURIComponent(emoji)}`;
    try {
      if (mine && !forceAdd) await DEL(path);
      else if (!mine) await PUT(path);
    } catch (e) { errToast(e); }
  }

  async function vote(m, i) {
    const p = m.poll;
    const mineNow = p.votes.map((v, idx) => (v.includes(state.user.id) ? idx : -1)).filter((x) => x >= 0);
    let answers;
    if (p.multi) answers = mineNow.includes(i) ? mineNow.filter((x) => x !== i) : [...mineNow, i];
    else answers = mineNow.includes(i) ? [] : [i];
    try { await PUT(`/channels/${ch.id}/messages/${m.id}/poll`, { answers }); } catch (e) { errToast(e); }
  }

  function messageMenu(m, at) {
    const node = listEl.querySelector(`.msg[data-id="${m.id}"]`);
    node?.classList.add('menu-open');
    const mine = m.author.id === state.user.id;
    const canManage = sid ? has(perms(), P.MANAGE_MESSAGES) : true;
    const quick = ['👍', '😂', '❤️', '🔥', '😮', '😢'];
    const root = menu([
      has(perms(), P.ADD_REACTIONS) ? { html: `<span style="display:flex;gap:4px">${quick.map((q) => `<span data-q="${q}" style="cursor:pointer">${emojiHtml(q)}</span>`).join('')}</span>`, action: () => {} } : null,
      { label: 'Add Reaction', icon: 'smilePlus', hidden: !has(perms(), P.ADD_REACTIONS), action: () => openPicker(at instanceof Element ? at : { x: at.x, y: at.y }, (p) => toggleReaction(m, p.type === 'custom' ? `c:${p.emoji.id}` : p.value, true), { serverId: sid }) },
      { label: 'Edit Message', icon: 'edit', hidden: !mine || m.type === 'poll', action: () => startEdit(m) },
      { label: 'Reply', icon: 'reply', hidden: !has(perms(), P.SEND_MESSAGES), action: () => startReply(m) },
      { label: 'Copy Text', icon: 'copy', hidden: !m.content || m.type === 'poll', action: () => copyText(m.content) },
      { label: m.pinned ? 'Unpin Message' : 'Pin Message', icon: 'pin', hidden: !canManage, action: () => (m.pinned ? DEL : PUT)(`/channels/${ch.id}/pins/${m.id}`).catch(errToast) },
      { label: 'Mark Unread', icon: 'eye', action: () => POST(`/channels/${ch.id}/unread`, { message_id: m.id }).then(() => { firstUnreadId = m.id; renderAll(); }).catch(errToast) },
      { label: 'Copy Message Link', icon: 'link', action: () => copyText(`${location.origin}${channelPath(sid || '@me', ch.id)}?m=${m.id}`) },
      { sep: true },
      { label: 'Delete Message', icon: 'trash', danger: true, hidden: !mine && !canManage, action: () => deleteMessage(m) },
      { label: 'Copy Message ID', icon: 'copy', action: () => copyText(String(m.id)) },
    ], at);
    root.querySelectorAll('[data-q]').forEach((q) => q.addEventListener('click', () => toggleReaction(m, q.dataset.q, true)));
    const obs = new MutationObserver(() => { if (!root.isConnected) { node?.classList.remove('menu-open'); obs.disconnect(); } });
    obs.observe(document.getElementById('layers'), { childList: true });
  }

  async function deleteMessage(m, skipConfirm = false) {
    if (!skipConfirm && !(await confirmDialog({ title: 'Delete Message', text: 'Are you sure you want to delete this message?<br><span class="tiny faint">Tip: hold Shift when clicking delete to skip this.</span>', confirm: 'Delete', danger: true }))) return;
    try { await DEL(`/channels/${ch.id}/messages/${m.id}`); } catch (e) { errToast(e); }
  }

  function startEdit(m) {
    const node = listEl.querySelector(`.msg[data-id="${m.id}"]`);
    if (!node) return;
    const content = node.querySelector('.content');
    const boxEl = el(`<div class="edit-box"><textarea rows="1"></textarea><div class="hint">escape to <button data-cancel>cancel</button> • enter to <button data-save>save</button></div></div>`);
    const ta = boxEl.querySelector('textarea');
    ta.value = m.content;
    content.replaceWith(boxEl);
    const grow = () => { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight}px`; };
    grow();
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    const done = () => rerender(m.id);
    const save = async () => {
      const v = ta.value;
      if (v === m.content) return done();
      if (!v.trim() && !m.attachments.length) { done(); return deleteMessage(m); }
      try { await PATCH(`/channels/${ch.id}/messages/${m.id}`, { content: v }); } catch (e) { errToast(e); }
      done();
    };
    ta.oninput = grow;
    ta.onkeydown = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(); }
      else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
    };
    boxEl.querySelector('[data-cancel]').onclick = done;
    boxEl.querySelector('[data-save]').onclick = save;
  }

  // ---------- Composer ----------
  let reply = null;
  let files = []; // { file, spoiler, url }
  let lastTyping = 0;
  let ta;

  function startReply(m) {
    reply = m;
    renderComposer();
    ta?.focus();
  }

  function renderComposer() {
    const p = perms();
    const canSend = has(p, P.SEND_MESSAGES) && !(ch.type === 'announcement' && !has(p, P.MANAGE_MESSAGES));
    const blocked = ch.type === 'dm' && other && state.relationships.get(other.id)?.type === 'blocked';
    const me = server?.me;
    const timedOut = me?.timeout_until && me.timeout_until > Date.now();
    if (!canSend || blocked || timedOut) {
      composerWrap.innerHTML = `<div class="typing"></div><div class="composer-disabled">${timedOut ? `You're timed out. You can send messages again in ${fmtDuration(me.timeout_until - Date.now())}.` : blocked ? 'You blocked this user. Unblock them to send messages.' : 'You do not have permission to send messages in this channel.'}</div>`;
      ta = null;
      renderTyping();
      return;
    }
    const prevValue = ta ? ta.value : drafts.get(ch.id) || '';
    const placeholder = isDM ? `Message @${title}` : `Message #${ch.name}`;
    composerWrap.innerHTML = `
      <div class="typing"></div>
      <div class="composer">
        ${reply ? `<div class="bar-top"><span class="grow">Replying to <b>${esc(displayName(reply.author.id, sid))}</b></span>
          ${reply.author.id !== state.user.id ? `<button class="ping ${replyPing ? '' : 'off'}" data-ping title="Toggle mention">@${replyPing ? 'ON' : 'OFF'}</button>` : ''}
          <button class="icon-btn" data-cancelreply title="Cancel reply" style="width:22px;height:22px">${icon('x')}</button></div>` : ''}
        ${files.length ? `<div class="uploads">${files.map((f, i) => `<div class="upload-card">
          <div class="thumb">${f.file.type.startsWith('image/') ? `<img src="${f.url}" alt="">` : f.file.type.startsWith('video/') ? `<video src="${f.url}" muted></video>` : icon('file')}</div>
          <div class="fn">${esc(f.file.name)}</div>
          <button class="sp ${f.spoiler ? 'on' : ''}" data-spoil="${i}" title="Mark as spoiler">SPOILER</button>
          <button class="rm" data-rmfile="${i}" title="Remove">${icon('trash')}</button></div>`).join('')}</div>` : ''}
        <div class="row-main">
          ${has(p, P.ATTACH_FILES) ? `<button class="icon-btn" data-attach title="Upload a file">${icon('plusCircle')}</button>` : ''}
          <textarea rows="1" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}" maxlength="4000" enterkeyhint="send"></textarea>
          ${has(p, P.CREATE_POLLS) ? `<button class="icon-btn" data-poll title="Create Poll">${icon('poll')}</button>` : ''}
          <button class="icon-btn" data-emoji title="Emoji">${icon('smile')}</button>
          <button class="icon-btn send" data-send title="Send" ${isMobile() ? '' : 'hidden'}>${icon('send')}</button>
        </div>
      </div>
      ${ch.slowmode ? `<div class="slowmode-tag">${icon('timer')} Slowmode is enabled (${fmtDuration(ch.slowmode * 1000)}).</div>` : ''}
      <input type="file" multiple hidden data-file>`;
    ta = $('textarea', composerWrap);
    ta.value = prevValue;
    autosize();
    bindComposer();
    renderTyping();
  }

  function autosize() {
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, innerHeight * 0.5)}px`;
  }

  function bindComposer() {
    const fileInput = $('[data-file]', composerWrap);
    composerWrap.onclick = (e) => {
      if (e.target.closest('[data-attach]')) return fileInput.click();
      if (e.target.closest('[data-cancelreply]')) { reply = null; return renderComposer(); }
      if (e.target.closest('[data-ping]')) { replyPing = !replyPing; return renderComposer(); }
      const rm = e.target.closest('[data-rmfile]');
      if (rm) { URL.revokeObjectURL(files[Number(rm.dataset.rmfile)].url); files.splice(Number(rm.dataset.rmfile), 1); return renderComposer(); }
      const sp = e.target.closest('[data-spoil]');
      if (sp) { files[Number(sp.dataset.spoil)].spoiler ^= 1; return renderComposer(); }
      if (e.target.closest('[data-emoji]')) {
        return openPicker(e.target.closest('[data-emoji]'), (pk) => insert(pk.type === 'custom' ? `<${pk.emoji.animated ? 'a' : ''}:${pk.emoji.name}:${pk.emoji.id}> ` : pk.value), { keepOpen: !isMobile(), serverId: sid });
      }
      if (e.target.closest('[data-poll]')) return openPollComposer(ch);
      if (e.target.closest('[data-send]')) { send(); ta.focus(); }
    };
    fileInput.onchange = () => { addFiles([...fileInput.files]); fileInput.value = ''; };
    ta.addEventListener('input', () => {
      autosize();
      drafts.set(ch.id, ta.value);
      if (ta.value && Date.now() - lastTyping > 8000) { lastTyping = Date.now(); sendTyping(ch.id); }
      updateAutocomplete();
    });
    ta.addEventListener('keydown', (e) => {
      if (ac && handleAcKey(e)) return;
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !(isMobile() && matchMedia('(hover: none)').matches)) {
        e.preventDefault();
        send();
      } else if (e.key === 'ArrowUp' && !ta.value) {
        const mine = [...(box?.list || [])].reverse().find((m) => m.author.id === state.user.id && m.type !== 'system' && m.type !== 'poll');
        if (mine) { e.preventDefault(); startEdit(mine); }
      } else if (e.key === 'Escape' && reply) { reply = null; renderComposer(); ta.focus(); }
    });
    ta.addEventListener('paste', (e) => {
      const fs = [...(e.clipboardData?.files || [])];
      if (fs.length && has(perms(), P.ATTACH_FILES)) { e.preventDefault(); addFiles(fs); }
    });
    ta.addEventListener('blur', () => setTimeout(closeAc, 150));
  }

  function insert(text) {
    if (!ta) return;
    const s = ta.selectionStart ?? ta.value.length, e2 = ta.selectionEnd ?? ta.value.length;
    ta.value = ta.value.slice(0, s) + text + ta.value.slice(e2);
    ta.selectionStart = ta.selectionEnd = s + text.length;
    drafts.set(ch.id, ta.value);
    autosize();
    if (!isMobile()) ta.focus();
  }

  function addFiles(list) {
    const max = state.limits.upload || 50 * 1024 * 1024;
    for (const f of list) {
      if (files.length >= 10) { toast('You can upload up to 10 files at a time.', 'error'); break; }
      if (f.size > max) { toast(`${f.name} is too big (max ${fmtBytes(max)}).`, 'error'); continue; }
      files.push({ file: f, spoiler: false, url: URL.createObjectURL(f) });
    }
    renderComposer();
    ta?.focus();
  }

  async function send() {
    if (!ta) return;
    let content = ta.value;
    if (!content.trim() && !files.length) return;
    content = resolveMentions(content);
    // Slash-style shortcuts.
    if (/^\/shrug\b/.test(content)) content = `${content.replace(/^\/shrug\s*/, '')} ¯\\\\_(ツ)_/¯`.trim();
    else if (/^\/tableflip\b/.test(content)) content = `${content.replace(/^\/tableflip\s*/, '')} (╯°□°)╯︵ ┻━┻`.trim();
    else if (/^\/unflip\b/.test(content)) content = `${content.replace(/^\/unflip\s*/, '')} ┬─┬ノ( º _ ºノ)`.trim();
    else if (/^\/spoiler\s+/.test(content)) content = `||${content.replace(/^\/spoiler\s+/, '')}||`;
    else if (/^\/me\s+/.test(content)) content = `_${content.replace(/^\/me\s+/, '')}_`;
    const nonce = `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
    const form = new FormData();
    form.append('content', content);
    form.append('nonce', nonce);
    if (reply) { form.append('reply_to', String(reply.id)); form.append('mention_reply', String(replyPing)); }
    for (const f of files) form.append('files', f.file, f.spoiler && !f.file.name.startsWith('SPOILER_') ? `SPOILER_${f.file.name}` : f.file.name);
    const pending = {
      id: Number.MAX_SAFE_INTEGER - Math.floor(Math.random() * 1e6), nonce, pending: true, channel_id: ch.id, author: state.user, type: 'default',
      content, attachments: [], reply: reply ? { id: reply.id, author: reply.author, content: reply.content } : null, mentions: [], mention_roles: [],
      mention_everyone: false, pinned: false, edited_at: null, created_at: Date.now(), reactions: [], poll: null,
    };
    const hadFiles = files.length;
    files.forEach((f) => URL.revokeObjectURL(f.url));
    files = [];
    reply = null;
    ta.value = '';
    drafts.delete(ch.id);
    lastTyping = 0;
    renderComposer();
    if (!hadFiles && box && !box.hasNewer) {
      box.list.push(pending);
      const node = el(messageHtml(pending, box.list[box.list.length - 2]));
      node.dataset.nonce = nonce;
      listEl.append(node);
      stick = true; toBottom();
    }
    try {
      const msg = await upload(`/channels/${ch.id}/messages`, form, hadFiles ? (p) => showProgress(p) : null);
      showProgress(null);
      if (box) {
        const i = box.list.findIndex((m) => m.nonce === nonce);
        if (i >= 0) {
          const already = box.list.some((m) => m.id === msg.id);
          if (already) { box.list.splice(i, 1); listEl.querySelector(`[data-nonce="${nonce}"]`)?.remove(); }
          else { box.list[i] = msg; const n = listEl.querySelector(`[data-nonce="${nonce}"]`); n?.replaceWith(el(messageHtml(msg, box.list[i - 1]))); }
        }
      }
    } catch (e) {
      showProgress(null);
      const i = box?.list.findIndex((m) => m.nonce === nonce) ?? -1;
      if (i >= 0) { box.list.splice(i, 1); listEl.querySelector(`[data-nonce="${nonce}"]`)?.remove(); }
      if (ta && !ta.value) { ta.value = content; autosize(); }
      errToast(e);
    }
  }

  function showProgress(p) {
    const t = $('.typing', composerWrap);
    if (!t) return;
    if (p == null) return renderTyping();
    t.innerHTML = `Uploading… ${Math.round(p * 100)}%`;
  }

  // Turn "@name" into <@id>, "#channel" into <#id>, ":emoji:" into custom emoji tags.
  function resolveMentions(text) {
    const members = sid ? [...(state.members.get(sid)?.values() || [])].map((m) => m.user) : [state.user, ...(ch.recipients || [])];
    text = text.replace(/(^|\s)@([a-z0-9_.]{2,32})\b/gi, (m, pre, name) => {
      if (/^(everyone|here)$/i.test(name)) return m;
      const u = members.find((x) => x.username.toLowerCase() === name.toLowerCase());
      if (u) return `${pre}<@${u.id}>`;
      const role = server?.roles.find((r) => !r.is_default && r.name.toLowerCase() === name.toLowerCase());
      return role ? `${pre}<@&${role.id}>` : m;
    });
    if (server) text = text.replace(/(^|\s)#([\w-]{1,100})/g, (m, pre, name) => {
      const c = server.channels.find((x) => x.type !== 'category' && x.name === name);
      return c ? `${pre}<#${c.id}>` : m;
    });
    text = text.replace(/(^|[^<a\w]):(\w{2,32}):/g, (m, pre, name) => {
      for (const s of [server, ...state.servers.values()].filter(Boolean)) {
        const e = s.emojis.find((x) => x.name === name);
        if (e) return `${pre}<${e.animated ? 'a' : ''}:${e.name}:${e.id}>`;
      }
      const u = emojiByCode(name.toLowerCase());
      return u ? `${pre}${withTone(u)}` : m;
    });
    return text;
  }

  // ---------- Autocomplete ----------
  let ac = null; // { el, items, sel, start, kind }
  function closeAc() { ac?.el.remove(); ac = null; }
  async function updateAutocomplete() {
    if (!ta) return;
    const pos = ta.selectionStart;
    const before = ta.value.slice(0, pos);
    let m;
    let items = [];
    let kind, start, title;
    if ((m = /(^|\s)@([\w.]{0,32})$/.exec(before))) {
      kind = 'user'; start = pos - m[2].length - 1; title = 'Members';
      const q = m[2].toLowerCase();
      const members = sid ? [...(state.members.get(sid)?.values() || [])].map((x) => x.user) : [state.user, ...(ch.recipients || [])];
      items = members.filter((u) => u.username.includes(q) || displayName(u.id, sid).toLowerCase().includes(q)).slice(0, 8)
        .map((u) => ({ html: `${avatarHtml(getUser(u.id) || u, { size: 's24' })}<span>${esc(displayName(u.id, sid))}</span><span class="sub">${esc(u.username)}</span>`, value: `@${u.username} ` }));
      if (server) {
        items.push(...server.roles.filter((r) => !r.is_default && (r.mentionable || has(perms(), P.MENTION_EVERYONE)) && r.name.toLowerCase().includes(q)).slice(0, 4)
          .map((r) => ({ html: `<span style="color:${r.color || 'inherit'}">@${esc(r.name)}</span><span class="sub">Role</span>`, value: `<@&${r.id}> ` })));
        if (has(perms(), P.MENTION_EVERYONE)) ['everyone', 'here'].filter((x) => x.startsWith(q)).forEach((x) => items.push({ html: `<span>@${x}</span><span class="sub">${x === 'here' ? 'Notify online members' : 'Notify everyone'}</span>`, value: `@${x} ` }));
      }
    } else if (server && (m = /(^|\s)#([\w-]{0,100})$/.exec(before))) {
      kind = 'channel'; start = pos - m[2].length - 1; title = 'Text Channels';
      items = server.channels.filter((c) => (c.type === 'text' || c.type === 'announcement') && c.name.includes(m[2].toLowerCase())).slice(0, 8)
        .map((c) => ({ html: `${icon('hash')}<span>${esc(c.name)}</span>`, value: `<#${c.id}> ` }));
    } else if ((m = /(^|\s|[^\w:]):([\w+-]{2,32})$/.exec(before))) {
      kind = 'emoji'; start = pos - m[2].length - 1; title = `Emoji matching :${m[2]}`;
      await loadEmoji();
      const q = m[2].toLowerCase();
      for (const s of [server, ...state.servers.values()].filter(Boolean)) {
        for (const e of s.emojis) if (e.name.toLowerCase().includes(q) && items.length < 5 && !items.some((x) => x.id === e.id)) items.push({ id: e.id, html: `${customEmojiHtml(e)}<span>:${esc(e.name)}:</span><span class="sub">${esc(s.name)}</span>`, value: `<${e.animated ? 'a' : ''}:${e.name}:${e.id}> ` });
      }
      for (const e of emojiList()) {
        if (items.length >= 10) break;
        const code = e.s.find((s) => s.startsWith(q)) || (e.s.find((s) => s.includes(q)));
        if (code) items.push({ html: `${emojiHtml(withTone(e))}<span>:${esc(code)}:</span>`, value: withTone(e) });
      }
    }
    if (!items.length) return closeAc();
    if (!ac) {
      ac = { el: el('<div class="autocomplete" role="listbox"></div>') };
      composerWrap.append(ac.el);
      ac.el.addEventListener('mousedown', (e) => {
        const it = e.target.closest('.ac-item');
        if (it) { e.preventDefault(); pickAc(Number(it.dataset.i)); }
      });
    }
    Object.assign(ac, { items, sel: 0, start, kind });
    ac.el.innerHTML = `<div class="ac-title">${esc(title)}</div>${items.map((it, i) => `<div class="ac-item ${i === 0 ? 'sel' : ''}" data-i="${i}">${it.html}</div>`).join('')}`;
  }
  function pickAc(i) {
    const it = ac.items[i];
    const pos = ta.selectionStart;
    ta.value = ta.value.slice(0, ac.start) + it.value + ta.value.slice(pos);
    ta.selectionStart = ta.selectionEnd = ac.start + it.value.length;
    drafts.set(ch.id, ta.value);
    closeAc();
    autosize();
    ta.focus();
  }
  function handleAcKey(e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      ac.sel = (ac.sel + (e.key === 'ArrowDown' ? 1 : -1) + ac.items.length) % ac.items.length;
      $$('.ac-item', ac.el).forEach((n, i) => n.classList.toggle('sel', i === ac.sel));
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickAc(ac.sel); return true; }
    if (e.key === 'Escape') { e.preventDefault(); closeAc(); return true; }
    return false;
  }

  // ---------- Typing indicator ----------
  function renderTyping() {
    const t = $('.typing', composerWrap);
    if (!t) return;
    const ids = [...(state.typing.get(ch.id)?.keys() || [])].filter((id) => id !== state.user.id && state.relationships.get(id)?.type !== 'blocked');
    if (!ids.length) { t.innerHTML = ''; return; }
    const names = ids.map((id) => `<b>${esc(displayName(id, sid))}</b>`);
    const text = names.length === 1 ? `${names[0]} is typing…` : names.length <= 3 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)} are typing…` : 'Several people are typing…';
    t.innerHTML = `<span class="dots"><i></i><i></i><i></i></span><span>${text}</span>`;
  }
  unsubs.push(on('typing', (cid) => { if (cid === ch.id) renderTyping(); }));

  // ---------- Drag & drop upload ----------
  let dragDepth = 0;
  root.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types.includes('Files') || !has(perms(), P.ATTACH_FILES)) return;
    dragDepth++;
    if (!root.querySelector('.drop-overlay')) root.append(el(`<div class="drop-overlay">Drop to upload to ${esc(isDM ? title : `#${ch.name}`)}</div>`));
  });
  root.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; root.querySelector('.drop-overlay')?.remove(); } });
  root.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
  root.addEventListener('drop', (e) => {
    dragDepth = 0;
    root.querySelector('.drop-overlay')?.remove();
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    addFiles([...e.dataTransfer.files]);
  });

  // Typing anywhere focuses the composer.
  const keyFocus = (e) => {
    if (!ta || e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
    const a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return;
    if (document.getElementById('layers').children.length) return;
    ta.focus();
  };
  document.addEventListener('keydown', keyFocus);

  renderComposer();
  const params = new URLSearchParams(location.search);
  const target = Number(params.get('m')) || null;
  if (params.get('share_text') || params.get('share_url')) {
    insert([params.get('share_text'), params.get('share_url')].filter(Boolean).join(' '));
  }
  if (params.get('call') === '1' && isDM) voice.join(ch.id);
  if (location.search) history.replaceState({}, '', location.pathname);
  loadInitial(target);
  if (!isMobile()) setTimeout(() => ta?.focus(), 50);

  return {
    destroy() {
      destroyed = true;
      unsubs.forEach((u) => u());
      voiceView?.destroy();
      document.removeEventListener('visibilitychange', onVis);
      document.removeEventListener('keydown', keyFocus);
      if (ta) drafts.set(ch.id, ta.value);
      if (box?.hasNewer) state.messages.delete(ch.id);
      files.forEach((f) => URL.revokeObjectURL(f.url));
    },
  };
}
