// Notifications: Web Push (phone + PC, even when closed), in-app notifications, sounds,
// app icon badge, and the PWA install prompt.
import { state, on, isMuted, mentionCount } from './store.js';
import { api } from './api.js';
import { el, esc, toast } from './dom.js';
import { navigate } from './router.js';

const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const desktop = window.yapperDesktop || null; // Exposed by the Electron app.
window.addEventListener('yapper-navigate', (e) => { if (typeof e.detail === 'string' && e.detail.startsWith('/')) navigate(e.detail); });

export function support() {
  const notify = 'Notification' in window || !!desktop;
  const push = 'serviceWorker' in navigator && 'PushManager' in window && !desktop;
  return { notify, push, iosNeedsInstall: isIOS && !standalone() };
}

let swReg = null;
export async function registerSW() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    swReg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.type === 'navigate' && e.data.url) navigate(e.data.url);
    });
  } catch (e) { console.warn('SW registration failed', e); }
  return swReg;
}

function urlBase64ToUint8Array(base64) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export async function enable() {
  if (desktop) return true; // Electron always allows notifications.
  if (!('Notification' in window)) { toast("This browser doesn't support notifications.", 'error'); return false; }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') { toast('Notifications were not allowed.', 'error'); return false; }
  if (!support().push) return true;
  try {
    const reg = swReg || await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(state.vapid) });
    await api('POST', '/users/@me/push', sub.toJSON());
    hasPushSub = true;
    return true;
  } catch (e) {
    toast(`Couldn't enable push: ${e.message}`, 'error');
    return false;
  }
}

export async function isSubscribed() {
  if (!support().push) return false;
  try { return !!(await (swReg || await navigator.serviceWorker.ready).pushManager.getSubscription()); } catch { return false; }
}
export async function currentEndpoint() {
  if (!support().push) return null;
  try { return (await (swReg || await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription())?.endpoint || null; } catch { return null; }
}
export async function unsubscribe() {
  if (!support().push) return;
  try {
    const sub = await (swReg || await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription();
    if (sub) {
      await api('DELETE', '/users/@me/push', { endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe();
    }
    hasPushSub = false;
  } catch { /* ignore */ }
}

// Re-sync an existing subscription with the server on every start (keys can rotate).
export async function syncSubscription() {
  if (!support().push || Notification.permission !== 'granted') return;
  try {
    const reg = swReg || await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) await api('POST', '/users/@me/push', sub.toJSON());
  } catch { /* ignore */ }
}

let hasPushSub = false;
isSubscribed().then((v) => { hasPushSub = v; });

async function show(n) {
  const s = state.user?.settings || {};
  const body = s.previews === false ? 'New message' : n.body;
  const opts = { body, icon: n.icon || '/icons/icon-192.png', badge: '/icons/badge-96.png', tag: n.tag, data: { url: n.url }, renotify: true };
  if (desktop) { desktop.notify({ title: n.title, body, url: n.url }); return; }
  try {
    const reg = swReg || await navigator.serviceWorker?.getRegistration();
    if (reg) { await reg.showNotification(n.title, opts); return; }
  } catch { /* fall through */ }
  const notif = new Notification(n.title, opts);
  notif.onclick = () => { window.focus(); navigate(n.url); notif.close(); };
}

const viewing = (n) => document.visibilityState === 'visible' && document.hasFocus() && state.route.channelId === n.channel_id;

on('notify', async (n) => {
  if (state.user.set_status === 'dnd') return;
  const s = state.user.settings || {};
  if (viewing(n)) return;
  if (n.quiet) {
    // Another (or this) client is active: just a soft sound in the active window.
    if (document.visibilityState === 'visible' && document.hasFocus() && s.sounds !== false) playSound(n.mentioned ? 'mention' : 'message');
    return;
  }
  if (s.sounds !== false && document.visibilityState === 'visible') playSound(n.mentioned ? 'mention' : 'message');
  // When subscribed to push, the service worker shows it (works even when closed).
  if (hasPushSub) return;
  if (desktop || ('Notification' in window && Notification.permission === 'granted')) show(n);
});

// ---------- Badge ----------
export function updateBadge() {
  const s = state.user?.settings || {};
  let count = 0;
  if (s.badge !== false) {
    for (const d of state.dms.values()) if (!isMuted(d.id)) count += mentionCount(d.id);
    for (const sv of state.servers.values()) if (!isMuted(sv.id)) for (const c of sv.channels) count += mentionCount(c.id);
  }
  document.title = count ? `(${count}) Yapper` : 'Yapper';
  if (desktop) desktop.setBadge(count);
  else if ('setAppBadge' in navigator) (count ? navigator.setAppBadge(count) : navigator.clearAppBadge()).catch(() => {});
}
on('unread', updateBadge);

// ---------- Sounds (synthesized, no files needed) ----------
let actx = null;
let ringTimer = null;
function tone(freqs, { dur = 0.12, gap = 0.08, type = 'sine', vol = 0.12 } = {}) {
  try {
    actx ||= new (window.AudioContext || window.webkitAudioContext)();
    let t = actx.currentTime;
    for (const f of freqs) {
      const o = actx.createOscillator();
      const g = actx.createGain();
      o.type = type; o.frequency.value = f;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vol, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(actx.destination);
      o.start(t); o.stop(t + dur + 0.02);
      t += gap;
    }
  } catch { /* ignore */ }
}
export function playSound(kind) {
  if (state.user?.settings?.sounds === false && kind !== 'ring') return;
  switch (kind) {
    case 'message': return tone([880, 1320], { dur: 0.1, gap: 0.07 });
    case 'mention': return tone([988, 1319, 1568], { dur: 0.12, gap: 0.08 });
    case 'join': return tone([523, 784], { dur: 0.15, gap: 0.1, type: 'triangle' });
    case 'leave': return tone([784, 523], { dur: 0.15, gap: 0.1, type: 'triangle' });
    case 'mute': return tone([440], { dur: 0.06, type: 'square', vol: 0.05 });
    case 'unmute': return tone([660], { dur: 0.06, type: 'square', vol: 0.05 });
    case 'ring':
      stopRing();
      tone([659, 784, 988], { dur: 0.2, gap: 0.18, type: 'triangle' });
      ringTimer = setInterval(() => tone([659, 784, 988], { dur: 0.2, gap: 0.18, type: 'triangle' }), 2000);
      setTimeout(stopRing, 30_000);
      return undefined;
    default: return undefined;
  }
}
export function stopRing() { clearInterval(ringTimer); ringTimer = null; }

export async function test() {
  if (!(await enable())) return;
  hasPushSub = await isSubscribed();
  show({ title: 'Yapper', body: 'Notifications are working! 🎉', tag: 'test', url: '/channels/@me' });
}

// ---------- Install (PWA) ----------
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; });
window.addEventListener('appinstalled', () => { deferredPrompt = null; toast('Yapper installed! 🎉', 'ok'); });

export async function promptInstall() {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
  } else if (isIOS) {
    toast('Tap the Share button, then "Add to Home Screen".');
  } else {
    toast('Use your browser menu → "Install Yapper" (or "Add to Home screen").');
  }
}

export function renderInstallTip(slot) {
  if (!slot || standalone() || desktop) return;
  let dismissed = false;
  try { dismissed = localStorage.getItem('yapper_install_dismissed') === '1'; } catch { /* ignore */ }
  const needNotif = support().notify && 'Notification' in window && Notification.permission === 'default';
  if (dismissed && !needNotif) return;
  const tip = el(`<div class="install-tip"><img src="/icons/logo.png" alt="" style="width:28px;filter:brightness(0) invert(1)">
    <div class="grow">${needNotif ? 'Turn on notifications so you never miss a message.' : esc('Install Yapper for a faster, app-like experience.')}</div>
    <button class="btn small" data-go>${needNotif ? 'Enable' : 'Install'}</button><button data-x aria-label="Dismiss">✕</button></div>`);
  slot.append(tip);
  tip.onclick = async (e) => {
    if (e.target.closest('[data-x]')) { tip.remove(); try { localStorage.setItem('yapper_install_dismissed', '1'); } catch { /* ignore */ } }
    if (e.target.closest('[data-go]')) {
      if (needNotif) { if (await enable()) { hasPushSub = await isSubscribed(); tip.remove(); } } else promptInstall();
    }
  };
}
