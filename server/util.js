'use strict';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => { throw new HttpError(status, message); };

// Wrap async route handlers so thrown errors reach the error middleware.
const h = (fn) => (req, res, next) => {
  try {
    const r = fn(req, res, next);
    if (r && typeof r.then === 'function') r.catch(next);
  } catch (e) { next(e); }
};

// Simple fixed-window in-memory rate limiter.
const buckets = new Map();
function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < now) { b = { count: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.count++;
  if (b.count > limit) fail(429, `Slow down! Try again in ${Math.ceil((b.reset - now) / 1000)}s.`);
}
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k);
}, 60_000).unref();

const str = (v, { min = 0, max = 2000, name = 'Value', trim = true } = {}) => {
  if (v == null) v = '';
  if (typeof v !== 'string') fail(400, `${name} must be text.`);
  if (trim) v = v.trim();
  if (v.length < min) fail(400, min === 1 ? `${name} is required.` : `${name} must be at least ${min} characters.`);
  if (v.length > max) fail(400, `${name} must be at most ${max} characters.`);
  return v;
};

const toId = (v) => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
};

const parseJSON = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

const COLOR_RE = /^#[0-9a-f]{6}$/i;

// A single unicode emoji, or "c:<id>" for a custom emoji.
const EMOJI_RE = /^(?:c:\d{1,20}|\p{RGI_Emoji}|\p{Extended_Pictographic}\uFE0F?)$/v;
const isEmoji = (v) => typeof v === 'string' && v.length <= 64 && EMOJI_RE.test(v);

module.exports = { HttpError, fail, h, rateLimit, str, toId, parseJSON, COLOR_RE, isEmoji };
