// Self-check against the compose stack: `docker compose up -d && node scripts/e2e.mjs`
import assert from 'node:assert/strict';
import { io } from 'socket.io-client';

const BASE = process.env.BASE ?? 'http://localhost:8080';
const post = (path, token, device, body) =>
  fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Device-Id': device },
    body: JSON.stringify(body),
  });
const login = async (userId) => (await (await post('/auth/token', '', '', { userId })).json()).token;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = Date.now(); // fresh users per run
const [alice, bob, carol] = ['alice', 'bob', 'carol'].map((n) => `${n}-${run}`);
const [ta, tb, tc] = await Promise.all([alice, bob, carol].map(login));

function socket(token, deviceId, { ack = true } = {}) {
  const s = io(BASE, { auth: { token, deviceId }, transports: ['websocket'], reconnection: false });
  s.got = [];
  s.on('message', (m, cb) => { s.got.push(m); if (ack) cb({ ok: true }); });
  return new Promise((res) => s.on('connect', () => s.emit('sync', null, (r) => res(Object.assign(s, { replayed: r.replayed })))));
}

// auth: no token -> 401, bad socket token -> disconnected
assert.equal((await fetch(BASE + '/short-poll')).status, 401);
const bad = io(BASE, { auth: { token: 'nope', deviceId: 'x' }, transports: ['websocket'], reconnection: false });
await new Promise((r) => bad.on('disconnect', r));

// cross-instance push: send 6 times so nginx round-robins across both app instances
const phone = await socket(tb, 'phone');
for (let i = 0; i < 6; i++) assert.equal((await post('/messages', ta, 'a1', { to: bob, text: `m${i}` })).status, 201);
await sleep(500);
assert.equal(phone.got.length, 6, 'phone got all 6 across instances');

// per-device acks: phone acked everything, laptop (never connected) still gets all 6; phone gets none
const laptop = await socket(tb, 'laptop');
assert.equal(laptop.replayed, 6);
assert.equal((await socket(tb, 'phone')).replayed, 0);

// read receipt: bob sees a message -> alice (offline!) finds a 'seen' waiting in her inbox
const first = phone.got[0];
assert.equal((await post('/messages/seen', tb, 'phone', { messageId: first.id, from: alice })).status, 201);
assert.equal((await post('/messages/seen', tb, 'phone', { messageId: first.id, from: carol })).status, 404, 'cannot forge a receipt');
const aliceSock = await socket(ta, 'a1');
assert.equal(aliceSock.replayed, 1);
await sleep(300);
assert.equal(aliceSock.got[0].kind, 'seen');
assert.equal(aliceSock.got[0].payload.messageId, first.id);

// SSE replays what the device has not acked
const sse = await fetch(`${BASE}/sse?token=${tb}&device=tablet`);
const reader = sse.body.getReader();
let chunk = '';
while (!chunk.includes('event: message')) chunk += new TextDecoder().decode((await reader.read()).value);

// offline user: send stores + would push; token register works
assert.equal((await post('/messages/push-token', tc, 'p1', { token: 'fcm-token' })).status, 201);
assert.equal((await post('/messages', ta, 'a1', { to: carol, text: 'hello' })).status, 201);

// rate limit
const codes = [];
for (let i = 0; i < 35; i++) codes.push((await post('/messages', ta, 'a1', { to: bob, text: 'x' })).status);
assert.ok(codes.includes(429), 'rate limited');

console.log('ok');
process.exit(0);
