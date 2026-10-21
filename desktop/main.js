// Yapper desktop app: wraps your Yapper server in a native window with tray,
// native notifications, unread badge, screen sharing and single-instance behavior.
const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, nativeImage, shell, session, desktopCapturer } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const ICON = path.join(__dirname, 'build', 'icon.png');
const configPath = () => path.join(app.getPath('userData'), 'config.json');

function readConfig() {
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch { return {}; }
}
function writeConfig(patch) {
  const c = { ...readConfig(), ...patch };
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(c, null, 2));
  return c;
}

function serverUrl() {
  const raw = process.env.YAPPER_URL || readConfig().serverUrl;
  if (!raw) return null;
  try { return new URL(raw).origin; } catch { return null; }
}

let win = null;
let tray = null;
let quitting = false;

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => showWindow());
app.setAppUserModelId('app.yapper.desktop');

function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  const state = readConfig().window || {};
  win = new BrowserWindow({
    width: state.width || 1280,
    height: state.height || 800,
    x: state.x,
    y: state.y,
    minWidth: 380,
    minHeight: 500,
    title: 'Yapper',
    icon: ICON,
    backgroundColor: '#141c19',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });
  if (state.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.webContents.setUserAgent(`${win.webContents.getUserAgent()} Yapper/${app.getVersion()}`);

  const url = serverUrl();
  if (url) win.loadURL(`${url}/channels/@me`);
  else win.loadFile(path.join(__dirname, 'setup.html'));

  // Open external links in the default browser.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, target) => {
    const base = serverUrl();
    if (base && !target.startsWith(base) && !target.startsWith('file:')) { e.preventDefault(); shell.openExternal(target); }
  });

  const saveBounds = () => {
    if (!win || win.isDestroyed()) return;
    writeConfig({ window: { ...win.getNormalBounds(), maximized: win.isMaximized() } });
  };
  win.on('resize', debounce(saveBounds, 500));
  win.on('move', debounce(saveBounds, 500));

  // Closing hides to the tray; quit from the tray menu.
  win.on('close', (e) => {
    if (!quitting && readConfig().closeToTray !== false) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => { win = null; });
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 18, height: 18 }));
  tray.setToolTip('Yapper');
  const rebuild = () => tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Yapper', click: showWindow },
    { type: 'separator' },
    {
      label: 'Close to tray', type: 'checkbox', checked: readConfig().closeToTray !== false,
      click: (item) => writeConfig({ closeToTray: item.checked }),
    },
    {
      label: 'Launch at startup', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { label: 'Change server…', click: () => { writeConfig({ serverUrl: null }); showWindow(); win.loadFile(path.join(__dirname, 'setup.html')); } },
    { type: 'separator' },
    { label: 'Quit Yapper', click: () => { quitting = true; app.quit(); } },
  ]));
  rebuild();
  tray.on('click', showWindow);
}

// ---------- IPC from the web app ----------
ipcMain.on('notify', (_e, { title, body, url }) => {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: String(title || 'Yapper'), body: String(body || ''), icon: ICON, silent: false });
  n.on('click', () => {
    showWindow();
    if (url) win?.webContents.send('navigate', String(url));
  });
  n.show();
  if (win && !win.isFocused()) win.flashFrame(true);
});

let lastBadge = 0;
ipcMain.on('badge', (_e, count) => {
  count = Math.max(0, Number(count) || 0);
  if (count === lastBadge) return;
  lastBadge = count;
  app.setBadgeCount?.(count);
  if (process.platform === 'win32' && win) {
    win.setOverlayIcon(count ? badgeIcon() : null, count ? `${count} unread mentions` : '');
  }
  tray?.setToolTip(count ? `Yapper — ${count} unread` : 'Yapper');
});

function badgeIcon() {
  // A small red dot for the Windows taskbar overlay.
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const d = Math.hypot(x - 7.5, y - 7.5);
    const i = (y * size + x) * 4;
    if (d <= 7.5) { buf[i] = 0x5b; buf[i + 1] = 0x54; buf[i + 2] = 0xf2; buf[i + 3] = 255; } // BGRA
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

ipcMain.handle('setup:save', (_e, url) => {
  let origin;
  try { origin = new URL(String(url).trim()).origin; } catch { return { error: 'That does not look like a valid URL.' }; }
  if (!/^https?:/.test(origin)) return { error: 'Use an http(s) URL.' };
  writeConfig({ serverUrl: origin });
  win?.loadURL(`${origin}/channels/@me`);
  return { ok: true };
});
ipcMain.handle('setup:get', () => readConfig().serverUrl || '');

app.whenReady().then(() => {
  // Allow mic/camera/notifications/screen share for the Yapper server only.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    const base = serverUrl();
    const ok = base && wc.getURL().startsWith(base) && ['media', 'notifications', 'display-capture', 'clipboard-sanitized-write', 'fullscreen'].includes(permission);
    cb(!!ok);
  });
  session.defaultSession.setDisplayMediaRequestHandler((_req, cb) => {
    desktopCapturer.getSources({ types: ['screen', 'window'] }).then((sources) => {
      cb({ video: sources[0], audio: process.platform === 'win32' ? 'loopback' : undefined });
    }).catch(() => cb({}));
  }, { useSystemPicker: true });

  createWindow();
  createTray();
  app.on('activate', showWindow);
});

app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
