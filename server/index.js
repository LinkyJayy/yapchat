'use strict';
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const config = require('./config');
const { get } = require('./db');
const gateway = require('./gateway');
const uploads = require('./uploads');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

const PUBLIC = path.join(__dirname, '..', 'public');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self)');
  next();
});

app.get('/api/health', (_req, res) => res.json({ ok: true, name: 'Yapper' }));
app.get('/api/config', (_req, res) => res.json({ registration_open: config.registrationOpen }));

app.use('/api', express.json({ limit: '1mb' }));
app.use('/api', require('./routes/users'));
app.use('/api', require('./routes/servers'));
app.use('/api', require('./routes/channels'));
app.use('/api', (_req, _res, next) => next(Object.assign(new Error('Not found.'), { status: 404 })));

// Custom emoji images by id.
app.get(/^\/emoji\/(\d+)$/, (req, res, next) => {
  const e = get('SELECT file FROM emojis WHERE id = ?', Number(req.params[0]) || 0);
  if (!e) return res.status(404).end();
  req.url = '/' + path.basename(e.file);
  uploads.serveUploads(req, res, next);
});
app.use('/uploads', uploads.serveUploads);

// The service worker must never be cached by the HTTP cache.
app.get('/sw.js', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Service-Worker-Allowed', '/');
  res.sendFile(path.join(PUBLIC, 'sw.js'));
});

app.use(express.static(PUBLIC, {
  index: false,
  setHeaders(res, file) {
    if (file.includes(`${path.sep}emoji${path.sep}3d${path.sep}`) || file.includes(`${path.sep}icons${path.sep}`)) {
      res.setHeader('Cache-Control', 'public, max-age=2592000');
    } else res.setHeader('Cache-Control', 'no-cache');
  },
}));

// SPA fallback.
const indexHtml = path.join(PUBLIC, 'index.html');
app.get(/^\/(?!api\/|uploads\/|emoji\/).*/, (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "connect-src 'self' ws: wss:",
    "worker-src 'self'",
    "frame-ancestors 'none'",
  ].join('; '));
  res.sendFile(indexHtml);
});

// Errors.
app.use((err, _req, res, _next) => {
  let status = err.status || 500;
  let message = err.message || 'Something went wrong.';
  if (err.code === 'LIMIT_FILE_SIZE') { status = 413; message = 'That file is too big.'; }
  else if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') { status = 400; message = 'Too many files.'; }
  else if (err.type === 'entity.parse.failed') { status = 400; message = 'Invalid JSON.'; }
  if (status >= 500) { console.error(err); message = 'Something went wrong on our end.'; }
  res.status(status).json({ error: message });
});

const server = http.createServer(app);
gateway.setup(server);

if (require.main === module) {
  server.listen(config.port, () => {
    console.log(`Yapper is running on http://localhost:${config.port}`);
    console.log(`Data directory: ${config.dataDir}`);
  });
}

module.exports = { app, server };
