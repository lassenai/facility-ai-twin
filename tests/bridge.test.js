import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridge, validateSnapshot, parseDecision } from '../bridge/server.js';
import { observation } from '../src/decision.js';
import { Simulation } from '../src/simulation.js';
import { once } from 'node:events';

test('bridge rejects injected fields and modified constraints', () => {
  const snapshot = observation(new Simulation().s);
  assert.deepEqual(validateSnapshot(snapshot), snapshot);
  assert.throws(() => validateSnapshot({ ...snapshot, command: 'anything' }));
  assert.throws(() => validateSnapshot({ ...snapshot, dispatchBatteryMinimum: 0 }));
  assert.throws(() => validateSnapshot({ ...snapshot, reported: NaN }));
  assert.throws(() => parseDecision('shell command'));
});
test('HTTP bridge authenticates, validates, limits concurrent CLI jobs and rejects external origin', async t => {
  let complete, calls = 0;
  const server = createBridge({
    paths: { codex: 'fixture', hermes: null },
    runner: () => { calls++; return new Promise(resolve => { complete = resolve; }); },
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = 'http://127.0.0.1:' + server.address().port;
  const denied = await fetch(url + '/agent/health', { headers: { Origin: 'https://example.com' } });
  assert.equal(denied.status, 403);
  const health = await (await fetch(url + '/agent/health')).json();
  assert.equal(health.engines.codex, true);
  assert.equal((await fetch(url + '/agent/jobs', { method: 'POST' })).status, 403);
  assert.equal((await fetch(url + '/agent/jobs', { method: 'POST', headers: { 'X-Twin-Token': 'Ä'.repeat(64) } })).status, 403);
  const sim = new Simulation(); sim.start('sensor'); const snapshot = observation(sim.s);
  const headers = { 'Content-Type': 'application/json', 'X-Twin-Token': health.token };
  const post = data => fetch(url + '/agent/jobs', { method: 'POST', headers, body: JSON.stringify(data) });
  assert.equal((await post({ engine: 'shell', snapshot })).status, 400);
  const response = await post({ engine: 'codex', snapshot }); assert.equal(response.status, 202);
  const job = await response.json();
  assert.equal((await post({ engine: 'codex', snapshot })).status, 409); assert.equal(calls, 1);
  complete({ action: 'inspect_sensor', target: 'CH-02', reason: '두 관측이 일치하지 않습니다.' });
  await new Promise(resolve => setTimeout(resolve, 10));
  const result = await (await fetch(url + '/agent/jobs/' + job.id, { headers })).json();
  assert.equal(result.status, 'complete'); assert.equal(result.decision.action, 'inspect_sensor');
});
