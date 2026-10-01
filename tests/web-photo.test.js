import test from 'node:test';
import assert from 'node:assert/strict';
import { FacilitySimulation } from '../src/inspection.js';
import { FACILITY } from '../src/facility.js';
import { inspectionPhotoSnapshot } from '../src/inspection-photo.js';
import { observation } from '../src/decision.js';

function advance(sim, predicate) {
  for (let i = 0; i < 12000 && !predicate(sim.s); i++) sim.step(1 / 60);
  assert.ok(predicate(sim.s), sim.s.stage);
}

test('rules response publishes the actual arrival readings and preserves them after cooling and return', () => {
  const sim = new FacilitySimulation(); sim.start('heat');
  assert.equal(inspectionPhotoSnapshot(sim.s), null);
  advance(sim, s => s.stage === 'inspect');
  const snapshot = inspectionPhotoSnapshot(sim.s);
  assert.ok(snapshot); assert.equal(snapshot.mission, 'response'); assert.equal(snapshot.agentMode, 'rules');
  assert.equal(snapshot.finding, 'overheat'); assert.equal(snapshot.reported, +sim.s.reported.toFixed(2));
  assert.ok(Math.hypot(snapshot.robot.x - FACILITY.inspection.x, snapshot.robot.z - FACILITY.inspection.z) < .6);
  const preserved = structuredClone(snapshot);
  advance(sim, s => s.stage === 'complete');
  assert.equal(inspectionPhotoSnapshot(sim.s), null);
  assert.deepEqual(snapshot, preserved); assert.ok(sim.s.temperature < 45);
  assert.ok(snapshot.reported > 60); assert.equal(snapshot.fan, 35); assert.equal(sim.s.fan, 85);
});

test('sensor mismatch photograph records the pre-calibration observations rather than a later normal state', () => {
  const sim = new FacilitySimulation(); sim.start('sensor'); advance(sim, s => s.stage === 'inspect');
  const snapshot = inspectionPhotoSnapshot(sim.s);
  assert.equal(snapshot.finding, 'sensor_mismatch'); assert.ok(snapshot.reported - snapshot.thermal > 30);
  advance(sim, s => s.stage === 'complete');
  assert.equal(sim.s.reported, sim.s.temperature); assert.ok(snapshot.reported > sim.s.reported + 30);
});

test('photo capture is gated by an observed arrival and a live safe pose, for response and standalone inspections', () => {
  const sim = new FacilitySimulation(); sim.start('heat'); advance(sim, s => s.stage === 'inspect');
  for (const mutate of [s => { s.link = false; }, s => { s.paused = true; }, s => { s.physicsError = true; },
    s => { s.robot.x = FACILITY.dock.x; s.robot.z = FACILITY.dock.z; }, s => { s.log = []; }]) {
    const state = structuredClone(sim.s); mutate(state); assert.equal(inspectionPhotoSnapshot(state), null);
  }
  const standalone = new FacilitySimulation(); standalone.startInspection('AHU-01', 'normal', { source: 'web', returnPolicy: 'normal_only' });
  advance(standalone, s => s.stage === 'inspect'); assert.equal(inspectionPhotoSnapshot(standalone.s), null);
  advance(standalone, s => s.inspection.finding === 'normal');
  assert.equal(inspectionPhotoSnapshot(standalone.s).targetId, 'AHU-01');
});

test('CLI-assisted responses use the same observation gate and retain the selected agent source', () => {
  for (const mode of ['codex', 'hermes']) {
    const sim = new FacilitySimulation(); sim.s.agentMode = mode; sim.start('heat');
    advance(sim, s => s.agentPending); assert.equal(inspectionPhotoSnapshot(sim.s), null);
    sim.acceptDecision({ action: 'inspect_heat', target: 'CH-02', reason: '관측을 확인하고 현장 점검을 요청합니다.' }, observation(sim.s));
    advance(sim, s => s.stage === 'inspect');
    const snapshot = inspectionPhotoSnapshot(sim.s); assert.equal(snapshot.agentMode, mode); assert.equal(snapshot.finding, 'overheat');
  }
});
