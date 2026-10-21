'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

fs.mkdirSync(config.dataDir, { recursive: true });
const db = new DatabaseSync(path.join(config.dataDir, 'yapper.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT,
  email TEXT,
  password_hash TEXT NOT NULL,
  avatar TEXT,
  banner TEXT,
  accent_color TEXT,
  bio TEXT NOT NULL DEFAULT '',
  pronouns TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'online',
  custom_status TEXT,
  custom_status_emoji TEXT,
  settings TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS servers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT,
  banner TEXT,
  description TEXT NOT NULL DEFAULT '',
  owner_id INTEGER NOT NULL REFERENCES users(id),
  pin TEXT NOT NULL UNIQUE,
  system_channel_id INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nickname TEXT,
  joined_at INTEGER NOT NULL,
  timeout_until INTEGER,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (server_id, user_id)
);
CREATE INDEX IF NOT EXISTS members_user ON members(user_id);

CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY,
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT,
  permissions INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  hoist INTEGER NOT NULL DEFAULT 0,
  mentionable INTEGER NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS roles_server ON roles(server_id);

CREATE TABLE IF NOT EXISTS member_roles (
  server_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (server_id, user_id, role_id),
  FOREIGN KEY (server_id, user_id) REFERENCES members(server_id, user_id) ON DELETE CASCADE
);

-- type: text | voice | category | announcement | dm | group
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY,
  server_id INTEGER REFERENCES servers(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  name TEXT,
  topic TEXT NOT NULL DEFAULT '',
  parent_id INTEGER,
  position INTEGER NOT NULL DEFAULT 0,
  slowmode INTEGER NOT NULL DEFAULT 0,
  icon TEXT,
  owner_id INTEGER,
  last_message_id INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS channels_server ON channels(server_id);

CREATE TABLE IF NOT EXISTS channel_overwrites (
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL, -- role | member
  target_id INTEGER NOT NULL,
  allow INTEGER NOT NULL DEFAULT 0,
  deny INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, target_type, target_id)
);

CREATE TABLE IF NOT EXISTS dm_members (
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  closed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX IF NOT EXISTS dm_members_user ON dm_members(user_id);

-- type: default | reply | system | poll
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  type TEXT NOT NULL DEFAULT 'default',
  content TEXT NOT NULL DEFAULT '',
  attachments TEXT NOT NULL DEFAULT '[]',
  reply_to INTEGER,
  mentions TEXT NOT NULL DEFAULT '[]',
  mention_roles TEXT NOT NULL DEFAULT '[]',
  mention_everyone INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  edited_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_channel ON messages(channel_id, id);

CREATE TABLE IF NOT EXISTS reactions (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL, -- unicode emoji, or "c:<id>" for custom emoji
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);

CREATE TABLE IF NOT EXISTS polls (
  message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  options TEXT NOT NULL, -- JSON [{text, emoji}]
  multi INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  ended INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS poll_votes (
  message_id INTEGER NOT NULL REFERENCES polls(message_id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  option_index INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, option_index)
);

CREATE TABLE IF NOT EXISTS emojis (
  id INTEGER PRIMARY KEY,
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  file TEXT NOT NULL,
  animated INTEGER NOT NULL DEFAULT 0,
  creator_id INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS emojis_server ON emojis(server_id);

-- status: pending | friends | blocked  (row is from the perspective of user_id)
CREATE TABLE IF NOT EXISTS relationships (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  other_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL, -- friend | incoming | outgoing | blocked
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, other_id)
);

CREATE TABLE IF NOT EXISTS read_states (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  last_read_id INTEGER NOT NULL DEFAULT 0,
  mention_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, channel_id)
);

-- level: all | mentions | none ; muted: 0/1
CREATE TABLE IF NOT EXISTS notify_settings (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id INTEGER NOT NULL, -- server id or channel id
  level TEXT,
  muted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, target_id)
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  keys TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bans (
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT,
  banned_by INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (server_id, user_id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id INTEGER,
  action TEXT NOT NULL,
  target TEXT,
  details TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_server ON audit_log(server_id, id);

CREATE TABLE IF NOT EXISTS user_notes (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note TEXT NOT NULL,
  PRIMARY KEY (user_id, target_id)
);
`);

// Snowflake-ish ids: time-ordered integers that stay inside JS's safe integer range.
const EPOCH = Date.UTC(2025, 0, 1);
let lastMs = 0;
let seq = 0;
function newId() {
  let now = Date.now() - EPOCH;
  if (now === lastMs) {
    seq++;
    if (seq >= 1024) { now = ++lastMs; seq = 0; }
  } else if (now < lastMs) {
    now = lastMs; seq++;
  } else {
    seq = 0;
  }
  lastMs = now;
  return now * 1024 + seq;
}
function idTime(id) { return Math.floor(id / 1024) + EPOCH; }

const cache = new Map();
function stmt(sql) {
  let s = cache.get(sql);
  if (!s) { s = db.prepare(sql); cache.set(sql, s); }
  return s;
}
const get = (sql, ...p) => stmt(sql).get(...p);
const all = (sql, ...p) => stmt(sql).all(...p);
const run = (sql, ...p) => stmt(sql).run(...p);

function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function getSetting(key) {
  const r = get('SELECT value FROM settings WHERE key = ?', key);
  return r ? r.value : null;
}
function setSetting(key, value) {
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
}

module.exports = { db, newId, idTime, get, all, run, tx, getSetting, setSetting };
