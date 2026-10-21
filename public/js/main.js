// Boot: auth check → load state → connect realtime → mount the app.
import { token, GET } from './api.js';
import { state, loadReady, on, emit } from './store.js';
import { mountAuth } from './auth.js';
import { route, parse } from './router.js';
import { connect } from './realtime.js';
import { applyAppearance } from './appearance.js';
import { loadEmoji } from './emoji.js';
import { registerSW, syncSubscription, updateBadge } from './notifications.js';
import { toast } from './dom.js';

async function boot() {
  registerSW();
  const path = location.pathname;
  if (!token.get()) {
    if (path.startsWith('/channels/')) try { sessionStorage.setItem('yapper_after_login', path + location.search); } catch { /* ignore */ }
    if (path !== '/login' && path !== '/register') history.replaceState({}, '', '/login');
    return mountAuth(location.pathname === '/register' ? 'register' : 'login');
  }
  if (!path.startsWith('/channels/')) history.replaceState({}, '', '/channels/@me' + location.search);

  let ready;
  try {
    ready = await GET('/ready');
  } catch (e) {
    const app = document.getElementById('app');
    app.innerHTML = `<div class="boot"><div class="center"><img src="/icons/logo.png" class="boot-logo" alt=""><p class="muted"></p><button class="btn">Retry</button></div></div>`;
    app.querySelector('p').textContent = e.message;
    app.querySelector('button').onclick = () => location.reload();
    return;
  }
  loadReady(ready);
  applyAppearance();
  loadEmoji();
  state.route = parse();
  const { mountApp } = await import('./ui/app.js');
  mountApp();
  connect();
  import('./music.js').then((m) => m.sync());
  import('./shortcuts.js');
  updateBadge();
  syncSubscription();

  // Re-sync state after reconnecting (we may have missed events while offline).
  on('resync', async () => {
    try {
      loadReady(await GET('/ready'));
      state.messages.clear();
      state.members.clear();
      emit('servers'); emit('dms'); emit('unread'); emit('self'); emit('relationships');
      route();
    } catch { /* ignore */ }
  });
  let wasOffline = false;
  on('connection', (ok) => {
    if (!ok) { wasOffline = true; toast('Connection lost — reconnecting…'); }
    else if (wasOffline) { wasOffline = false; toast('Reconnected!', 'ok'); }
  });
}

boot();
