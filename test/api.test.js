'use strict';
// End-to-end API tests: run with `npm test`.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yapper-test-'));
delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
const { server } = require('../server/index.js');

let base;
before(() => new Promise((resolve) => server.listen(0, () => { base = `http://localhost:${server.address().port}/api`; resolve(); })));
after(() => { server.close(); server.closeAllConnections?.(); });

async function call(method, p, token, body) {
  const res = await fetch(base + p, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const register = async (username) => (await call('POST', '/auth/register', null, { username, password: 'password123' })).body.token;

test('accounts, PIN servers, messages, roles and moderation', async () => {
  const owner = await register('owner');
  const member = await register('member');
  const outsider = await register('outsider');

  assert.equal((await call('POST', '/auth/register', null, { username: 'owner', password: 'password123' })).status, 409);
  assert.equal((await call('POST', '/auth/login', null, { username: 'owner', password: 'nope' })).status, 401);

  const s = (await call('POST', '/servers', owner, { name: 'Test Server' })).body;
  assert.match(s.pin, /^\d{8}$/);
  const general = s.channels.find((c) => c.type === 'text');

  // Wrong PIN fails, right PIN joins; the PIN is hidden from regular members.
  assert.equal((await call('POST', '/servers/join', member, { pin: '00000000' === s.pin ? '11111111' : '00000000' })).status, 404);
  const joined = (await call('POST', '/servers/join', member, { pin: s.pin })).body;
  assert.equal(joined.id, s.id);
  assert.equal(joined.pin, undefined);

  // Outsiders can't read channels.
  assert.equal((await call('GET', `/channels/${general.id}/messages`, outsider)).status, 404);

  const msg = (await call('POST', `/channels/${general.id}/messages`, member, { content: 'hi <@' + s.owner_id + '> 👋' })).body;
  assert.deepEqual(msg.mentions, [s.owner_id]);
  const ownerMsg = (await call('POST', `/channels/${general.id}/messages`, owner, { content: 'welcome!' })).body;

  // Members can't delete other people's messages or manage the server.
  assert.equal((await call('DELETE', `/channels/${general.id}/messages/${ownerMsg.id}`, member)).status, 403);
  assert.equal((await call('PATCH', `/servers/${s.id}`, member, { name: 'hacked' })).status, 403);
  assert.equal((await call('POST', `/servers/${s.id}/pin`, member)).status, 403);

  // Reactions + polls.
  assert.equal((await call('PUT', `/channels/${general.id}/messages/${msg.id}/reactions/${encodeURIComponent('🔥')}`, owner)).status, 200);
  const poll = (await call('POST', `/channels/${general.id}/messages`, owner, { poll: { question: 'Q?', options: [{ text: 'A' }, { text: 'B' }], duration: 24 } })).body;
  assert.equal(poll.type, 'poll');
  assert.equal((await call('PUT', `/channels/${general.id}/messages/${poll.id}/poll`, member, { answers: [1] })).status, 200);
  const list = (await call('GET', `/channels/${general.id}/messages`, member)).body;
  assert.deepEqual(list.find((m) => m.id === poll.id).poll.votes[1].length, 1);
  assert.equal(list.find((m) => m.id === msg.id).reactions[0].emoji, '🔥');

  // Roles: grant Manage Messages, then the member can delete.
  const role = (await call('POST', `/servers/${s.id}/roles`, owner, { name: 'Mod' })).body;
  await call('PATCH', `/servers/${s.id}/roles/${role.id}`, owner, { permissions: (1 << 12) | 1 | 2 | 4 });
  const memberId = joined.me.user.id;
  assert.equal((await call('PATCH', `/servers/${s.id}/members/${memberId}`, owner, { roles: [role.id] })).status, 200);
  assert.equal((await call('DELETE', `/channels/${general.id}/messages/${ownerMsg.id}`, member)).status, 200);
  // ...but still can't kick the owner or ban anyone.
  assert.equal((await call('DELETE', `/servers/${s.id}/members/${s.owner_id}`, member)).status, 403);

  // Private channel hidden from members.
  const secret = (await call('POST', `/servers/${s.id}/channels`, owner, { name: 'secret', type: 'text', private: true })).body;
  assert.equal((await call('GET', `/channels/${secret.id}/messages`, member)).status, 404);

  // Ban prevents rejoining with the PIN.
  assert.equal((await call('PUT', `/servers/${s.id}/bans/${memberId}`, owner, { reason: 'test' })).status, 200);
  assert.equal((await call('POST', '/servers/join', member, { pin: s.pin })).status, 403);

  // Audit log recorded actions.
  const log = (await call('GET', `/servers/${s.id}/audit-log`, owner)).body.map((a) => a.action);
  assert.ok(log.includes('member_ban') && log.includes('role_create'));
});

test('friends and DMs', async () => {
  const a = await register('ann');
  const b = await register('ben');
  assert.equal((await call('POST', '/relationships', a, { username: 'ben' })).status, 200);
  const bId = (await call('GET', '/ready', b)).body.user.id;
  const aId = (await call('GET', '/ready', a)).body.user.id;
  assert.equal((await call('POST', '/relationships', b, { user_id: aId })).status, 200);
  const rel = (await call('GET', '/ready', a)).body.relationships;
  assert.equal(rel[0].type, 'friend');
  const dm = (await call('POST', '/dms', a, { recipient: bId })).body;
  assert.equal((await call('POST', `/channels/${dm.id}/messages`, a, { content: 'yo' })).status, 200);
  // Blocking stops DMs.
  await call('PUT', `/relationships/${aId}/block`, b);
  assert.equal((await call('POST', `/channels/${dm.id}/messages`, a, { content: 'yo?' })).status, 403);
});
