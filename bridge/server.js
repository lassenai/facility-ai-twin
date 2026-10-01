import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, accessSync, realpathSync, constants } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { DECISION_SCHEMA, validateDecision } from '../src/decision.js';
import { createTelegramService } from './telegram.js';
import { createRemoteControl } from './remote-control.js';
import { PHOTO_BODY_LIMIT } from './inspection-photo.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE_SERVICE = 'facility-ai-twin-agent-bridge';
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

export function createBridge({ runner = runCli, paths = { codex: executable('codex'), hermes: executable('hermes') }, telegram = createTelegramService({ root }), remote = createRemoteControl({ telegram, root }) } = {}) {
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
    if (req.method === 'GET' && url.pathname === '/agent/health') return json(res, 200, { service: BRIDGE_SERVICE, capabilities: { telegram: true, remoteCommands: true, inspectionPhotos: true }, token, engines: { codex: Boolean(paths.codex), hermes: Boolean(paths.hermes) } });
    if (!validToken(req.headers['x-twin-token'])) return json(res, 403, { error: '브리지 세션 토큰이 필요합니다.' });
    if (req.method === 'GET' && url.pathname === '/agent/remote/status') return json(res, 200, remote.status());
    if (req.method === 'POST' && ['/agent/remote/telegram', '/agent/remote/poll', '/agent/remote/release', '/agent/remote/photo'].includes(url.pathname)) {
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') return json(res, 415, { error: 'JSON 요청이 필요합니다.' });
      try {
        let size = 0; const chunks = [];
        const limit = url.pathname.endsWith('/photo') ? PHOTO_BODY_LIMIT : 8192;
        for await (const chunk of req) { size += chunk.length; if (size > limit) throw Error('Go1 요청 크기 제한을 초과했습니다.'); chunks.push(chunk); }
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (url.pathname.endsWith('/telegram')) return json(res, 200, await remote.accept(input));
        if (url.pathname.endsWith('/poll')) return json(res, 200, await remote.poll(input));
        if (url.pathname.endsWith('/photo')) return json(res, 200, remote.photo(input));
        if (!input || Object.keys(input).join() !== 'clientId' || !/^[a-f0-9-]{36}$/.test(input.clientId)) throw Error('Go1 점검 화면 식별자가 올바르지 않습니다.');
        return json(res, 200, remote.release(input.clientId));
      } catch (error) { return json(res, error.code === 'REMOTE_DENIED' ? 403 : error.code === 'REMOTE_BUSY' ? 409 : 400, { error: error.message }); }
    }
    if (req.method === 'GET' && url.pathname === '/agent/telegram/status') {
      try { return json(res, 200, await telegram.status({ refresh: url.searchParams.get('refresh') === '1' })); }
      catch { return json(res, 503, { configured: false, connected: false, error: '텔레그램 설정을 확인하지 못했습니다.' }); }
    }
    if (req.method === 'POST' && url.pathname === '/agent/telegram/messages') {
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') return json(res, 415, { error: 'JSON 요청이 필요합니다.' });
      try {
        let size = 0; const chunks = [];
        for await (const chunk of req) { size += chunk.length; if (size > 8192) throw Error('Go1 보고 크기 제한을 초과했습니다.'); chunks.push(chunk); }
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        return json(res, 200, await telegram.send(input));
      } catch (error) { return json(res, error.code?.startsWith('TELEGRAM_') ? 502 : 400, { error: error.message }); }
    }
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
  const remoteWatch = setInterval(() => remote.status(), 2000); remoteWatch.unref();
  server.on('close', () => { clearInterval(remoteWatch); for (const job of jobs.values()) if (job.status === 'running') job.controller.abort(); });
  return server;
}

export async function startBridge({ port = 5181, ...options } = {}) {
  const server = createBridge(options);
  try {
    await new Promise((resolve, reject) => {
      const onError = error => reject(error);
      server.once('error', onError);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', onError);
        resolve();
      });
    });
    return { server, reused: false };
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/agent/health', { signal: AbortSignal.timeout(1500), redirect: 'error' });
      const health = response.ok ? await response.json() : null;
      // Older demo bridges have the same health payload without a service field.
      if (health && (health.service === BRIDGE_SERVICE || health.service === undefined)
        && typeof health.token === 'string' && /^[a-f0-9]{64}$/.test(health.token)
        && health.engines && Object.keys(health.engines).sort().join() === 'codex,hermes'
        && typeof health.engines.codex === 'boolean' && typeof health.engines.hermes === 'boolean') {
        return { server: null, reused: true };
      }
    } catch { /* An occupied port alone does not identify a running demo bridge. */ }
    throw Object.assign(Error(port + ' 포트가 사용 중이지만 Facility AI Twin 브리지의 정상 응답을 확인하지 못했습니다. 포트를 사용하는 프로그램을 확인한 뒤 다시 실행하세요.'), { code: 'EADDRINUSE' });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { server, reused } = await startBridge();
    if (reused) {
      console.log('Agent 브리지가 이미 http://127.0.0.1:5181 에서 정상 실행 중입니다.');
      console.log('기존 브리지를 사용하세요: http://localhost:5180/ 에서 Codex 또는 Hermes를 선택하면 됩니다.');
    } else {
      console.log('Local agent bridge: http://127.0.0.1:5181 — open http://localhost:5180. No app API key required.');
      server.on('error', error => { console.error('Bridge error:', error.code); process.exitCode = 1; });
      const stop = () => server.close();
      process.on('SIGINT', stop); process.on('SIGTERM', stop);
    }
  } catch (error) {
    console.error('Bridge could not start:', error.message);
    process.exitCode = 1;
  }
}
