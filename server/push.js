'use strict';
const webpush = require('web-push');
const { all, run, getSetting, setSetting } = require('./db');
const config = require('./config');

// VAPID keys: use env if provided, otherwise generate once and persist in the database.
let publicKey = process.env.VAPID_PUBLIC_KEY;
let privateKey = process.env.VAPID_PRIVATE_KEY;
if (!publicKey || !privateKey) {
  const stored = getSetting('vapid');
  if (stored) ({ publicKey, privateKey } = JSON.parse(stored));
  else {
    ({ publicKey, privateKey } = webpush.generateVAPIDKeys());
    setSetting('vapid', JSON.stringify({ publicKey, privateKey }));
  }
}
webpush.setVapidDetails(config.vapidSubject, publicKey, privateKey);

function subscribe(userId, sub) {
  if (!sub || typeof sub.endpoint !== 'string' || !sub.keys?.p256dh || !sub.keys?.auth) return false;
  if (!/^https:\/\//.test(sub.endpoint) || sub.endpoint.length > 1000) return false;
  run(`INSERT INTO push_subscriptions (endpoint, user_id, keys, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, keys = excluded.keys`,
    sub.endpoint, userId, JSON.stringify({ p256dh: sub.keys.p256dh, auth: sub.keys.auth }), Date.now());
  return true;
}
function unsubscribe(endpoint) {
  run('DELETE FROM push_subscriptions WHERE endpoint = ?', String(endpoint || ''));
}

async function send(userId, payload) {
  const subs = all('SELECT endpoint, keys FROM push_subscriptions WHERE user_id = ?', userId);
  const body = JSON.stringify(payload);
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: JSON.parse(s.keys) }, body, { TTL: 60 * 60, urgency: 'high' });
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) unsubscribe(s.endpoint);
    }
  }));
}

module.exports = { publicKey: () => publicKey, subscribe, unsubscribe, send };
