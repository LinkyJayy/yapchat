// Server info: public member counter, rating summary and reviews.
import { $, esc, errToast, toast, fmtDate } from '../dom.js';
import { icon } from '../icons.js';
import { state, on, P, has, serverCounts, cacheUser } from '../store.js';
import { GET, PUT, DEL } from '../api.js';
import { modal, confirmDialog } from './layers.js';
import { avatarHtml, serverIconHtml } from './components.js';
import { emojify } from '../emoji.js';

export const starsHtml = (n, cls = '') => `<span class="stars ${cls}" aria-label="${n} out of 5 stars">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= Math.round(n) ? 'on' : ''}">★</i>`).join('')}</span>`;

export function counterHtml(c) {
  return `<div class="counter-cards">
    <div class="counter-card"><b>${c.online ?? '–'}</b><span><i class="dot online"></i>Online</span></div>
    <div class="counter-card"><b>${c.total}</b><span><i class="dot"></i>Members</span></div>
    <div class="counter-card"><b>${c.voice}</b><span>${icon('volume')}In Voice</span></div></div>`;
}

export function ratingSummaryHtml(r) {
  if (!r?.count) return '<div class="muted small">No reviews yet.</div>';
  const max = Math.max(...r.distribution, 1);
  return `<div class="rating-summary"><div class="big"><b>${r.average}</b>${starsHtml(r.average)}<span class="muted small">${r.count} review${r.count === 1 ? '' : 's'}</span></div>
    <div class="bars">${[5, 4, 3, 2, 1].map((n) => `<div class="bar-row"><span>${n}★</span><div class="bar"><i style="width:${(r.distribution[n - 1] / max) * 100}%"></i></div><span class="muted">${r.distribution[n - 1]}</span></div>`).join('')}</div></div>`;
}

export function reviewHtml(rv, { canDelete = false } = {}) {
  cacheUser(rv.user);
  return `<div class="review" data-uid="${rv.user.id}">${avatarHtml(rv.user)}
    <div class="grow"><div class="row" style="gap:8px"><b>${esc(rv.user.display_name || rv.user.username)}</b>${starsHtml(rv.rating, 'small')}
      <span class="faint tiny">${fmtDate(rv.updated_at)}${rv.updated_at !== rv.created_at ? ' (edited)' : ''}</span>
      ${canDelete ? `<button class="icon-btn danger" data-delreview="${rv.user.id}" title="Remove review" style="margin-left:auto;width:24px;height:24px">${icon('trash')}</button>` : ''}</div>
      ${rv.content ? `<div class="review-text">${emojify(esc(rv.content))}</div>` : ''}</div></div>`;
}

export async function openServerInfo(serverId) {
  const S = () => state.servers.get(serverId);
  const s0 = S();
  if (!s0) return;
  const isOwner = s0.owner_id === state.user.id;
  const m = modal({ title: s0.name, wide: true, body: '<div class="muted">Loading…</div>' });
  let data = { rating: s0.rating, reviews: [] };
  let mine = null;
  let pick = 0;

  const draw = () => {
    const s = S();
    if (!s) return m.close();
    const canModerate = has(s.permissions, P.MANAGE_SERVER);
    mine = data.reviews.find((r) => r.user.id === state.user.id) || null;
    if (!pick) pick = mine?.rating || 0;
    m.body.innerHTML = `
      <div class="server-hero" ${s.banner ? `style="background-image:linear-gradient(transparent,var(--bg-modal)),url('${esc(s.banner)}')"` : ''}>
        <div class="hero-icon">${serverIconHtml(s)}</div>
        <div><div class="hero-name">${esc(s.name)}</div>${s.description ? `<div class="muted small">${emojify(esc(s.description))}</div>` : ''}
        <div class="faint tiny">Created ${fmtDate(s.created_at)}</div></div></div>
      <div data-counter>${counterHtml(serverCounts(s))}</div>
      <h3 style="margin:20px 0 10px">Reviews</h3>
      ${ratingSummaryHtml(data.rating)}
      ${isOwner ? '<p class="muted small">You own this server, so you can\'t review it — but you can remove reviews that break the rules.</p>' : `
      <div class="review-form">
        <div class="label">${mine ? 'Your review' : 'Leave a review'}</div>
        <div class="star-pick" role="radiogroup" aria-label="Rating">${[1, 2, 3, 4, 5].map((i) => `<button type="button" data-star="${i}" class="${i <= pick ? 'on' : ''}" aria-label="${i} star${i > 1 ? 's' : ''}">★</button>`).join('')}</div>
        <textarea class="input" data-text maxlength="1000" rows="3" placeholder="What do you like about this server? (optional)">${esc(mine?.content || '')}</textarea>
        <div class="row" style="margin-top:8px"><button class="btn small" data-save>${mine ? 'Update Review' : 'Post Review'}</button>
          ${mine ? '<button class="btn small secondary" data-delmine>Delete</button>' : ''}</div></div>`}
      <div class="reviews">${data.reviews.map((rv) => reviewHtml(rv, { canDelete: rv.user.id === state.user.id || canModerate })).join('')}</div>`;
  };

  const load = async () => {
    try { data = await GET(`/servers/${serverId}/reviews`); draw(); } catch (e) { errToast(e); }
  };

  m.body.addEventListener('click', async (e) => {
    const st = e.target.closest('[data-star]');
    if (st) {
      pick = Number(st.dataset.star);
      m.body.querySelectorAll('[data-star]').forEach((b) => b.classList.toggle('on', Number(b.dataset.star) <= pick));
      return;
    }
    if (e.target.closest('[data-save]')) {
      if (!pick) return toast('Pick a star rating first.', 'error');
      try { await PUT(`/servers/${serverId}/reviews/@me`, { rating: pick, content: $('[data-text]', m.body).value }); toast('Thanks for your review! ⭐', 'ok'); load(); } catch (err) { errToast(err); }
      return;
    }
    const del = e.target.closest('[data-delreview], [data-delmine]');
    if (del) {
      const uid = del.dataset.delreview ? Number(del.dataset.delreview) : state.user.id;
      if (!(await confirmDialog({ title: 'Delete Review', text: 'Remove this review?', confirm: 'Delete', danger: true }))) return;
      try { await DEL(`/servers/${serverId}/reviews/${uid === state.user.id ? '@me' : uid}`); if (uid === state.user.id) pick = 0; load(); } catch (err) { errToast(err); }
    }
  });

  // Keep the live counter up to date while open.
  const drawCounter = () => { const c = m.body.querySelector('[data-counter]'); if (c && S()) c.innerHTML = counterHtml(serverCounts(S())); };
  const offs = [on('presence', drawCounter), on('members', drawCounter), on('voice_changed', drawCounter), on('reviews', (id) => { if (id === serverId) load(); })];
  const obs = new MutationObserver(() => { if (!m.root.isConnected) { offs.forEach((o) => o()); obs.disconnect(); } });
  obs.observe(document.getElementById('layers'), { childList: true });
  import('./app.js').then((a) => a.loadMembers(serverId).catch(() => {}));
  load();
}
