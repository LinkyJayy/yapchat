// Background music: loops the audio file the user picked in settings.
import { state, on, emit } from './store.js';
import { PATCH } from './api.js';
import { debounce } from './dom.js';
import * as voice from './ui/voice.js';

const audio = new Audio();
audio.loop = true;
audio.preload = 'auto';

let waitingForGesture = false;

export const music = () => state.user?.settings?.bgMusic || {};
export const isPlaying = () => !audio.paused;

// Browsers block autoplay until the user interacts with the page.
function retryOnGesture() {
  if (waitingForGesture) return;
  waitingForGesture = true;
  const go = () => {
    waitingForGesture = false;
    window.removeEventListener('pointerdown', go, true);
    window.removeEventListener('keydown', go, true);
    sync();
  };
  window.addEventListener('pointerdown', go, true);
  window.addEventListener('keydown', go, true);
}

export function sync() {
  const m = music();
  const inCall = !!voice.current();
  const shouldPlay = !!m.url && !!m.enabled && !(inCall && m.pauseInCalls !== false);
  audio.volume = Math.min(1, Math.max(0, m.volume ?? 0.4));
  if (!m.url) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  } else if (audio.getAttribute('src') !== m.url) {
    audio.src = m.url;
  }
  if (shouldPlay && audio.paused) {
    audio.play().catch((e) => { if (e.name === 'NotAllowedError') retryOnGesture(); });
  } else if (!shouldPlay && !audio.paused) {
    audio.pause();
  }
  if ('mediaSession' in navigator && m.url) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: (m.name || 'Background music').replace(/\.[^.]+$/, ''),
      artist: 'Yapper',
      artwork: [{ src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
    });
  }
}

const saveMusic = debounce((patch) => PATCH('/users/@me', { settings: { bgMusic: patch } }).catch(() => {}), 400);

// Update music prefs locally right away and sync them to the account.
export function update(patch) {
  const next = { ...music(), ...patch };
  state.user.settings = { ...(state.user.settings || {}), bgMusic: next };
  sync();
  emit('music');
  saveMusic(next);
}

export const toggle = () => update({ enabled: !music().enabled });
export const setVolume = (v) => update({ volume: Number(v) });

audio.addEventListener('play', () => emit('music'));
audio.addEventListener('pause', () => emit('music'));

if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', () => update({ enabled: true }));
  navigator.mediaSession.setActionHandler('pause', () => update({ enabled: false }));
}

on('self', () => { sync(); emit('music'); });
on('voice_changed', sync);
