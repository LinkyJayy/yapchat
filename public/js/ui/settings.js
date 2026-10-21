// User settings (full screen) + custom status.
import { $, $$, el, esc, toast, errToast, fmtStamp, isMobile } from '../dom.js';
import { icon } from '../icons.js';
import { state, emit } from '../store.js';
import { GET, PATCH, DEL, api, token } from '../api.js';
import { avatarHtml, imagePickerHtml, bindImagePicker, customStatusHtml } from './components.js';
import { layer, modal, confirmDialog } from './layers.js';
import { openPicker } from './picker.js';
import { anyEmojiHtml } from '../emoji.js';
import { renderMarkdown } from '../markdown.js';
import * as notifications from '../notifications.js';
import * as voice from './voice.js';
import { applyAppearance } from '../appearance.js';

const SECTIONS = [
  ['h', 'User Settings'], ['account', 'My Account'], ['profile', 'Profile'], ['devices', 'Devices'],
  ['h', 'App Settings'], ['appearance', 'Appearance'], ['notifications', 'Notifications'], ['voice', 'Voice & Video'], ['about', 'About Yapper'],
];

export function openSettings(initial) {
  let section = initial || 'account';
  const root = el(`<div class="settings" role="dialog" aria-label="User Settings">
    <nav class="s-nav"><div>${SECTIONS.map(([k, l]) => (k === 'h' ? `<div class="h">${l}</div>` : `<button data-s="${k}">${l}</button>`)).join('')}
      <div class="divider"></div><button class="danger" data-logout>Log Out</button></div></nav>
    <div class="s-body"><div class="inner"></div></div>
    <div class="close-col"><button class="close-btn" title="Close (Esc)">${icon('x')}</button></div>
  </div>`);
  const entry = layer(root, { outsideClose: false });
  const inner = $('.inner', root);
  $('.close-btn', root).onclick = () => entry.close();
  const show = (k) => {
    section = k;
    $$('[data-s]', root).forEach((b) => b.classList.toggle('active', b.dataset.s === k));
    root.classList.add('show-body');
    inner.innerHTML = `<button class="btn ghost small mobile-back" data-back>${icon('back')} Back</button>`;
    const body = el('<div></div>');
    inner.append(body);
    ({ account, profile, devices, appearance, notifications: notifSection, voice: voiceSection, about })[k](body, entry);
  };
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-s]');
    if (b) return show(b.dataset.s);
    if (e.target.closest('[data-back]')) root.classList.remove('show-body');
    if (e.target.closest('[data-logout]')) logout();
  });
  show(section);
  if (isMobile() && !initial) root.classList.remove('show-body');
}

export async function logout() {
  if (!(await confirmDialog({ title: 'Log Out', text: 'Are you sure you want to log out?', confirm: 'Log Out', danger: true }))) return;
  const endpoint = await notifications.currentEndpoint();
  try { await api('POST', '/auth/logout', { endpoint }); } catch { /* ignore */ }
  await notifications.unsubscribe();
  token.clear();
  location.href = '/login';
}

function saveSettings(patch) {
  state.user.settings = { ...(state.user.settings || {}), ...patch };
  applyAppearance();
  return PATCH('/users/@me', { settings: patch }).catch(errToast);
}

// ---------- Sections ----------
function account(body) {
  const u = state.user;
  body.innerHTML = `<h1>My Account</h1>
    <div class="preview-card" style="max-width:none;margin-bottom:24px">
      <div style="height:100px;${u.banner ? `background:url('${esc(u.banner)}') center/cover` : `background:${u.accent_color || 'var(--mint)'}`}"></div>
      <div class="row" style="padding:0 16px 16px;margin-top:-36px;align-items:flex-end">${avatarHtml(u, { size: 's80' })}
        <div class="grow"><div class="bold" style="font-size:1.25rem;color:var(--text-strong)">${esc(u.display_name || u.username)}</div></div>
        <button class="btn small" data-editprofile>Edit User Profile</button></div>
      <div style="padding:0 16px 16px">
        ${[['Display Name', u.display_name || 'Not set', 'display_name'], ['Username', u.username, 'username'], ['Email', u.email || 'Not set', 'email']].map(([l, v, k]) => `
        <div class="list-row" style="background:var(--bg-elev)"><div class="grow"><div class="label">${l}</div><div>${esc(v)}</div></div><button class="btn small secondary" data-change="${k}">Edit</button></div>`).join('')}
      </div></div>
    <h3>Password and Authentication</h3>
    <button class="btn" data-change="password">Change Password</button>
    <div class="divider"></div>
    <h3>Account Removal</h3>
    <p class="muted small">Deleting your account is permanent. Servers you own must be transferred or deleted first.</p>
    <button class="btn outline-danger" data-delete>Delete Account</button>`;
  body.onclick = (e) => {
    if (e.target.closest('[data-editprofile]')) return document.querySelector('[data-s="profile"]').click();
    const c = e.target.closest('[data-change]');
    if (c) return changeField(c.dataset.change, () => account(body));
    if (e.target.closest('[data-delete]')) return deleteAccount();
  };
}

function changeField(kind, done) {
  const u = state.user;
  const needsPw = kind !== 'display_name';
  const fields = {
    display_name: `<div class="field"><label>Display Name</label><input class="input" data-v maxlength="32" value="${esc(u.display_name || '')}" placeholder="${esc(u.username)}"></div>`,
    username: `<div class="field"><label>Username</label><input class="input" data-v maxlength="32" value="${esc(u.username)}" autocapitalize="none"><div class="hint">Letters, numbers, underscores and periods.</div></div>`,
    email: `<div class="field"><label>Email</label><input class="input" data-v type="email" maxlength="200" value="${esc(u.email || '')}"></div>`,
    password: `<div class="field"><label>New Password</label><input class="input" data-v type="password" minlength="8" autocomplete="new-password"></div>
      <div class="field"><label>Confirm New Password</label><input class="input" data-v2 type="password" autocomplete="new-password"></div>`,
  }[kind];
  modal({
    title: { display_name: 'Change your display name', username: 'Change your username', email: 'Change your email', password: 'Update your password' }[kind],
    body: fields + (needsPw ? '<div class="field"><label>Current Password</label><input class="input" data-pw type="password" autocomplete="current-password"></div>' : ''),
    buttons: [{ label: 'Cancel', cls: 'ghost' }, {
      label: 'Done', action: async (m) => {
        const v = $('[data-v]', m.body).value;
        const payload = {};
        if (kind === 'password') {
          if (v !== $('[data-v2]', m.body).value) { errToast(new Error("Passwords don't match.")); return false; }
          payload.new_password = v;
        } else payload[kind] = v;
        if (needsPw) payload.password = $('[data-pw]', m.body).value;
        try {
          state.user = await PATCH('/users/@me', payload);
          emit('self');
          toast('Saved!', 'ok');
          done();
        } catch (e) { errToast(e); return false; }
      },
    }],
  });
}

function deleteAccount() {
  modal({
    title: 'Delete Account',
    subtitle: 'This will permanently delete your account. This cannot be undone.',
    body: '<div class="field"><label>Password</label><input class="input" type="password" data-pw autocomplete="current-password"></div>',
    buttons: [{ label: 'Cancel', cls: 'ghost' }, {
      label: 'Delete Account', cls: 'danger', action: async (m) => {
        try {
          await DEL('/users/@me', { password: $('[data-pw]', m.body).value });
          await notifications.unsubscribe();
          token.clear();
          location.href = '/login';
        } catch (e) { errToast(e); return false; }
      },
    }],
  });
}

function profile(body) {
  const u = state.user;
  body.innerHTML = `<h1>Profile</h1>
    <div class="profile-editor"><div>
      <div class="field"><label>Display Name</label><input class="input" data-f="display_name" maxlength="32" value="${esc(u.display_name || '')}" placeholder="${esc(u.username)}"></div>
      <div class="field"><label>Pronouns</label><input class="input" data-f="pronouns" maxlength="40" value="${esc(u.pronouns || '')}" placeholder="Add your pronouns"></div>
      <div class="field"><label>Avatar</label>${imagePickerHtml('avatar', u.avatar, { label: 'Change Avatar' })}<div class="hint">PNG, JPG, WebP or animated GIF/WebP/APNG — animated avatars are free for everyone!</div></div>
      <div class="field"><label>Profile Banner</label>${imagePickerHtml('banner', u.banner, { banner: true, label: 'Change Banner' })}<div class="hint">Animated banners work too.</div></div>
      <div class="field"><label>Banner Color</label><div class="color-row">
        ${['#00d087', '#00a39a', '#3b82f6', '#8b5cf6', '#ec4899', '#f97316', '#eab308', '#64748b'].map((c) => `<button class="color-swatch ${u.accent_color === c ? 'sel' : ''}" data-color="${c}" style="background:${c}" title="${c}"></button>`).join('')}
        <input type="color" class="input" data-f="accent_color" value="${esc(u.accent_color || '#00d087')}"></div></div>
      <div class="field"><label>About Me</label><textarea class="input" data-f="bio" maxlength="400" rows="4" placeholder="Tell everyone a little about yourself. Markdown and emoji work!">${esc(u.bio || '')}</textarea></div>
      <div class="row"><button class="btn" data-save>Save Changes</button><button class="btn ghost" data-reset>Reset</button></div>
    </div>
    <div><div class="label" style="margin-bottom:8px">Preview</div><div class="preview-card" data-preview></div></div></div>`;
  const av = bindImagePicker(body, 'avatar');
  const bn = bindImagePicker(body, 'banner');
  const preview = $('[data-preview]', body);
  const val = (k) => $(`[data-f="${k}"]`, body).value;
  const draw = () => {
    const avatar = av.file ? URL.createObjectURL(av.file) : av.removed ? null : u.avatar;
    const banner = bn.file ? URL.createObjectURL(bn.file) : bn.removed ? null : u.banner;
    preview.innerHTML = `<div class="profile"><div class="banner" style="${banner ? `background-image:url('${esc(banner)}')` : `background:${val('accent_color')}`}"></div>
      <div class="av">${avatarHtml({ ...u, avatar }, { status: true })}</div>
      <div class="body"><div class="dn">${esc(val('display_name') || u.username)}</div><div class="un">${esc(u.username)}${val('pronouns') ? ` · ${esc(val('pronouns'))}` : ''}</div>
      ${u.custom_status || u.custom_status_emoji ? `<div class="custom-status">${customStatusHtml(u)}</div>` : ''}
      ${val('bio') ? `<div class="card"><h4>About Me</h4><div class="bio content">${renderMarkdown(val('bio'))}</div></div>` : ''}</div></div>`;
  };
  draw();
  body.addEventListener('input', draw);
  body.addEventListener('change', draw);
  body.addEventListener('click', async (e) => {
    const c = e.target.closest('[data-color]');
    if (c) { $('[data-f="accent_color"]', body).value = c.dataset.color; $$('.color-swatch', body).forEach((x) => x.classList.toggle('sel', x === c)); draw(); }
    if (e.target.closest('[data-reset]')) profile(body);
    if (e.target.closest('[data-save]')) {
      const form = new FormData();
      for (const k of ['display_name', 'pronouns', 'bio', 'accent_color']) form.append(k, val(k));
      if (av.file) form.append('avatar', av.file); else if (av.removed) form.append('remove_avatar', 'true');
      if (bn.file) form.append('banner', bn.file); else if (bn.removed) form.append('remove_banner', 'true');
      const btn = e.target.closest('[data-save]');
      btn.disabled = true;
      try {
        state.user = await api('PATCH', '/users/@me', form);
        emit('self');
        toast('Profile saved!', 'ok');
        profile(body);
      } catch (err) { errToast(err); } finally { btn.disabled = false; }
    }
  });
}

async function devices(body) {
  body.innerHTML = '<h1>Devices</h1><p class="muted">These are all the devices that are logged in to your account.</p><div data-list>Loading…</div>';
  const load = async () => {
    try {
      const list = await GET('/auth/sessions');
      $('[data-list]', body).innerHTML = list.map((s) => `<div class="list-row">${icon(/Mobile|Android|iPhone/i.test(s.user_agent) ? 'phone' : 'screen')}
        <div class="grow"><div class="t">${esc(describeUA(s.user_agent))}${s.current ? ' <span class="badge" style="background:var(--mint)">This device</span>' : ''}</div>
        <div class="d">Last active ${fmtStamp(s.last_seen)}</div></div>
        ${s.current ? '' : `<button class="icon-btn danger" data-out="${s.id}" title="Log out">${icon('x')}</button>`}</div>`).join('') +
        (list.length > 1 ? '<button class="btn outline-danger" data-out="others" style="margin-top:12px">Log out of all other devices</button>' : '');
    } catch (e) { errToast(e); }
  };
  body.onclick = async (e) => {
    const o = e.target.closest('[data-out]');
    if (o) { try { await DEL(`/auth/sessions/${o.dataset.out}`); load(); } catch (err) { errToast(err); } }
  };
  load();
}

function describeUA(ua = '') {
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Unknown OS';
  const app = /Yapper\//.test(ua) ? 'Yapper Desktop' : /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${app} · ${os}`;
}

function appearance(body) {
  const s = state.user.settings || {};
  body.innerHTML = `<h1>Appearance</h1>
    <h3>Theme</h3>
    <div class="radio-list" data-theme>${[['dark', 'Dark'], ['light', 'Light'], ['midnight', 'Midnight (AMOLED)'], ['system', 'Sync with device']].map(([v, l]) =>
      `<label class="radio-item"><input type="radio" name="theme" value="${v}" ${(s.theme || 'dark') === v ? 'checked' : ''}>${l}</label>`).join('')}</div>
    <h3>Message Display</h3>
    <div class="radio-list" data-display>${[['cozy', 'Cozy: Modern, beautiful, and easy on your eyes.'], ['compact', 'Compact: Fit more messages on screen at one time.']].map(([v, l]) =>
      `<label class="radio-item"><input type="radio" name="display" value="${v}" ${(s.display || 'cozy') === v ? 'checked' : ''}>${l}</label>`).join('')}</div>
    <h3>Chat Font Scaling</h3>
    <div class="row"><input type="range" min="0.85" max="1.25" step="0.05" value="${s.fontScale || 1}" data-scale style="flex:1;accent-color:var(--mint)"><span data-scalev>${Math.round((s.fontScale || 1) * 100)}%</span></div>
    <h3>Accessibility</h3>
    <div class="toggle-row"><div><div class="t">Reduce motion</div><div class="d">Turn off most animations.</div></div><label class="switch"><input type="checkbox" data-motion ${s.reduceMotion ? 'checked' : ''}><span></span></label></div>`;
  body.onchange = (e) => {
    if (e.target.name === 'theme') saveSettings({ theme: e.target.value });
    if (e.target.name === 'display') saveSettings({ display: e.target.value });
    if (e.target.matches('[data-scale]')) saveSettings({ fontScale: Number(e.target.value) });
    if (e.target.matches('[data-motion]')) saveSettings({ reduceMotion: e.target.checked });
  };
  body.oninput = (e) => {
    if (e.target.matches('[data-scale]')) { $('[data-scalev]', body).textContent = `${Math.round(e.target.value * 100)}%`; document.documentElement.style.setProperty('--font-scale', e.target.value); }
  };
}

async function notifSection(body) {
  const s = state.user.settings || {};
  const support = notifications.support();
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  const subscribed = await notifications.isSubscribed();
  body.innerHTML = `<h1>Notifications</h1>
    <div class="toggle-row"><div><div class="t">Enable notifications on this device</div>
      <div class="d">${perm === 'denied' ? 'Notifications are blocked in your browser settings. Allow them for this site, then come back.' : support.push ? 'Get notified about messages even when Yapper is closed (phone & PC).' : support.notify ? 'Get notified while Yapper is open in the background.' : 'This browser doesn\'t support notifications.'}
      ${support.iosNeedsInstall ? '<br><b>On iPhone/iPad:</b> tap Share → "Add to Home Screen", then open Yapper from your home screen to enable notifications.' : ''}</div></div>
      <label class="switch"><input type="checkbox" data-enable ${subscribed || (perm === 'granted' && !support.push) ? 'checked' : ''} ${perm === 'denied' || !support.notify ? 'disabled' : ''}><span></span></label></div>
    <div class="toggle-row"><div><div class="t">Notification sounds</div><div class="d">Play a sound for new messages and calls.</div></div><label class="switch"><input type="checkbox" data-sounds ${s.sounds !== false ? 'checked' : ''}><span></span></label></div>
    <div class="toggle-row"><div><div class="t">Unread badge</div><div class="d">Show unread mentions on the app icon.</div></div><label class="switch"><input type="checkbox" data-badge ${s.badge !== false ? 'checked' : ''}><span></span></label></div>
    <div class="toggle-row"><div><div class="t">Show message previews</div><div class="d">Include message text in notifications.</div></div><label class="switch"><input type="checkbox" data-preview ${s.previews !== false ? 'checked' : ''}><span></span></label></div>
    <div style="margin-top:16px"><button class="btn secondary" data-test>Send a test notification</button></div>
    <p class="muted small" style="margin-top:16px">Per-server and per-channel settings live in the server and channel right-click (or long-press) menus.</p>`;
  body.onchange = async (e) => {
    if (e.target.matches('[data-enable]')) {
      if (e.target.checked) {
        const ok = await notifications.enable();
        if (!ok) e.target.checked = false; else toast('Notifications enabled!', 'ok');
      } else { await notifications.unsubscribe(); toast('Notifications disabled on this device.'); }
    }
    if (e.target.matches('[data-sounds]')) saveSettings({ sounds: e.target.checked });
    if (e.target.matches('[data-badge]')) { saveSettings({ badge: e.target.checked }); notifications.updateBadge(); }
    if (e.target.matches('[data-preview]')) saveSettings({ previews: e.target.checked });
  };
  body.onclick = (e) => { if (e.target.closest('[data-test]')) notifications.test(); };
}

async function voiceSection(body) {
  const prefs = voice.prefs();
  body.innerHTML = `<h1>Voice & Video</h1><div data-devs>Loading devices…</div>
    <h3>Input Mode</h3>
    <div class="radio-list">${[['voice', 'Voice Activity'], ['ptt', 'Push to Talk (hold the ` key)']].map(([v, l]) => `<label class="radio-item"><input type="radio" name="mode" value="${v}" ${(prefs.mode || 'voice') === v ? 'checked' : ''}>${l}</label>`).join('')}</div>
    <h3>Mic Test</h3><div class="row"><button class="btn secondary" data-mictest>Let's Check</button><div class="grow" style="height:10px;background:var(--bg-elev);border-radius:6px;overflow:hidden"><div data-level style="height:100%;width:0;background:var(--mint);transition:width .05s"></div></div></div>
    <h3>Advanced</h3>
    <div class="toggle-row"><div><div class="t">Echo Cancellation</div></div><label class="switch"><input type="checkbox" data-p="echoCancellation" ${prefs.echoCancellation !== false ? 'checked' : ''}><span></span></label></div>
    <div class="toggle-row"><div><div class="t">Noise Suppression</div></div><label class="switch"><input type="checkbox" data-p="noiseSuppression" ${prefs.noiseSuppression !== false ? 'checked' : ''}><span></span></label></div>
    <div class="toggle-row"><div><div class="t">Automatic Gain Control</div></div><label class="switch"><input type="checkbox" data-p="autoGainControl" ${prefs.autoGainControl !== false ? 'checked' : ''}><span></span></label></div>`;
  const devs = await voice.listDevices();
  const sel = (kind, label, key) => `<div class="field"><label>${label}</label><select class="input" data-dev="${key}"><option value="">Default</option>
    ${devs.filter((d) => d.kind === kind).map((d, i) => `<option value="${esc(d.deviceId)}" ${prefs[key] === d.deviceId ? 'selected' : ''}>${esc(d.label || `${label} ${i + 1}`)}</option>`).join('')}</select></div>`;
  $('[data-devs]', body).innerHTML = `<div class="row wrap" style="align-items:flex-start">
    <div class="grow">${sel('audioinput', 'Input Device', 'inputId')}</div><div class="grow">${sel('audiooutput', 'Output Device', 'outputId')}</div></div>
    ${sel('videoinput', 'Camera', 'videoId')}`;
  body.onchange = (e) => {
    if (e.target.dataset.dev) voice.setPrefs({ [e.target.dataset.dev]: e.target.value });
    if (e.target.dataset.p) voice.setPrefs({ [e.target.dataset.p]: e.target.checked });
    if (e.target.name === 'mode') voice.setPrefs({ mode: e.target.value });
  };
  let stopTest = null;
  body.onclick = async (e) => {
    const b = e.target.closest('[data-mictest]');
    if (!b) return;
    if (stopTest) { stopTest(); stopTest = null; b.textContent = "Let's Check"; return; }
    try {
      stopTest = await voice.micTest((lvl) => { const l = $('[data-level]', body); if (l) l.style.width = `${Math.min(100, lvl * 140)}%`; });
      b.textContent = 'Stop Testing';
    } catch (err) { errToast(err); }
  };
  const obs = new MutationObserver(() => { if (!body.isConnected) { stopTest?.(); obs.disconnect(); } });
  obs.observe(document.getElementById('layers'), { childList: true, subtree: true });
}

function about(body) {
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  body.innerHTML = `<h1>About Yapper</h1>
    <div class="row" style="margin-bottom:16px"><img src="/icons/logo.png" alt="" style="width:64px"><div><div class="bold" style="font-size:1.25rem">Yapper</div><div class="muted">Free chat for your communities and friends. Everything's free — no paywalls.</div></div></div>
    <h3>Get the app</h3>
    <div class="list-row"><div class="grow"><div class="t">Install on this device</div><div class="d">${standalone ? 'You are using the installed app.' : 'Install Yapper as an app on your phone or computer (PWA).'}</div></div>
      ${standalone ? '' : '<button class="btn small" data-install>Install</button>'}</div>
    <div class="list-row"><div class="grow"><div class="t">Desktop app (Windows, macOS, Linux)</div><div class="d">Native desktop app with tray icon and notifications. Build it from the <code>desktop/</code> folder of the Yapper repo.</div></div></div>
    <h3>Credits</h3>
    <p class="muted small">Emoji: Noto 3D Emoji by Google (SIL Open Font License 1.1). Apple devices show Apple's native emoji. Text: Inter by Rasmus Andersson (SIL OFL 1.1).</p>`;
  body.onclick = (e) => { if (e.target.closest('[data-install]')) notifications.promptInstall(); };
}

// ---------- Custom status ----------
export function openCustomStatus() {
  let emoji = state.user.custom_status_emoji || null;
  const m = modal({
    title: 'Set a custom status',
    body: `<div class="field"><label>What's cookin', ${esc(state.user.display_name || state.user.username)}?</label>
      <div class="row"><button class="icon-btn" data-emo style="width:42px;height:42px;background:var(--bg-input)"></button>
      <input class="input grow" data-text maxlength="128" placeholder="Support has arrived!" value="${esc(state.user.custom_status || '')}"></div></div>`,
    buttons: [
      { label: 'Clear', cls: 'ghost', action: async () => { await save(null, null); } },
      { label: 'Save', action: async (mm) => { await save($('[data-text]', mm.body).value, emoji); } },
    ],
  });
  const btn = $('[data-emo]', m.body);
  const draw = () => { btn.innerHTML = emoji ? anyEmojiHtml(emoji, null) : icon('smile'); };
  draw();
  btn.onclick = () => openPicker(btn, (p) => { emoji = p.type === 'custom' ? `c:${p.emoji.id}` : p.value; draw(); });
  async function save(text, em) {
    try { state.user = await PATCH('/users/@me', { custom_status: text || '', custom_status_emoji: em || '' }); emit('self'); } catch (e) { errToast(e); }
  }
}

