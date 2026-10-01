import test from 'node:test';
import assert from 'node:assert/strict';
import { FacilitySimulation } from '../src/inspection.js';
import { FACILITY, isFree, obstacles } from '../src/facility.js';
import { go1Snapshot, formatGo1Message, validateGo1Notice } from '../src/go1-reports.js';

const web = { source: 'web', returnPolicy: 'normal_only' };
function advance(sim, until) {
  for (let i = 0; i < 15000 && !until(sim.s); i++) {
    sim.step(1 / 60);
    assert.ok(isFree(sim.s.robot.x, sim.s.robot.z, obstacles(sim.s.blocked)));
  }
  assert.ok(until(sim.s), 'inspection reached its expected stage');
}

test('web inspection of each normal device reports observations before autonomously returning', () => {
  for (const asset of FACILITY.assets) {
    const sim = new FacilitySimulation(); sim.startInspection(asset.id, 'normal', web);
    assert.equal(sim.s.inspection.finding, 'pending');
    advance(sim, s => s.stage === 'return');
    assert.equal(sim.s.inspection.finding, 'normal');
    assert.match(sim.s.next, /자동 복귀/);
    assert.ok(sim.s.log.some(e => e.tool === 'inspection_result'));
    advance(sim, s => s.stage === 'complete');
    assert.ok(Math.hypot(sim.s.robot.x - FACILITY.dock.x, sim.s.robot.z - FACILITY.dock.z) < .4);
    assert.equal(sim.s.fan, 35);
    assert.ok(!sim.s.log.some(e => e.tool === 'request_inspection_return'));
  }
});

test('abnormal web observations are reported and hold the robot at the inspection point', () => {
  for (const [profile, finding] of [['heat', 'overheat'], ['sensor', 'sensor_mismatch']]) {
    const sim = new FacilitySimulation(); sim.startInspection('CH-02', profile, web);
    advance(sim, s => s.stage === 'await_review');
    assert.equal(sim.s.inspection.finding, finding);
    const pose = { ...sim.s.robot };
    for (let i = 0; i < 1800; i++) sim.step(1 / 60);
    assert.deepEqual(sim.s.robot, { ...pose, speed: 0 });
    assert.deepEqual(sim.getDriveCommand(), { forward: 0, turn: 0 });
    assert.equal(sim.report().completed, false);
    assert.equal(sim.s.log.filter(e => e.tool === 'inspection_result').length, 1);
    assert.equal(sim.s.fan, 35);
  }
});

test('acknowledged return preserves the abnormal finding and still enforces connection, battery and pause', () => {
  const sim = new FacilitySimulation();
  assert.throws(() => sim.returnFromInspection(), /기다리는/);
  sim.startInspection('CH-02', 'heat', web); advance(sim, s => s.stage === 'await_review');
  sim.setLink(false); assert.throws(() => sim.returnFromInspection(), /복구/);
  sim.setLink(true); sim.setBattery(15); assert.throws(() => sim.returnFromInspection(), /복구/);
  sim.setBattery(85); sim.s.paused = true; assert.throws(() => sim.returnFromInspection(), /복구/);
  sim.s.paused = false; sim.returnFromInspection();
  assert.equal(sim.s.stage, 'return');
  advance(sim, s => s.stage === 'complete');
  assert.equal(sim.s.inspection.finding, 'overheat'); assert.equal(sim.s.fan, 35);
  assert.equal(sim.s.log.filter(e => e.tool === 'request_inspection_return').length, 1);
  assert.throws(() => sim.returnFromInspection(), /기다리는/);
});

test('uncertain readings also hold for review and create a valid Telegram report with the actual waiting state', () => {
  const sim = new FacilitySimulation(); sim.startInspection('CH-02', 'normal', web);
  sim.s.inspection.readings.reported = 61; sim.s.inspection.readings.thermal = 59;
  advance(sim, s => s.stage === 'await_review');
  assert.equal(sim.s.inspection.finding, 'unconfirmed'); assert.equal(sim.s.verified, false);
  const notice = { id: 'web-report-test', kind: 'report', snapshot: go1Snapshot(sim.s) };
  validateGo1Notice(notice);
  assert.match(formatGo1Message(notice), /현장 점검에서 이상을 발견했습니다/);
  assert.doesNotMatch(formatGo1Message(notice), /복귀 완료/);
});

test('remote return can interrupt navigation and explicitly reports an unfinished inspection', () => {
  const sim = new FacilitySimulation(); sim.startInspection('CH-02', 'heat', web);
  advance(sim, s => s.stage === 'navigate');
  for (let i = 0; i < 240; i++) sim.step(1 / 60);
  sim.returnFromInspection({ remote: true, runId: sim.s.runId, targetId: 'CH-02' });
  advance(sim, s => s.stage === 'complete');
  assert.equal(sim.s.inspection.finding, 'pending'); assert.equal(sim.s.verified, false);
  assert.match(sim.s.next, /현장 점검은 미완료/);
  assert.equal(sim.s.fan, 35);
  assert.match(formatGo1Message({ kind: 'report', snapshot: go1Snapshot(sim.s) }), /현장 점검 미완료/);
});

test('remote return can resume an explicitly stopped inspection but cannot override a physics fault or another run', () => {
  const sim = new FacilitySimulation(); sim.startInspection('CH-02', 'heat', web);
  advance(sim, s => s.stage === 'await_review'); sim.s.paused = true;
  assert.throws(() => sim.returnFromInspection({ remote: true, runId: 'SIM-ANOTHER' }), /바뀌었습니다/);
  assert.throws(() => sim.returnFromInspection({ remote: true, targetId: 'AHU-01' }), /바뀌었습니다/);
  sim.returnFromInspection({ remote: true, runId: sim.s.runId, targetId: 'CH-02' });
  assert.equal(sim.s.paused, false); assert.equal(sim.s.inspection.remoteReturn, true);
  sim.physicsFailure('test physics fault');
  assert.throws(() => sim.returnFromInspection({ remote: true }), /물리 실행 오류/);
  assert.equal(sim.s.paused, true);
});
