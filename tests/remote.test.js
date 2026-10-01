import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FACILITY, obstacles, isFree } from '../src/facility.js';
import { FacilitySimulation, assessInspection } from '../src/inspection.js';
import { normalizeGo1Command, parseGo1Command } from '../src/remote-commands.js';
import { go1Snapshot, formatGo1Message } from '../src/go1-reports.js';
import { createRemoteControl } from '../bridge/remote-control.js';
import { createTelegramService } from '../bridge/telegram.js';
import { createBridge } from '../bridge/server.js';

const inbound = (messageId = '11', text = 'Go1 CH-02 점검해줘') => ({ messageId, text, chatId: '12345', userId: '12345', threadId: null });
function fixture(options = {}) {
  const messages = [], reports = [];
  const telegram = { authorizeRemote: async raw => raw.chatId === '12345' && raw.userId === '12345',
    notify: async (id, text) => { messages.push({ id, text }); return { delivered: true }; }, send: async raw => { reports.push(raw); return { delivered: true }; } };
  const remote = createRemoteControl({ telegram, persist: false, ...options });
  const clientId = randomUUID(), sim = new FacilitySimulation();
  const poll = (extra = {}) => remote.poll({ clientId, visible: true, busy: false, snapshot: go1Snapshot(sim.s), ackId: null, jobId: null, error: '', ...extra });
  return { remote, messages, reports, clientId, sim, poll, telegram };
}

test('Go1 command grammar selects only known devices and leaves other Hermes conversations alone', () => {
  assert.equal(parseGo1Command('오늘 일정 알려줘'), null);
  for (const text of ['Go1 CH-02 점검해줘', '/go1 inspect CH02', 'Go1 CH2 확인해줘', 'Go1 문제 있는 장비에 가서 이상 유무 보고해줘']) assert.deepEqual(parseGo1Command(text), { action: 'inspect', targetId: 'CH-02' });
  assert.deepEqual(parseGo1Command('Go1 공조 유닛 점검해줘'), { action: 'inspect', targetId: 'AHU-01' });
  for (const text of ['Go1 XYZ-99 점검해줘', 'Go1 CH-02 AHU-01 점검해줘', 'Go1 CH-02 점검하지마', 'Go1 CH-02 점검; powershell', 'Go1 환기 가동해줘']) assert.equal(parseGo1Command(text).action, 'help');
  assert.equal(parseGo1Command('Go1 정지').action, 'stop'); assert.equal(parseGo1Command('Go1 상태 알려줘').action, 'status');
  for (const text of ['Go1 복귀', 'Go1 복귀해줘', 'Go1 돌아와', 'Go1 도킹 위치로 복귀해줘', '/go1 return', '/go1@HermesBot dock']) assert.deepEqual(parseGo1Command(text), { action: 'return' });
  for (const text of ['Go1 복귀하지마', 'Go1 복귀; powershell', 'Go1 복귀 XYZ-99']) assert.equal(parseGo1Command(text).action, 'help');
});

test('Korean spoken name and STT spacing normalize to bounded Go1 commands', () => {
  for (const name of ['고원', '고원아,', '고원 야!', '고 원아', 'Ｇｏ１']) {
    assert.equal(normalizeGo1Command(name + ' 공조 유닛 점검해줘.'), 'Go1 공조 유닛 점검해줘.');
    assert.deepEqual(parseGo1Command(name + ' 공조 유닛 점검해줘.'), { action: 'inspect', targetId: 'AHU-01' });
  }
  assert.deepEqual(parseGo1Command('고원아, 냉각 설비로 가서 이상 유무 확인해 줘.'), { action: 'inspect', targetId: 'CH-02' });
  assert.deepEqual(parseGo1Command('고원아, 복귀해 줘.'), { action: 'return' });
  assert.deepEqual(parseGo1Command('고원아, 상태 알려 줘.'), { action: 'status' });
  assert.deepEqual(parseGo1Command('고원아, 정지해 주세요.'), { action: 'stop' });
  for (const text of ['고원아, 복귀하지 마.', '고원아, 펌프와 탱크 점검해줘.', '고원아, 환기 가동해줘.', '고원아, 정지; shell']) assert.deepEqual(parseGo1Command(text), { action: 'help' });
  for (const text of ['고원에서 날씨 알려줘', '오늘 고원아라고 말했어', '오늘 일정 알려줘', '고원아빠의 일정']) assert.equal(normalizeGo1Command(text), null);
});

test('every facility device can be inspected and returned from without changing ventilation or entering solids', () => {
  for (const asset of FACILITY.assets) {
    const sim = new FacilitySimulation(); sim.startInspection(asset.id, 'normal');
    for (let i = 0; i < 15000 && sim.s.stage !== 'complete'; i++) {
      sim.step(1 / 60); assert.ok(isFree(sim.s.robot.x, sim.s.robot.z, obstacles(sim.s.blocked)), asset.id);
    }
    assert.equal(sim.s.stage, 'complete', asset.id); assert.equal(sim.s.inspection.finding, 'normal');
    assert.equal(sim.s.fan, 35); assert.ok(sim.s.log.some(e => e.tool === 'capture_thermal'));
    assert.ok(!sim.s.log.some(e => ['set_backup_ventilation', 'apply_ventilation'].includes(e.tool)));
    const report = sim.report(); assert.equal(report.inspection.targetId, asset.id);
    assert.match(formatGo1Message({ kind: 'report', snapshot: go1Snapshot(sim.s) }), new RegExp(asset.id));
  }
});

test('inspection distinguishes heat and sensor mismatch without claiming the fault was repaired', () => {
  for (const [profile, finding] of [['heat', 'overheat'], ['sensor', 'sensor_mismatch']]) {
    const sim = new FacilitySimulation(); sim.s.fan = 55; sim.startInspection('CH-02', profile);
    for (let i = 0; i < 15000 && sim.s.stage !== 'complete'; i++) sim.step(1 / 60);
    assert.equal(sim.s.inspection.finding, finding); assert.equal(sim.s.fan, 55);
    assert.match(formatGo1Message({ kind: 'report', snapshot: go1Snapshot(sim.s) }), /환기 조치 없음/);
  }
  assert.equal(assessInspection({ reported: 61, thermal: 59 }), 'unconfirmed');
});

test('remote inspection preserves battery/link restrictions, replans its own goal and freezes on pause', () => {
  const sim = new FacilitySimulation(); sim.setBattery(15); sim.startInspection('AHU-01', 'normal');
  for (let i = 0; i < 200; i++) sim.step(.05);
  assert.equal(sim.s.stage, 'plan'); assert.equal(sim.s.distance, 0);
  sim.setBattery(85); sim.setLink(false); sim.step(.1); assert.equal(sim.s.stage, 'plan');
  sim.setLink(true); sim.step(.1); assert.equal(sim.s.stage, 'navigate');
  sim.toggleBlock(); sim.setLink(false); const pose = { ...sim.s.robot };
  for (let i = 0; i < 10; i++) sim.step(.1);
  assert.deepEqual(sim.s.robot, { ...pose, speed: 0 });
  sim.setLink(true); assert.deepEqual(sim.s.route.at(-1), sim.s.inspection.goal);
  sim.s.paused = true; const time = sim.s.time; sim.step(.1); assert.equal(sim.s.time, time);
});

test('Telegram remote authorization is restricted to the configured recipient and sender/topic', async () => {
  const service = createTelegramService({ configReader: async () => ({ configured: true, chatId: '12345' }) });
  assert.equal(await service.authorizeRemote(inbound()), true);
  assert.equal(await service.authorizeRemote({ ...inbound(), userId: '54321' }), false);
  assert.equal(await service.authorizeRemote({ ...inbound(), chatId: '54321' }), false);
  assert.equal(await service.authorizeRemote({ ...inbound(), threadId: '7' }), false);
  const group = createTelegramService({ configReader: async () => ({ configured: true, chatId: '-10012', allowedUsers: ['12345'], threadId: 7 }) });
  assert.equal(await group.authorizeRemote({ ...inbound(), chatId: '-10012', threadId: '7' }), true);
  assert.equal(await group.authorizeRemote({ ...inbound(), chatId: '-10012', threadId: null }), false);
});

test('remote inbox deduplicates concurrent Telegram updates, rejects outsiders and dispatches to one receiver', async () => {
  const { remote, messages, poll, sim } = fixture(); await poll();
  await assert.rejects(remote.accept({ ...inbound(), userId: '54321' }), /등록한/);
  const [a, b] = await Promise.all([remote.accept(inbound()), remote.accept(inbound())]);
  assert.equal(a.id, b.id); assert.equal(b.duplicate, true); assert.equal(messages.length, 1);
  const dispatch = await poll(); assert.equal(dispatch.command.targetId, 'CH-02');
  await assert.rejects(poll({ clientId: randomUUID() }), /다른 웹/);
  sim.startInspection('CH-02', 'heat'); await poll({ jobId: a.id, snapshot: go1Snapshot(sim.s), busy: true });
  assert.equal((await poll({ jobId: a.id, snapshot: go1Snapshot(sim.s), busy: true })).command, null);
  await remote.accept(inbound('12')); assert.match(messages.at(-1).text, /임무가 진행 중/);
});

test('remote job reports observations and completion, then acknowledges an actual stopped pose', async () => {
  const { remote, poll, sim, reports } = fixture(); await poll(); const command = await remote.accept(inbound());
  sim.startInspection('CH-02', 'heat');
  await poll({ jobId: command.id, snapshot: go1Snapshot(sim.s), busy: true });
  for (let i = 0; i < 10000 && sim.s.stage !== 'return'; i++) sim.step(.05);
  await poll({ jobId: command.id, snapshot: go1Snapshot(sim.s), busy: true });
  assert.equal(reports.length, 1); assert.equal(reports[0].snapshot.finding, 'overheat');
  for (let i = 0; i < 10000 && sim.s.stage !== 'complete'; i++) sim.step(.05);
  await poll({ jobId: command.id, snapshot: go1Snapshot(sim.s) });
  await poll({ jobId: command.id, snapshot: go1Snapshot(sim.s) });
  assert.equal(reports.length, 2); assert.equal(remote.status().mission.state, 'complete');
  const stopped = await remote.accept(inbound('13', 'Go1 정지'));
  assert.equal((await poll()).command.action, 'stop');
  sim.s.paused = true; sim.s.robot.speed = 0;
  await poll({ ackId: stopped.id, snapshot: go1Snapshot(sim.s) });
  assert.equal(reports.at(-1).snapshot.paused, true); assert.equal((await poll()).command, null);
});

test('offline receivers do not queue stale missions; losing a live receiver reports uncertainty', async () => {
  let clock = 1000; const { remote, messages, poll } = fixture({ now: () => clock });
  await remote.accept(inbound()); assert.equal(remote.status().mission, null); assert.match(messages[0].text, /연결되지/);
  await poll(); await remote.accept(inbound('12')); clock += 31000;
  assert.equal(remote.status().mission.state, 'failed');
  await new Promise(resolve => setImmediate(resolve));
  assert.match(messages.at(-1).text, /완료를 확인하지 못/);
});

test('Telegram return takes over a web inspection and reports actual acknowledgement and completion once', async () => {
  const { remote, poll, sim, reports } = fixture();
  sim.startInspection('CH-02', 'heat', { source: 'web', returnPolicy: 'normal_only' });
  for (let i = 0; i < 10000 && sim.s.stage !== 'await_review'; i++) sim.step(.05);
  await poll({ snapshot: go1Snapshot(sim.s), busy: true });
  const command = await remote.accept(inbound('61', 'Go1 복귀'));
  const offered = (await poll({ snapshot: go1Snapshot(sim.s), busy: true })).command;
  assert.equal(offered.action, 'return'); assert.equal(offered.runId, sim.s.runId); assert.equal(offered.targetId, 'CH-02');
  assert.equal(reports.length, 0, 'acceptance is not execution proof');
  sim.returnFromInspection({ remote: true, runId: offered.runId, targetId: offered.targetId });
  const progress = () => poll({ jobId: command.id, ackId: command.id, snapshot: go1Snapshot(sim.s), busy: sim.s.stage !== 'complete' });
  await progress(); await progress();
  assert.equal(reports.length, 1); assert.equal(reports[0].snapshot.stage, 'return');
  for (let i = 0; i < 10000 && sim.s.stage !== 'complete'; i++) sim.step(.05);
  await progress(); await progress();
  assert.equal(reports.length, 2); assert.match(reports[1].id, /:returned$/);
  assert.equal(reports[1].snapshot.finding, 'overheat'); assert.equal(reports[1].snapshot.fan, 35);
  assert.equal(remote.status().mission.state, 'complete');
  await remote.accept(inbound('62', 'Go1 복귀')); assert.equal((await progress()).command, null);
  assert.equal(reports.at(-1).snapshot.stage, 'complete');
});

test('return rejects unsafe conditions and never queues an old return for later recovery', async () => {
  const { remote, poll, sim, messages } = fixture();
  sim.startInspection('CH-02', 'normal'); sim.step(.1); sim.setLink(false);
  await poll({ snapshot: go1Snapshot(sim.s), busy: true });
  await remote.accept(inbound('63', 'Go1 복귀'));
  assert.equal(remote.status().mission, null); assert.match(messages.at(-1).text, /보류/);
  sim.setLink(true); sim.setBattery(15); await poll({ snapshot: go1Snapshot(sim.s), busy: true });
  await remote.accept(inbound('64', 'Go1 복귀'));
  assert.equal(remote.status().mission, null);
  sim.setBattery(85); assert.equal((await poll({ snapshot: go1Snapshot(sim.s), busy: true })).command, null);
  const stop = await remote.accept(inbound('65', 'Go1 정지'));
  await remote.accept(inbound('66', 'Go1 복귀')); assert.equal(remote.status().mission, null);
  assert.equal((await poll({ snapshot: go1Snapshot(sim.s), busy: true })).command.id, stop.id);
});

test('return cannot confirm another run or a waiting robot that never executed the command', async () => {
  for (const changedRun of [false, true]) {
    const { remote, poll, sim, reports } = fixture(); sim.startInspection('CH-02', 'heat');
    await poll({ snapshot: go1Snapshot(sim.s), busy: true });
    const command = await remote.accept(inbound('67', 'Go1 복귀'));
    if (changedRun) {
      sim.reset(); sim.startInspection('CH-02', 'heat'); sim.returnFromInspection({ remote: true });
    }
    await poll({ jobId: command.id, ackId: command.id, snapshot: go1Snapshot(sim.s), busy: true });
    assert.equal(remote.status().mission.state, 'failed'); assert.equal(reports.length, 0);
  }
});

test('remote delivery failures remain visible and are never labelled sent', async () => {
  const telegram = { authorizeRemote: async () => true, notify: async () => { throw Error('발송 결과 확인 필요'); } };
  const remote = createRemoteControl({ telegram, persist: false });
  await remote.accept(inbound('50', 'Go1 도움말'));
  await new Promise(resolve => setImmediate(resolve));
  const status = remote.status();
  assert.equal(status.deliveries[0].state, 'failed'); assert.equal(status.lastError, '발송 결과 확인 필요');
});

test('remote Telegram message IDs survive bridge restart without redispatching', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'facility-inbox-')); t.after(() => rm(root, { force: true, recursive: true }));
  const first = fixture({ root, persist: true }); await first.poll(); const a = await first.remote.accept(inbound());
  const second = fixture({ root, persist: true }); await second.poll(); const b = await second.remote.accept(inbound());
  assert.equal(b.duplicate, true); assert.equal(b.id, a.id); assert.equal(second.remote.status().mission, null); assert.equal(second.messages.length, 0);
});

test('remote HTTP routes require authentication and local origin before accepting commands', async t => {
  const f = fixture(); const server = createBridge({ paths: { codex: null, hermes: null }, telegram: f.telegram, remote: f.remote });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
  const url = 'http://127.0.0.1:' + server.address().port; const health = await (await fetch(url + '/agent/health')).json();
  const post = (extra = {}) => fetch(url + '/agent/remote/telegram', { method: 'POST', headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(inbound()) });
  assert.equal((await post()).status, 403);
  assert.equal((await post({ 'X-Twin-Token': health.token, Origin: 'https://example.com' })).status, 403);
  assert.equal((await post({ 'X-Twin-Token': health.token })).status, 200);
});
