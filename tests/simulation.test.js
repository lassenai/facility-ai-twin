import test from 'node:test';
import assert from 'node:assert/strict';
import { Simulation } from '../src/simulation.js';
import { FACILITY, obstacles, clearSegment, findPath, isFree } from '../src/facility.js';
import { observation } from '../src/decision.js';

function until(sim, predicate, seconds = 180) {
  for (let i = 0; i < seconds * 10 && !predicate(sim.s); i++) sim.step(.1);
  assert.ok(predicate(sim.s), 'Expected state was not reached: ' + sim.s.stage);
}
test('heat: inspect before ventilation, verify and return, preserve recorded evidence', () => {
  const sim = new Simulation(); sim.start('heat');
  const first = structuredClone(sim.s.log[0]);
  until(sim, s => s.stage === 'inspect');
  assert.equal(sim.s.fan, 35);
  until(sim, s => s.stage === 'complete');
  assert.ok(sim.s.verified); assert.equal(sim.s.fan, 85);
  assert.ok(sim.s.temperature < 45); assert.ok(sim.s.baseline > 90);
  assert.ok(Math.hypot(sim.s.robot.x - FACILITY.dock.x, sim.s.robot.z - FACILITY.dock.z) < .4);
  assert.deepEqual(sim.s.log[0], first);
  const report = sim.report(); report.evidence[0].title = 'changed';
  assert.notEqual(sim.s.log[0].title, 'changed');
});
test('sensor mismatch: confirm, keep fan unchanged and never issue ventilation command', () => {
  const sim = new Simulation(); sim.start('sensor');
  until(sim, s => s.stage === 'complete');
  assert.equal(sim.s.fan, 35); assert.equal(sim.s.temperature, 38.4);
  assert.ok(sim.s.sensorConfirmed); assert.ok(sim.s.verified);
  assert.ok(!sim.s.log.some(e => e.tool === 'set_backup_ventilation'));
});
test('blocked corridor: replan a collision-free path and finish without entering solids', () => {
  const sim = new Simulation(); sim.start('heat');
  until(sim, s => s.stage === 'navigate');
  const original = structuredClone(sim.s.route); sim.toggleBlock();
  assert.equal(sim.s.blocked, true); assert.equal(sim.s.replan, 1);
  assert.notDeepEqual(sim.s.route, original);
  for (let i = 1; i < sim.s.route.length; i++) assert.ok(clearSegment(sim.s.route[i - 1], sim.s.route[i], obstacles(true)));
  for (let i = 0; i < 1800 && sim.s.stage !== 'complete'; i++) {
    sim.step(.1); assert.ok(isFree(sim.s.robot.x, sim.s.robot.z, obstacles(true)));
  }
  assert.equal(sim.s.stage, 'complete');
});
test('link scenario stops in place, resumes after explicit reconnection', () => {
  const sim = new Simulation(); sim.start('link');
  until(sim, s => !s.link);
  const pose = { ...sim.s.robot };
  for (let i = 0; i < 100; i++) sim.step(.1);
  assert.deepEqual(sim.getDriveCommand(), { forward: 0, turn: 0 });
  assert.equal(sim.s.robot.x, pose.x); assert.equal(sim.s.robot.z, pose.z);
  assert.equal(sim.s.safeStops, 1);
  sim.setLink(true); until(sim, s => s.stage === 'complete');
});
test('battery constraint prevents dispatch and stops an active drive until restored', () => {
  const sim = new Simulation(); sim.setBattery(15); sim.start('heat');
  for (let i = 0; i < 150; i++) sim.step(.1);
  assert.equal(sim.s.stage, 'plan'); assert.equal(sim.s.robot.x, FACILITY.dock.x);
  sim.setBattery(85); until(sim, s => s.stage === 'navigate');
  for (let i = 0; i < 20; i++) sim.step(.1);
  sim.setBattery(15); const pose = { ...sim.s.robot };
  for (let i = 0; i < 40; i++) sim.step(.1);
  assert.equal(sim.s.robot.x, pose.x); assert.equal(sim.s.robot.z, pose.z);
  sim.setBattery(85); until(sim, s => s.stage === 'complete');
});
test('pause freezes simulation; reset clears all evidence and counterfactual', () => {
  const sim = new Simulation(); sim.start();
  sim.step(.1); sim.s.paused = true; const state = structuredClone(sim.s);
  sim.step(.1); assert.deepEqual(sim.s, state);
  sim.reset(); assert.equal(sim.s.log.length, 0); assert.equal(sim.s.stage, 'idle');
});
test('local agent waits with clock frozen, validates a plan and rejects incompatible output', () => {
  const sim = new Simulation(); sim.s.agentMode = 'codex'; sim.start('sensor');
  until(sim, s => s.agentPending);
  const input = observation(sim.s), time = sim.s.time;
  sim.step(.1); assert.equal(sim.s.time, time);
  assert.equal(sim.acceptDecision({ action: 'inspect_heat', target: 'CH-02', reason: '잘못된 판단' }, input), false);
  assert.ok(sim.s.paused); assert.ok(sim.s.agentError);
  sim.reset(); sim.s.agentMode = 'codex'; sim.start('sensor');
  until(sim, s => s.agentPending);
  assert.ok(sim.acceptDecision({ action: 'inspect_sensor', target: 'CH-02', reason: '독립 관측과 온도 센서가 달라 점검이 필요합니다.' }, observation(sim.s)));
  until(sim, s => s.stage === 'complete');
  assert.match(sim.report().agent, /codex CLI/);
});
test('unreachable goal returns no route, unsafe corners are excluded', () => {
  assert.deepEqual(findPath(FACILITY.dock, { x: 4.8, z: -2.6 }, obstacles()), []);
  const path = findPath(FACILITY.dock, FACILITY.inspection, obstacles(true));
  assert.ok(path.length >= 3);
  for (let i = 1; i < path.length; i++) assert.ok(clearSegment(path[i-1], path[i], obstacles(true)));
});
test('fine time steps complete the obstructed return path and connect a boundary pose to a safe grid cell', () => {
  const sim = new Simulation(); sim.start();
  for (let i = 0; i < 360; i++) sim.step(1/60);
  sim.toggleBlock();
  for (let i = 0; i < 7200 && sim.s.stage !== 'complete'; i++) {
    sim.step(1/60); assert.ok(isFree(sim.s.robot.x, sim.s.robot.z, obstacles(true)));
  }
  assert.equal(sim.s.stage, 'complete');
  assert.ok(sim.s.replan <= 3, 'Path tracking should not repeatedly stop at a corner');
  const nearBoundary = { x: 1.2856, z: 2.2125 };
  const path = findPath(nearBoundary, FACILITY.dock, obstacles(true));
  assert.ok(path.length);
  for (let i=1;i<path.length;i++) assert.ok(clearSegment(path[i-1],path[i],obstacles(true)));
});
