// Global keyboard shortcuts (and one secret).
import { esc, toast } from './dom.js';
import { modal } from './ui/layers.js';
import { emit } from './store.js';

const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const CTRL = isMac ? '⌘ Cmd' : 'Ctrl';
const ALT = isMac ? '⌥ Option' : 'Alt';

const SHORTCUTS = [
  ['General', [
    [[CTRL, '\\'], 'Show all keyboard shortcuts'],
    [[CTRL, ALT, 'S'], 'Toggle background music on or off'],
    [[CTRL, 'Shift', 'M'], 'Toggle mute'],
    [[CTRL, 'Shift', 'D'], 'Toggle deafen'],
    [['Esc'], 'Close a dialog, menu or picker'],
  ]],
  ['Messages', [
    [['Enter'], 'Send message'],
    [['Shift', 'Enter'], 'New line'],
    [['↑'], 'Edit your last message (when the message box is empty)'],
    [['Esc'], 'Cancel reply or edit'],
    [['Tab'], 'Pick the highlighted autocomplete suggestion'],
    [['Any key'], 'Start typing to jump into the message box'],
  ]],
  ['Voice', [
    [['`'], 'Push to talk (hold, when enabled in Voice & Video)'],
  ]],
  ['Secret', [
    [['↑', '↑', '↓', '↓', '←', '→', '←', '→', 'B', 'A'], 'You know what this does 🐍'],
  ]],
];

let open = null;
export function showShortcuts() {
  if (open) { open.close(); return; }
  const kbd = (k) => `<kbd>${esc(k)}</kbd>`;
  open = modal({
    title: 'Keyboard Shortcuts',
    wide: true,
    body: SHORTCUTS.map(([group, list]) => `<div class="label" style="margin:12px 0 6px">${group}</div>
      ${list.map(([keys, desc]) => `<div class="shortcut-row"><span>${esc(desc)}</span><span class="keys">${keys.map(kbd).join(group === 'Secret' ? ' ' : '<span class="plus">+</span>')}</span></div>`).join('')}`).join(''),
    onClose: () => { open = null; },
  });
}

const typingInField = () => {
  const a = document.activeElement;
  return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable);
};

const KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
let konamiPos = 0;

document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;

  // Ctrl + Alt + S: toggle background music.
  if (mod && e.altKey && !e.shiftKey && e.code === 'KeyS') {
    e.preventDefault();
    import('./music.js').then((m) => {
      if (!m.music().url) { toast('Pick a song in User Settings → Background Music first. 🎵'); return; }
      m.toggle();
      toast(m.music().enabled ? 'Background music on 🎵' : 'Background music off', 'ok');
    });
    return;
  }
  // Ctrl + \: shortcut list.
  if (mod && !e.altKey && !e.shiftKey && (e.key === '\\' || e.code === 'Backslash')) {
    e.preventDefault();
    showShortcuts();
    return;
  }
  // Ctrl + Shift + M / D: mute / deafen.
  if (mod && e.shiftKey && !e.altKey && (e.code === 'KeyM' || e.code === 'KeyD')) {
    e.preventDefault();
    import('./ui/voice.js').then((v) => {
      if (e.code === 'KeyM') v.toggleMute(); else v.toggleDeafen();
      emit('voice_prefs');
    });
    return;
  }

  // Konami code (outside text boxes).
  if (typingInField() || mod || e.altKey) { konamiPos = 0; return; }
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (key === KONAMI[konamiPos]) {
    // After the arrows, keep B and A from jumping into the message box.
    if (konamiPos >= 8) { e.preventDefault(); e.stopPropagation(); }
    konamiPos++;
    if (konamiPos === KONAMI.length) {
      konamiPos = 0;
      e.preventDefault();
      import('./snake.js').then((s) => s.playSnake());
    }
  } else konamiPos = key === KONAMI[0] ? 1 : 0;
}, true);
