import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, accessSync, realpathSync, constants } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { DECISION_SCHEMA, validateDecision } from '../src/decision.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function validateSnapshot(value) {
  const keys = ['runId', 'target', 'reported', 'thermal', 'reference', 'battery', 'link', 'temperatureAlarm', 'dispatchBatteryMinimum'];
  if (!value || Object.keys(value).sort().join() !== keys.sort().join()) throw Error('관측 필드가 올바르지 않습니다.');
  if (!/^SIM-[A-Z0-9]{1,12}$/.test(value.runId) || value.target !== 'CH-02' || typeof value.link !== 'boolean') throw Error('관측 식별자가 올바르지 않습니다.');
  for (const key of ['reported', 'thermal', 'reference', 'battery', 'temperatureAlarm', 'dispatchBatteryMinimum']) {
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] < 0 || value[key] > 150) throw Error('관측 수치가 올바르지 않습니다.');
  }
  if (value.battery > 100 || value.reference !== 38.4 || value.temperatureAlarm !== 60 || value.dispatchBatteryMinimum !== 20) throw Error('제어 제약을 변경할 수 없습니다.');
  return { ...value };
}

export function parseDecision(raw) {
  const fence = String.fromCharCode(96).repeat(3);
  let text = raw.trim();
  if (text.startsWith(fence)) text = text.slice(3).replace(/^json\s*/, '').trim();
  if (text.endsWith(fence)) text = text.slice(0, -3).trim();
  return JSON.parse(text);
}

function executable(name) {
  const override = process.env[name.toUpperCase() + '_CLI_PATH'];
  const userLocal = process.env.LOCALAPPDATA;
  const candidates = [
    override,
    userLocal && name === 'codex' ? path.join(userLocal, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe') : null,
    userLocal && name === 'hermes' ? path.join(userLocal, 'hermes', 'hermes-agent', 'bin', 'hermes.exe') : null,
    ...(process.env.PATH || '').split(path.delimiter).map(p => path.join(p, name + (process.platform === 'win32' ? '.exe' : ''))),
  ];
  return candidates.find(p => {
    if (!p || !existsSync(p) || process.platform === 'win32' && !p.toLowerCase().endsWith('.exe')) return false;
    try { accessSync(p, constants.X_OK); return true; } catch { return false; }
  }) || null;
}

function killOwnedProcess(child) {
  if (child.exitCode !== null || !child.pid) return;
  if (process.platform === 'win32') {
    const kill = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    kill.on('error', () => child.kill());
  } else child.kill('SIGTERM');
}

export async function runCli(engine, snapshot, paths, signal) {
  const directory = path.join(root, '.runtime', randomUUID());
  await mkdir(directory, { recursive: true });
  const schemaFile = path.join(directory, 'decision.schema.json');
  const resultFile = path.join(directory, 'decision.json');
  await writeFile(schemaFile, JSON.stringify(DECISION_SCHEMA));
  const prompt = 'You are the initial incident-planning component of a facility simulation. Do not use any tools, files, network searches, messages, or other agents. Use only the following observation. Return ONLY a JSON object with action, target, reason. Target must be CH-02. Reason must be concise Korean (under 600 characters). Rules: battery <= 20 => hold_low_battery; otherwise abs(reported - thermal) > 10 => inspect_sensor; otherwise inspect_heat. Heat requires on-site inspection before ventilation changes; a sensor mismatch requires inspection without changing ventilation. These are simulated plans, not real hardware commands. Observation: ' + JSON.stringify(snapshot);
  let command = paths[engine];
  let args = ['exec', '--sandbox', 'read-only', '--ephemeral', '--skip-git-repo-check', '--color', 'never', '--output-schema', schemaFile, '--output-last-message', resultFile, '-'];
  if (engine === 'hermes') {
    const binary = realpathSync(paths.hermes);
    const installRoot = process.env.HERMES_AGENT_ROOT || path.resolve(path.dirname(binary), '..');
    const candidates = [process.env.HERMES_PYTHON_PATH, path.join(installRoot, 'venv', 'Scripts', 'python.exe'), path.join(installRoot, '.venv', 'bin', 'python'), path.join(path.dirname(binary), 'python')];
    command = candidates.find(p => p && existsSync(p));
    if (!command) throw Error('Hermes 설치의 Python 경로를 찾지 못했습니다. HERMES_PYTHON_PATH와 HERMES_AGENT_ROOT를 설정하세요.');
    args = [path.join(root, 'bridge', 'hermes-runner.py'), installRoot];
  }
  const env = { ...process.env };
  env.PYTHONIOENCODING = 'utf-8';
  delete env.HERMES_KANBAN_TASK;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: directory, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', settled = false;
    const finish = (error, value) => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      error ? reject(error) : resolve(value);
    };
    const abort = () => { killOwnedProcess(child); finish(Error('Agent 요청이 취소되었습니다.')); };
    const timer = setTimeout(() => { killOwnedProcess(child); finish(Error('CLI 응답이 120초를 초과했습니다. 로그인과 모델 연결을 확인하세요.')); }, 120000);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on('data', data => { output = (output + data.toString('utf8')).slice(-64000); });
    child.stderr.on('data', () => {});
    child.on('error', () => finish(Error('CLI 실행 파일을 시작하지 못했습니다. 경로 설정을 확인하세요.')));
    child.on('close', code => code === 0 ? finish(null, output) : finish(Error('CLI 실행이 실패했습니다 (종료 코드 ' + code + '). 설치된 CLI의 로그인·모델 설정을 확인하세요.')));
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
  const raw = engine === 'codex' ? await readFile(resultFile, 'utf8') : result;
  let decision;
  try { decision = parseDecision(raw); } catch { throw Error('CLI가 유효한 판단 JSON을 반환하지 않았습니다.'); }
  return validateDecision(decision, snapshot);
}

export function createBridge({ runner = runCli, paths = { codex: executable('codex'), hermes: executable('hermes') } } = {}) {
  const token = randomBytes(32).toString('hex'), jobs = new Map();
  const validToken = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) && timingSafeEqual(Buffer.from(value), Buffer.from(token));
  const local = req => {
    let host;
    try { host = new URL('http://' + req.headers.host); } catch { return false; }
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host.hostname)) return false;
    const origin = req.headers.origin;
    if (!origin) return true;
    return ['http://localhost:5180', 'http://127.0.0.1:5180', 'http://localhost:5181', 'http://127.0.0.1:5181'].includes(origin);
  };
  const json = (res, code, value) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(value));
  };
  const server = http.createServer(async (req, res) => {
    if (!local(req)) return json(res, 403, { error: '로컬 브라우저에서만 CLI를 사용할 수 있습니다.' });
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/agent/health') return json(res, 200, { token, engines: { codex: Boolean(paths.codex), hermes: Boolean(paths.hermes) } });
    if (!validToken(req.headers['x-twin-token'])) return json(res, 403, { error: '브리지 세션 토큰이 필요합니다.' });
    if (req.method === 'POST' && url.pathname === '/agent/jobs') {
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') return json(res, 415, { error: 'JSON 요청이 필요합니다.' });
      if ([...jobs.values()].some(j => j.status === 'running')) return json(res, 409, { error: '이전 Agent 요청이 실행 중입니다. 완료 또는 취소 후 다시 시작하세요.' });
      let size = 0; const chunks = [];
      try {
        for await (const chunk of req) { size += chunk.length; if (size > 4096) throw Error('요청 크기 제한을 초과했습니다.'); chunks.push(chunk); }
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if ([...jobs.values()].some(j => j.status === 'running')) return json(res, 409, { error: '이전 Agent 요청이 실행 중입니다.' });
        if (Object.keys(input).sort().join() !== 'engine,snapshot' || !['codex', 'hermes'].includes(input.engine) || !paths[input.engine]) throw Error('설치된 Codex 또는 Hermes를 선택하세요.');
        const snapshot = validateSnapshot(input.snapshot);
        for (const [id, job] of jobs) if (job.status !== 'running' && jobs.size >= 24) jobs.delete(id);
        const id = randomUUID(), controller = new AbortController(), job = { id, status: 'running', engine: input.engine, controller };
        jobs.set(id, job); json(res, 202, { id, status: job.status });
        Promise.resolve().then(() => runner(input.engine, snapshot, paths, controller.signal)).then(value => { job.decision = validateDecision(value, snapshot); job.status = 'complete'; }).catch(e => { job.error = e.message; job.status = 'failed'; });
      } catch (e) { json(res, 400, { error: e.message }); }
      return;
    }
    const id = url.pathname.match(/^\/agent\/jobs\/([a-f0-9-]{36})$/)?.[1], job = jobs.get(id);
    if (job && req.method === 'DELETE') { job.controller.abort(); return json(res, 200, { cancelled: true }); }
    if (job && req.method === 'GET') return json(res, 200, { id, status: job.status, engine: job.engine, decision: job.decision, error: job.error });
    json(res, 404, { error: 'Agent 요청을 찾을 수 없습니다.' });
  });
  server.on('close', () => { for (const job of jobs.values()) if (job.status === 'running') job.controller.abort(); });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createBridge();
  server.listen(5181, '127.0.0.1', () => console.log('Local agent bridge: http://127.0.0.1:5181 — open http://localhost:5180. No app API key required.'));
  server.on('error', e => { console.error('Bridge could not start:', e.code); process.exitCode = 1; });
  const stop = () => server.close();
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
