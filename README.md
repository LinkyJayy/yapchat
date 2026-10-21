<p align="center"><img src="public/icons/logo.png" width="120" alt="Yapper logo"></p>

<h1 align="center">Yapper</h1>
<p align="center">A free, self-hostable chat app for your communities and friends — servers, channels, roles, voice & video, polls, custom emoji and more. Everything is free: animated avatars, banners and emoji included.</p>

---

## Features

**Accounts & profiles**
- Register / log in (username or email), change username, email and password, delete account
- Device list with remote log-out
- Display name, pronouns, About Me (markdown), banner color
- **Animated** profile pictures and banners (GIF, animated WebP, APNG) — free for everyone
- Status (Online, Idle, Do Not Disturb, Invisible) and custom status with emoji
- Private notes on other users

**Servers (PIN-only)**
- Every server has a unique **8-digit PIN** — the *only* way to join. Owners can regenerate it or set a custom 6–12 digit PIN
- Server icon & banner (animated supported), description, system-message channel
- **Text, voice, announcement channels and categories**, drag-and-drop reordering, private channels
- **Roles** with colors, hierarchy, "display separately", mentionable, and 25 permissions (incl. Administrator)
- Per-channel permission overrides for roles and members (allow / inherit / deny)
- **The owner can do anything**: bypasses every permission, transfers ownership, deletes the server
- Moderation: kick, ban (with message purge), timeouts, nickname management, voice mute/disconnect
- Audit log, ban list, member list grouped by hoisted roles
- **Custom emojis** (static or animated) — up to 250 per server, usable everywhere you're a member

**Messaging**
- Markdown: bold, italics, underline, strikethrough, spoilers, code blocks, quotes, headings, lists, masked links, timestamps (`<t:unix:R>`)
- Mentions for users, roles, `@everyone`/`@here`, and `#channels` with autocomplete
- **Reactions** (unicode + custom emoji), replies (with ping toggle), edits, deletes, pins, mark unread
- **Polls** with up to 10 answers, emoji, multi-select and durations from 1 hour to 2 weeks
- File uploads (up to 10 per message, drag & drop, paste) with image/video/audio previews and spoiler attachments
- Typing indicators, unread markers & mention badges, jump-to-message, search (by text, author, files, polls, pins), mentions inbox
- Slash shortcuts: `/shrug`, `/tableflip`, `/unflip`, `/spoiler`, `/me`
- Direct messages, **group DMs** (up to 10), friends (requests, accept, remove), blocking

**Voice & video**
- Voice channels and DM/group calls with ringing
- Camera video and **screen sharing**
- Mute, deafen, push-to-talk, speaking indicators, device selection, echo cancellation/noise suppression toggles

**Apps & notifications**
- **PWA**: installable on Android, iOS/iPadOS, Windows, macOS, Linux and ChromeOS, works offline for the shell
- **Push notifications on phone and PC** (Web Push), even when the app is closed; per-server and per-channel notification levels and muting; app-icon unread badge
- **PC desktop app** (Electron) for Windows, macOS and Linux with tray icon, native notifications, taskbar badge and start-at-login
- **Background music**: pick any audio file (MP3, OGG, WAV, FLAC, M4A, WebM) in *User Settings → Background Music* and it loops in the background on all your devices, with volume, a quick play/pause button next to your name, lock-screen controls, and optional auto-pause during calls
- Dark, Light, Midnight (AMOLED) and system themes, compact mode, font scaling, reduced motion
- Mint green theme matching the logo (`#00D087`)
- **Inter** for text, **Noto 3D Emoji** for emoji everywhere except Apple devices (iOS/iPadOS/macOS keep Apple's native emoji)

---

## Run locally

Requires **Node.js 22.13+** (uses the built-in `node:sqlite`, no native modules to compile).

```bash
npm install
npm start          # http://localhost:3000
npm test           # API tests
```

Data (SQLite database + uploads) is stored in `./data` by default.

## Deploy to Railway

1. Push this repo to GitHub and create a new Railway project → **Deploy from GitHub repo**.
   Railway uses the included `Dockerfile` and `railway.json` (health check at `/api/health`).
2. **Add a Volume** to the service (e.g. mount path `/data`). Yapper automatically uses `RAILWAY_VOLUME_MOUNT_PATH`
   for its database and uploads. *Without a volume, data is lost on every redeploy.*
3. Under **Settings → Networking**, click **Generate Domain**. That's your Yapper URL.
4. Keep the service at **1 replica** (SQLite lives on the volume).

### Environment variables (all optional)

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on (Railway sets this) |
| `DATA_DIR` | `./data` | Where to store the database and uploads (Railway volume path wins if present) |
| `REGISTRATION_OPEN` | `true` | Set to `false` to stop new sign-ups |
| `MAX_UPLOAD_MB` | `50` | Max size per message attachment |
| `MAX_AVATAR_MB` | `10` | Max avatar / banner / server icon size |
| `MAX_EMOJI_MB` | `2` | Max custom emoji size |
| `MAX_MUSIC_MB` | `20` | Max background music file size |
| `MAX_EMOJIS_PER_SERVER` | `250` | Custom emoji limit per server |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | auto | Web Push keys. Generated and stored in the database on first run if not set |
| `VAPID_SUBJECT` | `mailto:admin@yapper.local` | Contact for push services — set to your email |
| `ICE_SERVERS` | Google STUN | JSON array of WebRTC ICE servers. Add a TURN server for calls on strict networks, e.g. `[{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]` |

## Install the app

- **Android / Chrome / Edge (PC):** open your Yapper URL → menu → *Install Yapper* (or use the banner on the Friends page).
- **iPhone / iPad:** open in Safari → Share → *Add to Home Screen*. Open Yapper from the home screen, then enable notifications in *User Settings → Notifications* (iOS 16.4+ required for web push).
- **Windows / macOS / Linux desktop app:** see below.

## Desktop app (PC)

The `desktop/` folder contains an Electron app that wraps your Yapper server.

```bash
cd desktop
npm install
npm start                              # run it; it asks for your server URL on first launch
YAPPER_URL=https://your.app npm start  # or pass the URL directly
npm run dist:win                       # build a Windows installer   (dist/)
npm run dist:mac                       # build a macOS .dmg          (run on a Mac)
npm run dist:linux                     # build an AppImage + .deb
```

Closing the window keeps Yapper in the system tray so notifications keep coming; quit from the tray menu.

## Notifications

- **Phones & PC browsers:** turn on *User Settings → Notifications → Enable notifications on this device*. Uses Web Push, so it works when the app is closed.
- **Desktop app:** native OS notifications, always on while Yapper is running (including in the tray).
- Right-click (or long-press) a server, channel or DM to choose *All Messages*, *Only @mentions*, *Nothing*, or mute it.
- Do Not Disturb status silences all notifications and sounds.

## Project layout

```
server/            Node.js server (Express + Socket.IO + SQLite)
  routes/          REST API (users, servers, channels/messages)
  gateway.js       realtime events, presence, voice signaling
  permissions.js   role/channel permission engine
public/            web client (no build step) — PWA manifest, service worker, icons
  emoji/3d/        Noto 3D emoji images (extracted from Google's Noto 3D font)
desktop/           Electron desktop app
tools/             asset build scripts
test/              API tests (node:test)
```

## Credits

- Emoji: [Noto 3D Emoji](https://github.com/googlefonts/noto-emoji) by Google — SIL Open Font License 1.1 (`public/emoji/LICENSE-noto-3d.txt`)
- Font: [Inter](https://rsms.me/inter/) by Rasmus Andersson — SIL Open Font License 1.1 (`public/fonts/LICENSE-inter.txt`)
