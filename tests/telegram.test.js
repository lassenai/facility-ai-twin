import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { Simulation } from '../src/simulation.js';
import { GO1_REPORT_TOOLS, go1Snapshot, go1Event, formatGo1Message, validateGo1Notice } from '../src/go1-reports.js';
import { createBridge } from '../bridge/server.js';
import { parseEnvFile, readTelegramConfig, createTelegramService, telegramApi } from '../bridge/telegram.js';

const fixture = { configured: true, token: '123456:fixture_token_for_tests_only_12345', chatId: '1234567', source: '테스트 설정', threadId: 17 };
const input = () => ({ id: 'test-notice-001', kind: 'status', snapshot: go1Snapshot(new Simulation().s) });
function serviceFixture(options = {}) {
  const calls = [], sent = [];
  const service = createTelegramService({
    configReader: async () => fixture, intervalMs: 0,
    api: async (config, method, payload) => {
      calls.push(method);
      if (method === 'getMe') return { is_bot: true, username: 'Go1FixtureBot' };
      if (method === 'getChat') return { id: Number(config.chatId), type: 'private', first_name: 'Fixture' };
      sent.push(payload); return { message_id: sent.length, chat: { id: Number(config.chatId) } };
    }, ...options,
  });
  return { service, calls, sent };
}

test('Go1 reports describe sensor inspection and simulated results without claiming physical deployment', () => {
  const sim = new Simulation(); sim.start('sensor');
  for (let i = 0; i < 15000 && sim.s.stage !== 'complete'; i++) sim.step(1 / 60);
  assert.equal(sim.s.stage, 'complete');
  const message = formatGo1Message({ ...input(), kind: 'report', snapshot: go1Snapshot(sim.s) });
  assert.match(message, /가상 Go1/); assert.match(message, /브라우저 시뮬레이션/);
  assert.match(message, /센서 오류/); assert.match(message, /환기 35%/); assert.match(message, /복귀 완료/);
  assert.ok(message.length < 4096);
  const event = sim.s.log.find(e => e.tool === 'capture_thermal');
  assert.doesNotThrow(() => validateGo1Notice({ id: event.id + ':telegram', kind: 'event', snapshot: go1Snapshot(sim.s), event: go1Event(event) }));
});

test('Go1 send requests reject recipient overrides, unknown fields and non-finite telemetry', () => {
  const raw = input();
  assert.throws(() => validateGo1Notice({ ...raw, chat_id: 'another-recipient' }));
  assert.throws(() => validateGo1Notice({ ...raw, text: 'arbitrary message' }));
  assert.throws(() => validateGo1Notice({ ...raw, snapshot: { ...raw.snapshot, temperature: Infinity } }));
  assert.throws(() => validateGo1Notice({ ...raw, snapshot: { ...raw.snapshot, diagnosis: 'x'.repeat(601) } }));
});

test('Go1 automatic reports include Agent classification and the observed ventilation action', () => {
  const sim = new Simulation(); sim.start('heat');
  for (let i = 0; i < 15000 && sim.s.stage !== 'complete'; i++) sim.step(1 / 60);
  assert.equal(sim.s.stage, 'complete');
  const events = sim.s.log.filter(e => GO1_REPORT_TOOLS.has(e.tool));
  assert.ok(events.some(e => e.tool === 'classify_incident'));
  assert.ok(events.some(e => e.tool === 'set_backup_ventilation'));
  for (const event of events) {
    const raw = { id: event.id + ':telegram', kind: 'event', snapshot: go1Snapshot(sim.s), event: go1Event(event) };
    assert.doesNotThrow(() => validateGo1Notice(raw));
    assert.ok(formatGo1Message(raw).length < 4096);
    if (event.tool === 'set_backup_ventilation') {
      assert.match(formatGo1Message(raw), /보조 환기 조치 선택/);
      assert.match(formatGo1Message(raw), /환기 85%/);
    }
  }
});

test('Telegram configuration reuses Hermes home chat and keeps project overrides together', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'facility-telegram-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const hermes = path.join(root, 'hermes'); await mkdir(hermes);
  await writeFile(path.join(hermes, '.env'), 'TELEGRAM_BOT_TOKEN="' + fixture.token + '"\nTELEGRAM_HOME_CHANNEL=' + fixture.chatId + '\nTELEGRAM_HOME_CHANNEL_THREAD_ID=17\n');
  const config = await readTelegramConfig(root, { HERMES_HOME: hermes });
  assert.equal(config.chatId, fixture.chatId); assert.equal(config.threadId, 17);
  assert.equal(config.source, 'Hermes 기본 대화방');
  await writeFile(path.join(root, '.env.local'), 'TWIN_TELEGRAM_BOT_TOKEN=' + fixture.token + '\nTWIN_TELEGRAM_CHAT_ID=-1007654321\n');
  const overridden = await readTelegramConfig(root, { HERMES_HOME: hermes });
  assert.equal(overridden.chatId, '-1007654321'); assert.equal(overridden.threadId, undefined);
  await writeFile(path.join(root, '.env.local'), '');
  const partial = await readTelegramConfig(root, { TWIN_TELEGRAM_CHAT_ID: '123' });
  assert.equal(partial.configured, false);
  assert.equal(parseEnvFile("export TELEGRAM_HOME_CHANNEL='123' # comment").TELEGRAM_HOME_CHANNEL, '123');
});

test('Telegram deduplicates concurrent requests and returns only safe connection metadata', async () => {
  const { service, calls, sent } = serviceFixture();
  const raw = input();
  const [a, b] = await Promise.all([service.send(raw), service.send(raw)]);
  assert.deepEqual(a, b); assert.equal(sent.length, 1);
  assert.equal(sent[0].chat_id, fixture.chatId); assert.equal(sent[0].message_thread_id, 17);
  assert.throws(() => service.send({ ...raw, kind: 'report' }), /전송 ID/);
  const status = await service.status();
  assert.equal(status.connected, true); assert.equal(status.sentCount, 1);
  assert.equal(JSON.stringify(status).includes(fixture.token), false);
  assert.equal('chatId' in status, false);
  assert.deepEqual(calls, ['getMe', 'getChat', 'sendMessage']);
});

test('Telegram sends in order and spaces requests for the shared chat', async () => {
  let clock = 1000; const waits = [], order = [];
  const { service } = serviceFixture({ intervalMs: 3200, now: () => clock, delay: async ms => { waits.push(ms); clock += ms; },
    api: async (config, method, payload) => {
      if (method === 'getMe') return { is_bot: true };
      if (method === 'getChat') return { id: Number(config.chatId), type: 'private' };
      order.push(payload.text); return { message_id: order.length, chat: { id: Number(config.chatId) } };
    },
  });
  await Promise.all([service.send(input()), service.send({ ...input(), id: 'test-notice-002', kind: 'report' })]);
  assert.equal(order.length, 2); assert.deepEqual(waits, [3200]);
  assert.match(order[0], /현재 상태/); assert.match(order[1], /대응 요약/);
});

test('uncertain Telegram send results are not automatically retried or labelled delivered', async () => {
  let attempts = 0;
  const { service } = serviceFixture({ api: async (config, method) => {
    if (method === 'getMe') return { is_bot: true };
    if (method === 'getChat') return { id: Number(config.chatId) };
    attempts++; throw Error('전송 결과 확인 필요');
  } });
  const raw = input();
  await assert.rejects(service.send(raw), /전송 결과/);
  await assert.rejects(service.send(raw), /전송 결과/);
  assert.equal(attempts, 1); assert.equal((await service.status()).sentCount, 0);
});

test('Telegram transport sanitizes network and API errors without exposing bot tokens', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw Error('https://api.telegram.org/bot' + fixture.token); });
  await assert.rejects(telegramApi(fixture, 'sendMessage', {}), error => error.code === 'TELEGRAM_UNCONFIRMED' && !error.message.includes(fixture.token));
});

test('missing Telegram config gives setup guidance and makes no network calls', async () => {
  let calls = 0;
  const service = createTelegramService({ configReader: async () => ({ configured: false, error: '설정 필요' }), api: async () => { calls++; } });
  assert.equal((await service.status()).connected, false);
  await assert.rejects(service.send(input()), /설정 필요/); assert.equal(calls, 0);
});

test('Telegram HTTP endpoints require a local origin and bridge token, validate before sending', async t => {
  const { service, sent } = serviceFixture();
  const server = createBridge({ telegram: service, paths: { codex: null, hermes: null } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = 'http://127.0.0.1:' + server.address().port;
  const health = await (await fetch(url + '/agent/health')).json();
  assert.equal(health.capabilities.telegram, true);
  assert.equal((await fetch(url + '/agent/telegram/status')).status, 403);
  const headers = { 'Content-Type': 'application/json', 'X-Twin-Token': health.token };
  const post = (value, extra = {}) => fetch(url + '/agent/telegram/messages', { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(value) });
  assert.equal((await post(input(), { Origin: 'https://example.com' })).status, 403);
  assert.equal((await post({ ...input(), chat_id: '999' })).status, 400);
  assert.equal((await post(input(), { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal(sent.length, 0);
  const reply = await post(input()); assert.equal(reply.status, 200);
  assert.equal((await reply.json()).delivered, true);
  const status = await (await fetch(url + '/agent/telegram/status', { headers })).json();
  assert.equal(status.sentCount, 1); assert.equal(sent.length, 1);
  assert.equal(JSON.stringify(status).includes(fixture.token), false);
});
