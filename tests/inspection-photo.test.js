import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { FacilitySimulation } from '../src/inspection.js';
import { go1Snapshot } from '../src/go1-reports.js';
import { validateInspectionPhoto, formatInspectionCaption, PHOTO_BODY_LIMIT } from '../bridge/inspection-photo.js';
import { createTelegramService, telegramApi } from '../bridge/telegram.js';
import { createRemoteControl } from '../bridge/remote-control.js';
import { createBridge } from '../bridge/server.js';

const jpeg = await readFile(new URL('./fixtures/inspection.jpg', import.meta.url));
const image = () => ({ dataUrl: 'data:image/jpeg;base64,' + jpeg.toString('base64'), capturedAt: new Date().toISOString() });
const turn = () => new Promise(resolve => setImmediate(resolve));
function observe(sim) {
  while (sim.s.inspection.finding === 'pending') sim.step(1 / 60);
  return go1Snapshot(sim.s);
}
function input(profile = 'heat') {
  const sim = new FacilitySimulation(); sim.startInspection('CH-02', profile);
  return { id: 'photo-fixture-001', snapshot: observe(sim), image: image() };
}
const config = { configured: true, token: '123456:fixture_token_for_tests_only_12345', chatId: '12345', threadId: 17 };
function serviceFixture(send = async () => {}) {
  const calls = [];
  const service = createTelegramService({ intervalMs: 0, configReader: async () => config,
    api: async (settings, method, payload) => {
      if (method === 'getMe') return { is_bot: true };
      if (method === 'getChat') return { id: 12345, type: 'private' };
      calls.push({ method, payload }); await send(method, payload);
      return { message_id: calls.length, chat: { id: 12345 }, ...(method === 'sendPhoto' ? { photo: [{ file_id: 'fixture', width: 16, height: 16 }] } : {}) };
    } });
  return { service, calls };
}
async function remoteFixture({ sendPhoto } = {}) {
  const photos = [], sim = new FacilitySimulation(), clientId = randomUUID();
  const telegram = { authorizeRemote: async () => true, notify: async () => ({ delivered: true }), send: async () => ({ delivered: true }),
    sendPhoto: sendPhoto || (async raw => { photos.push(raw); return { delivered: true }; }) };
  const remote = createRemoteControl({ telegram, persist: false });
  const poll = extra => remote.poll({ clientId, visible: true, busy: false, snapshot: go1Snapshot(sim.s), ackId: null, jobId: null, error: '', ...extra });
  await poll();
  const job = await remote.accept({ messageId: '11', chatId: '12345', userId: '12345', threadId: null, text: '고원아 냉각 설비 점검하고 사진 보내줘' });
  assert.equal(job.action, 'inspect'); sim.startInspection('CH-02', 'heat');
  await poll({ jobId: job.id, ackId: job.id });
  return { sim, clientId, remote, poll, photos, job, telegram };
}

test('inspection JPEG validates observed finding/pose and captions distinguish virtual camera and synthetic readings', () => {
  const raw = input(), result = validateInspectionPhoto(raw);
  assert.equal(result.image.width, 16); assert.deepEqual(result.image.bytes, jpeg);
  const caption = formatInspectionCaption(result);
  for (const pattern of [/가상 Go1/, /CH-02/, /과열 의심/, /64.2°C/, /63.8°C/, /3D 카메라/, /합성 관측/]) assert.match(caption, pattern);
  assert.ok(caption.length < 1024);
  for (const invalid of [
    { ...raw, chat_id: 'another' }, { ...raw, image: { ...raw.image, url: 'https://example.com/' } },
    { ...raw, image: { ...raw.image, dataUrl: 'https://example.com/image.jpg' } },
    { ...raw, image: { ...raw.image, dataUrl: 'data:image/png;base64,' + jpeg.toString('base64') } },
    { ...raw, image: { ...raw.image, dataUrl: raw.image.dataUrl.slice(0, -9) } },
    { ...raw, image: { ...raw.image, dataUrl: 'data:image/jpeg;base64,' + 'a'.repeat(2000024) } },
    { ...raw, image: { ...raw.image, capturedAt: 'yesterday' } },
    { ...raw, snapshot: { ...raw.snapshot, finding: 'pending' } },
    { ...raw, snapshot: { ...raw.snapshot, finding: 'normal' } },
    { ...raw, snapshot: { ...raw.snapshot, robot: { x: -6.2, z: 3.45, speed: 0 } } },
    { ...raw, snapshot: { ...raw.snapshot, paused: true } },
  ]) assert.throws(() => validateInspectionPhoto(invalid));
  const changed = Buffer.from(jpeg), sof = changed.indexOf(Buffer.from([0xff, 0xc0]));
  changed.writeUInt16BE(9000, sof + 7);
  assert.throws(() => validateInspectionPhoto({ ...raw, image: { ...raw.image, dataUrl: 'data:image/jpeg;base64,' + changed.toString('base64') } }), /해상도/);
});

test('photo service uses the fixed Hermes chat/topic, deduplicates and shares ordered text/photo queue', async () => {
  const { service, calls } = serviceFixture(), raw = input();
  const [photo, duplicate] = await Promise.all([service.sendPhoto(raw), service.sendPhoto(raw), service.notify('after-photo-001', '복귀 완료')]);
  assert.deepEqual(photo, duplicate); assert.equal(calls.length, 2);
  assert.equal(calls[0].method, 'sendPhoto'); assert.equal(calls[1].method, 'sendMessage');
  assert.equal(calls[0].payload.chat_id, config.chatId); assert.equal(calls[0].payload.message_thread_id, 17);
  assert.deepEqual(calls[0].payload.photo, jpeg); assert.match(calls[0].payload.filename, /^Go1-CH-02-SIM-/);
  assert.equal(photo.kind, 'photo'); assert.ok(!JSON.stringify(photo).includes(config.token));
  assert.throws(() => service.sendPhoto({ ...raw, image: { ...raw.image, capturedAt: '2026-01-01T00:00:00.000Z' } }), /변경/);
});

test('multipart upload contains a JPEG file, caption and fixed topic; uncertain results are sanitized', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, options) => {
    assert.ok(url.endsWith('/sendPhoto')); assert.ok(options.body instanceof FormData); assert.equal(options.headers, undefined);
    assert.equal(options.body.get('chat_id'), config.chatId); assert.equal(options.body.get('message_thread_id'), '17');
    const file = options.body.get('photo'); assert.equal(file.type, 'image/jpeg'); assert.equal(file.name, 'Go1-test.jpg');
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), jpeg); assert.equal(options.body.get('caption'), '가상 점검');
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
  await telegramApi(config, 'sendPhoto', { chat_id: config.chatId, message_thread_id: 17, caption: '가상 점검', photo: jpeg, filename: 'Go1-test.jpg' });
  globalThis.fetch = async () => { throw Error(config.token); };
  await assert.rejects(telegramApi(config, 'sendPhoto', { photo: jpeg, filename: 'Go1-test.jpg' }), error => {
    assert.match(error.message, /자동으로 재전송하지 않습니다/); assert.ok(!error.message.includes(config.token)); return true;
  });
});

test('remote photo requires observed current job and owner; one image cannot be changed or resent', async () => {
  const f = await remoteFixture();
  const pending = { clientId: f.clientId, jobId: f.job.id, snapshot: go1Snapshot(f.sim.s), image: image() };
  assert.throws(() => f.remote.photo(pending), /관측 사진/);
  const snapshot = observe(f.sim); await f.poll({ jobId: f.job.id, ackId: f.job.id });
  const raw = { ...pending, snapshot, image: image() };
  for (const bad of [{ ...raw, clientId: randomUUID() }, { ...raw, jobId: 'GO1-' + randomUUID() },
    { ...raw, snapshot: { ...snapshot, runId: 'SIM-OTHER' } },
    { ...raw, snapshot: { ...snapshot, reported: 65 } }]) assert.throws(() => f.remote.photo(bad));
  assert.equal(f.remote.photo(raw).duplicate, false); assert.equal(f.remote.photo(raw).duplicate, true);
  assert.throws(() => f.remote.photo({ ...raw, image: { ...raw.image, capturedAt: '2026-01-01T00:00:00.000Z' } }));
  await turn(); assert.equal(f.photos.length, 1); assert.equal(f.remote.status().mission.photo.state, 'sent');
  assert.ok(!JSON.stringify(f.remote.status()).includes('data:image'));
  f.remote.release(f.clientId); assert.throws(() => f.remote.photo(raw));
});

test('early return has no photograph and uncertain photo delivery stays failed without retries', async () => {
  const early = await remoteFixture();
  const returned = await early.remote.accept({ messageId: '12', chatId: '12345', userId: '12345', threadId: null, text: '고원아 복귀해줘' });
  early.sim.returnFromInspection({ remote: true }); await early.poll({ jobId: returned.id, ackId: returned.id });
  assert.throws(() => early.remote.photo({ clientId: early.clientId, jobId: returned.id, snapshot: go1Snapshot(early.sim.s), image: image() }));
  assert.equal(early.photos.length, 0);
  let attempts = 0;
  const failed = await remoteFixture({ sendPhoto: async () => { attempts++; throw Error('사진 수신 확인 불가'); } });
  const snapshot = observe(failed.sim); await failed.poll({ jobId: failed.job.id, ackId: failed.job.id });
  const raw = { clientId: failed.clientId, jobId: failed.job.id, snapshot, image: image() };
  failed.remote.photo(raw); await turn(); failed.remote.photo(raw); await turn();
  assert.equal(attempts, 1); assert.equal(failed.remote.status().mission.photo.state, 'failed');
  assert.equal(failed.remote.status().deliveries.find(d => d.id.endsWith(':photo')).state, 'failed');
  const s = serviceFixture(async () => { throw Error('전송 확인 불가'); }), photo = input();
  await assert.rejects(s.service.sendPhoto(photo)); await assert.rejects(s.service.sendPhoto(photo)); assert.equal(s.calls.length, 1);
});

test('photo HTTP route keeps token/origin and bounded payload controls before delivery', async t => {
  const f = await remoteFixture(), snapshot = observe(f.sim); await f.poll({ jobId: f.job.id, ackId: f.job.id });
  const server = createBridge({ remote: f.remote, telegram: f.telegram, paths: { codex: null, hermes: null } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const health = await (await fetch(base + '/agent/health')).json(); assert.equal(health.capabilities.inspectionPhotos, true);
  const raw = { clientId: f.clientId, jobId: f.job.id, snapshot, image: image() };
  const post = (body, extra = {}) => fetch(base + '/agent/remote/photo', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Twin-Token': health.token, ...extra }, body: JSON.stringify(body) });
  assert.equal((await post(raw, { 'X-Twin-Token': '' })).status, 403);
  assert.equal((await post(raw, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post({ ...raw, chat_id: 'other' })).status, 400);
  assert.equal((await post({ ...raw, image: { ...raw.image, dataUrl: 'a'.repeat(PHOTO_BODY_LIMIT) } })).status, 400);
  assert.equal(f.photos.length, 0);
  assert.equal((await post(raw)).status, 200); await turn(); assert.equal(f.photos.length, 1);
});
