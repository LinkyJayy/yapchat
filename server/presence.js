'use strict';
// Tracks connected sockets per user. Kept separate to avoid circular imports.

const sockets = new Map(); // userId -> Map(socketId -> { active })

function add(userId, socketId) {
  if (!sockets.has(userId)) sockets.set(userId, new Map());
  sockets.get(userId).set(socketId, { active: false });
}
function remove(userId, socketId) {
  const m = sockets.get(userId);
  if (!m) return;
  m.delete(socketId);
  if (!m.size) sockets.delete(userId);
}
function setActive(userId, socketId, active) {
  const s = sockets.get(userId)?.get(socketId);
  if (s) s.active = !!active;
}
const isOnline = (userId) => sockets.has(userId);
const isActive = (userId) => [...(sockets.get(userId)?.values() || [])].some((s) => s.active);

// What other people see.
function statusOf(u) {
  if (!u || !isOnline(u.id)) return 'offline';
  return u.status === 'invisible' ? 'offline' : u.status || 'online';
}

module.exports = { add, remove, setActive, isOnline, isActive, statusOf };
