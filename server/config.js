'use strict';
const path = require('node:path');

// On Railway, attach a volume and its mount path is exposed as RAILWAY_VOLUME_MOUNT_PATH.
const dataDir = path.resolve(
  process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || path.join(__dirname, '..', 'data')
);

const mb = (v, d) => (Number(v) > 0 ? Number(v) : d) * 1024 * 1024;

module.exports = {
  port: Number(process.env.PORT) || 3000,
  dataDir,
  uploadsDir: path.join(dataDir, 'uploads'),
  publicUrl: process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : ''),
  vapidSubject: process.env.VAPID_SUBJECT || 'mailto:admin@yapper.local',
  maxUploadBytes: mb(process.env.MAX_UPLOAD_MB, 50),
  maxAvatarBytes: mb(process.env.MAX_AVATAR_MB, 10),
  maxEmojiBytes: mb(process.env.MAX_EMOJI_MB, 2),
  maxEmojisPerServer: Number(process.env.MAX_EMOJIS_PER_SERVER) || 250,
  registrationOpen: process.env.REGISTRATION_OPEN !== 'false',
  iceServers: process.env.ICE_SERVERS
    ? JSON.parse(process.env.ICE_SERVERS)
    : [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],
};
