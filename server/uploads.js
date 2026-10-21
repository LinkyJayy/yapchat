'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const multer = require('multer');
const config = require('./config');
const { fail } = require('./util');

fs.mkdirSync(config.uploadsDir, { recursive: true });

// Sniff real file types from magic bytes rather than trusting the client.
function sniff(buf) {
  const b = buf;
  const s = (o, str) => b.length >= o + str.length && b.toString('latin1', o, o + str.length) === str;
  if (s(0, '\x89PNG')) {
    // APNG has an acTL chunk before IDAT.
    const idat = b.indexOf('IDAT', 8, 'latin1');
    const actl = b.indexOf('acTL', 8, 'latin1');
    return { mime: 'image/png', ext: 'png', image: true, animated: actl !== -1 && (idat === -1 || actl < idat) };
  }
  if (s(0, 'GIF8')) return { mime: 'image/gif', ext: 'gif', image: true, animated: gifIsAnimated(b) };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg', image: true, animated: false };
  if (s(0, 'RIFF') && s(8, 'WEBP')) {
    const animated = s(12, 'VP8X') && (b[20] & 0x02) === 0x02;
    return { mime: 'image/webp', ext: 'webp', image: true, animated };
  }
  if (s(4, 'ftypavif') || s(4, 'ftypavis')) return { mime: 'image/avif', ext: 'avif', image: true, animated: s(4, 'ftypavis') };
  if (s(4, 'ftyp')) {
    const brand = b.toString('latin1', 8, 12);
    if (brand.startsWith('qt')) return { mime: 'video/quicktime', ext: 'mov', video: true };
    if (brand.startsWith('M4A')) return { mime: 'audio/mp4', ext: 'm4a', audio: true };
    return { mime: 'video/mp4', ext: 'mp4', video: true };
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { mime: 'video/webm', ext: 'webm', video: true };
  if (s(0, 'OggS')) return { mime: 'audio/ogg', ext: 'ogg', audio: true };
  if (s(0, 'ID3') || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return { mime: 'audio/mpeg', ext: 'mp3', audio: true };
  if (s(0, 'RIFF') && s(8, 'WAVE')) return { mime: 'audio/wav', ext: 'wav', audio: true };
  if (s(0, 'fLaC')) return { mime: 'audio/flac', ext: 'flac', audio: true };
  if (s(0, '%PDF')) return { mime: 'application/pdf', ext: 'pdf' };
  return null;
}

function gifIsAnimated(b) {
  // Count image descriptors; more than one frame means animated.
  let frames = 0;
  for (let i = 0; i < b.length - 1 && frames < 2; i++) {
    if (b[i] === 0x21 && b[i + 1] === 0xf9) frames++;
  }
  return frames > 1;
}

const safeExt = (name) => {
  const e = path.extname(name || '').slice(1).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10);
  return e || 'bin';
};

// Writes a buffer to the uploads dir under a random name and returns metadata.
function store(file, { imagesOnly = false } = {}) {
  const info = sniff(file.buffer);
  if (imagesOnly && !(info && info.image)) fail(400, 'Please upload an image (PNG, JPG, GIF, WebP or AVIF).');
  const id = crypto.randomBytes(12).toString('base64url');
  const ext = info ? info.ext : safeExt(file.originalname);
  const name = `${id}.${ext}`;
  fs.writeFileSync(path.join(config.uploadsDir, name), file.buffer);
  return {
    url: `/uploads/${name}`,
    name: String(file.originalname || name).replace(/[\\/\0]/g, '_').slice(0, 200),
    size: file.size,
    type: info ? info.mime : 'application/octet-stream',
    kind: info?.image ? 'image' : info?.video ? 'video' : info?.audio ? 'audio' : 'file',
    animated: !!info?.animated,
  };
}

function removeUpload(url) {
  if (typeof url !== 'string' || !url.startsWith('/uploads/')) return;
  const name = path.basename(url);
  fs.rm(path.join(config.uploadsDir, name), { force: true }, () => {});
}

const memory = (maxBytes, maxFiles = 1) => multer({ storage: multer.memoryStorage(), limits: { fileSize: maxBytes, files: maxFiles } });

const MIME_BY_EXT = {
  png: 'image/png', gif: 'image/gif', jpg: 'image/jpeg', webp: 'image/webp', avif: 'image/avif',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', ogg: 'audio/ogg', mp3: 'audio/mpeg',
  wav: 'audio/wav', flac: 'audio/flac', m4a: 'audio/mp4', pdf: 'application/pdf',
};
const INLINE = new Set(['png', 'gif', 'jpg', 'webp', 'avif', 'mp4', 'mov', 'webm', 'ogg', 'mp3', 'wav', 'flac', 'm4a']);

// Serves uploads safely: only sniffed media types render inline, everything else downloads.
function serveUploads(req, res, next) {
  const name = path.basename(req.path);
  if (!/^[A-Za-z0-9_-]+\.[a-z0-9]{1,10}$/.test(name)) return next();
  const ext = name.split('.').pop();
  const file = path.join(config.uploadsDir, name);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox");
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  if (INLINE.has(ext)) {
    res.type(MIME_BY_EXT[ext]);
  } else {
    res.type('application/octet-stream');
    const dl = typeof req.query.name === 'string' ? req.query.name.replace(/[^\w.\- ]/g, '_').slice(0, 200) : name;
    res.setHeader('Content-Disposition', `attachment; filename="${dl}"`);
  }
  res.sendFile(file, { dotfiles: 'deny' }, (err) => { if (err) next(); });
}

module.exports = { store, removeUpload, memory, serveUploads, sniff };
