// Applies theme / density / font scale from user settings.
import { state } from './store.js';

const mq = matchMedia('(prefers-color-scheme: light)');

export function applyAppearance() {
  const s = state.user?.settings || {};
  let theme = s.theme || 'dark';
  if (theme === 'system') theme = mq.matches ? 'light' : 'dark';
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.classList.toggle('compact', s.display === 'compact');
  root.style.setProperty('--font-scale', String(s.fontScale || 1));
  root.classList.toggle('reduce-motion', !!s.reduceMotion);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#dfe9e4' : theme === 'midnight' ? '#000000' : '#0d1311');
}

mq.addEventListener('change', applyAppearance);
