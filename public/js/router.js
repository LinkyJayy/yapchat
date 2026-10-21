import { state, emit } from './store.js';

export function parse(pathname = location.pathname) {
  const m = /^\/channels\/(@me|\d+)(?:\/(\d+))?/.exec(pathname);
  if (!m) return { serverId: '@me', channelId: null };
  return { serverId: m[1] === '@me' ? '@me' : Number(m[1]), channelId: m[2] ? Number(m[2]) : null };
}

export function navigate(path, { replace = false } = {}) {
  if (location.pathname + location.search !== path) {
    history[replace ? 'replaceState' : 'pushState']({}, '', path);
  }
  route();
}

export function route() {
  const r = parse();
  const prev = state.route;
  state.route = r;
  emit('route', { prev, next: r });
}

window.addEventListener('popstate', route);

export const channelPath = (serverId, channelId) => `/channels/${serverId || '@me'}${channelId ? `/${channelId}` : ''}`;
