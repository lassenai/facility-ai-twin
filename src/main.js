import './style.css';
import { createFacilityScene } from './scene.js';
import { Simulation, SCENARIOS, STAGES } from './simulation.js';
import { FACILITY, WALLS } from './facility.js';
import { observation } from './decision.js';
import { hydrateIcons, icon } from './icons.js';

hydrateIcons();
const $ = id => document.getElementById(id);
const sim = new Simulation();
let scenario = 'heat', selected = 'CH-02', world, body;
let preparing = false, physicsStep = null, generation = 0, agentRequest = null;
let logCount = -1, lastStage = '', previous = performance.now(), accumulator = 0;
let toastTimer;
const localBrowser = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
const fmt = t => String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(Math.floor(t % 60)).padStart(2, '0');
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const text = (id, value) => { if ($(id).textContent !== String(value)) $(id).textContent = value; };
const names = { twin: '디지털 트윈', agent: 'Agent', physical: '로봇·설비' };
const PHYSICAL_TEXT = {
  idle: ['도킹 위치에서 다음 점검 임무를 기다립니다.', '경로 계획 · 연결 감시 · 상태 확인'],
  detect: ['설비와 로봇 상태를 관측합니다.', '센서 · 연결 · 배터리 확인'],
  analyze: ['점검 임무를 기다리고 있습니다.', '대기 · 주행 명령 0'],
  plan: ['점검 지점까지 통행 가능한 경로를 계산합니다.', 'A* 경로 · 장애물 여유 폭 0.46m'],
  navigate: ['계산된 경로를 따라 CH-02 앞으로 이동합니다.', '위치 관측 → 주행 명령 → 다음 위치'],
  inspect: ['점검 지점에 정지하고 열화상 관측을 기록합니다.', '위치 도착 확인 · 관측값 기록'],
  cool: ['환기 명령을 설비 모델에 반영합니다.', '보조 환기 85% · 예시 열모델'],
  verify: ['조치 후 온도 변화를 계속 관측합니다.', '45°C 이하 4초 유지 확인'],
  return: ['현재 위치에서 도킹 위치로 복귀합니다.', '복귀 경로 추종 · 임무 종료 확인'],
  complete: ['로봇 복귀와 조치 결과를 확인했습니다.', '실행 기록 연결 · 리포트 생성'],
};

function toast(message) {
  text('toast', message); $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4200);
}
function selectAsset(id) { selected = id; world?.select(id); render(); }
try {
  world = createFacilityScene($('world'), $('labels'), selectAsset);
  $('worldLoading').hidden = true;
} catch (e) {
  console.error('3D initialization:', e);
  $('worldLoading').hidden = true; $('worldUnavailable').hidden = false;
}

function cancelAgent() {
  if (!agentRequest) return;
  agentRequest.abort.abort();
  if (agentRequest.job) fetch('/agent/jobs/' + agentRequest.job, { method: 'DELETE', headers: { 'X-Twin-Token': agentRequest.token } }).catch(() => {});
  agentRequest = null;
}

async function reset() {
  generation++; preparing = true; cancelAgent();
  if (physicsStep) await physicsStep.catch(() => {});
  const mode = $('robotMode').value, agentMode = $('agentMode').value;
  sim.reset(); sim.s.robotMode = mode; sim.s.agentMode = agentMode;
  body?.resetAt(FACILITY.dock.x, FACILITY.dock.z, 0); body?.setObstruction(false);
  accumulator = 0; logCount = -1; preparing = false; render();
}

function environmentXml() {
  let xml = '<geom name="facility_floor" type="plane" size="20 20 .1" friction="1 .005 .0001" contype="8" conaffinity="3"/>';
  for (const a of [...FACILITY.assets, ...WALLS]) xml += '<geom type="box" pos="' + [a.x, -a.z, a.h / 2].join(' ') + '" size="' + [a.w / 2, a.d / 2, a.h / 2].join(' ') + '" contype="24" conaffinity="3"/>';
  const o = FACILITY.obstruction;
  return xml + '<body name="incident_blocker" mocap="true" pos="100 0 .5"><geom type="box" size="' + [o.w / 2, o.d / 2, o.h / 2].join(' ') + '" contype="24" conaffinity="3"/></body>';
}

async function changeRobot() {
  if (sim.s.active && sim.s.stage !== 'complete') return;
  const mode = $('robotMode').value;
  if (mode === 'light') {
    await reset(); world?.setPreciseBody(null);
    if (body) { body.dispose(); body = null; }
    render(); return;
  }
  if (!world) { toast('정밀 물리 모드는 3D 화면이 필요합니다.'); $('robotMode').value = 'light'; return; }
  preparing = true; $('engineLoading').hidden = false; render();
  try {
    const { createMjcfBody, GO1_CFG } = await import('./physics/mjcf-body.js');
    const base = new URL(import.meta.env.BASE_URL, location.href).href;
    const cfg = { ...GO1_CFG, xml: base + 'robots/go1/go1.xml', assetsDir: base + 'robots/go1/assets/', policy: base + 'policies/go1_policy.onnx' };
    body = await createMjcfBody(cfg, world.scene, value => text('engineLoadingText', value), environmentXml());
    body.resetAt(FACILITY.dock.x, FACILITY.dock.z, 0);
    world.setPreciseBody(body); sim.s.robotMode = 'precise';
    toast('MuJoCo 물리 모델과 공개 Go1 보행 정책이 준비되었습니다.');
  } catch (e) {
    console.error(e); body?.dispose(); body = null; world?.setPreciseBody(null);
    $('robotMode').value = 'light'; sim.s.robotMode = 'light';
    toast('정밀 모드를 준비하지 못했습니다. 연결을 확인하고 다시 선택하세요.');
  } finally { preparing = false; $('engineLoading').hidden = true; render(); }
}

async function requestAgent() {
  const snapshot = observation(sim.s), mode = sim.s.agentMode, runId = sim.s.runId;
  const request = { abort: new AbortController(), job: null, token: null };
  agentRequest = request; sim.s.agentRequested = true;
  const fetchJson = async (url, options = {}) => {
    const response = await fetch(url, { ...options, signal: request.abort.signal });
    let result; try { result = await response.json(); } catch { throw Error('로컬 Agent 브리지를 먼저 실행하세요: npm run agent:bridge'); }
    if (!response.ok) throw Error(result.error || '로컬 Agent 요청을 처리하지 못했습니다.');
    return result;
  };
  try {
    if (!localBrowser) throw Error('로컬 CLI는 노트북의 localhost에서 사용할 수 있습니다. 공개 데모에서는 규칙 기반 Agent를 선택하세요.');
    const health = await fetchJson('/agent/health');
    if (!health.engines[mode]) throw Error(mode + ' CLI 실행 파일을 찾을 수 없습니다. 브리지 설정을 확인하세요.');
    request.token = health.token;
    const job = await fetchJson('/agent/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Twin-Token': request.token }, body: JSON.stringify({ engine: mode, snapshot }) });
    request.job = job.id;
    let result;
    for (let i = 0; i < 130; i++) {
      await new Promise((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
        const timer = setTimeout(() => { request.abort.signal.removeEventListener('abort', abort); resolve(); }, 1000);
        request.abort.signal.addEventListener('abort', abort, { once: true });
      });
      result = await fetchJson('/agent/jobs/' + job.id, { headers: { 'X-Twin-Token': request.token } });
      if (result.status === 'complete') break;
      if (result.status === 'failed') throw Error(result.error);
    }
    if (result?.status !== 'complete') throw Error('로컬 Agent 응답 시간이 초과되었습니다.');
    if (sim.s.runId !== runId) return;
    sim.acceptDecision(result.decision, snapshot);
    toast(sim.s.agentError || '로컬 ' + mode + '의 판단을 반영했습니다.');
  } catch (e) {
    if (e.name === 'AbortError' || sim.s.runId !== runId) return;
    sim.agentFailure(e.message); toast(e.message);
  } finally { if (agentRequest === request) agentRequest = null; render(); }
}

function renderChart(s) {
  const samples = s.samples.length ? s.samples : [{ time: 0, actual: 38.4, baseline: 38.4 }];
  const start = samples[0].time, end = Math.max(30, s.time);
  const x = t => 40 + (t - start) / (end - start || 1) * 640;
  const y = t => 144 - (Math.max(20, Math.min(110, t)) - 20) * 1.4;
  const line = key => samples.map((p, i) => (i ? 'L' : 'M') + x(p.time).toFixed(1) + ',' + y(p[key]).toFixed(1)).join(' ');
  const last = samples[samples.length - 1];
  $('actualLine').setAttribute('d', line('actual'));
  $('baselineLine').setAttribute('d', line('baseline'));
  $('actualArea').setAttribute('d', line('actual') + 'L' + x(last.time).toFixed(1) + ',144L40,144Z');
  $('chartTip').setAttribute('cx', x(last.time)); $('chartTip').setAttribute('cy', y(last.actual));
  text('chartStart', Math.round(start) + 's'); text('chartEnd', Math.round(end) + 's');
}

function render() {
  const s = sim.s, running = s.active && s.stage !== 'complete';
  const a = FACILITY.assets.find(a => a.id === selected);
  const temperature = selected === 'CH-02' ? s.reported : a.temperature;
  text('assetId', a.id); text('assetName', a.name); text('assetTemperature', temperature.toFixed(1));
  text('assetCondition', temperature > 60 ? '경보' : '정상');
  document.querySelector('.reading-source').textContent = selected === 'CH-02' ? '센서 신호' : '모델 온도';
  $('assetCondition').classList.toggle('hot', temperature > 60);
  const alert = s.active && !s.verified;
  $('facilityHealth').classList.toggle('alert', alert);
  text('healthTitle', s.stage === 'complete' ? '대응 완료' : alert ? '점검 필요' : '정상 운영');
  text('healthDetail', s.active ? s.verified ? '조치 결과를 확인했습니다' : SCENARIOS[s.scenario].name + ' · 대응 진행 중' : '5개 설비의 상태를 관측 중');
  text('missionClock', fmt(s.time)); text('velocity', s.robot.speed.toFixed(2)); text('battery', Math.round(s.battery));
  $('connection').innerHTML = '<i></i>' + (s.link ? '정상' : '단절');
  $('connection').classList.toggle('lost', !s.link);
  text('robotName', s.robotMode === 'precise' ? 'Go1 · 점검 로봇 R-01' : '점검 로봇 R-01');
  text('robotStatus', s.paused ? '실행 중지' : !s.link ? '통신 단절 · 정지' : s.agentPending ? 'Agent 응답 대기' : s.stage === 'idle' || s.stage === 'complete' ? '도킹 · 임무 대기' : STAGES[s.stage]);
  text('stageTitle', s.stage === 'idle' ? '이상 상황을 실행하세요' : s.agentPending ? '로컬 Agent 응답 대기' : s.paused ? '시뮬레이션 일시정지' : STAGES[s.stage]);
  text('stageEyebrow', !s.active ? '대응 준비' : s.stage === 'complete' ? '실행 결과 확인' : '이번 실행 / ' + SCENARIOS[s.scenario].name);
  text('stageDescription', s.next);
  text('agentReason', s.agentDecision?.reason || s.diagnosis);
  text('agentAction', s.agentPending ? '관측 JSON 전달 · 시뮬레이션 시간 일시정지' : s.active ? s.observation : '온도 · 열화상 · 점검 이력');
  text('agentEngineLabel', s.agentMode === 'rules' ? '규칙 기반' : s.agentMode + ' CLI');
  const physical = PHYSICAL_TEXT[s.stage];
  text('physicalReason', !s.link ? '연결이 끊겨 주행 명령을 0으로 제한합니다.' : s.battery <= 20 && ['plan', 'navigate', 'return'].includes(s.stage) ? '배터리가 부족합니다. 주행을 보류하고 충전을 기다립니다.' : physical[0]);
  text('physicalAction', !s.link ? '연결 복구 후 위치·경로 재확인' : physical[1]);
  text('controllerLabel', s.robotMode === 'precise' ? 'MuJoCo + 정책' : '자율 제어');
  $('modelNote').innerHTML = s.robotMode === 'precise' ? '정밀 모드 · 공개 학습 보행정책<br>MuJoCo 물리 · A* 경로 · 예시 열모델' : '경량 모드 · 비학습 자율 제어<br>예시 시설·열모델을 사용하는 시뮬레이션';
  text('currentTemp', s.temperature.toFixed(1)); text('baselineTemp', s.baseline.toFixed(1)); text('fanLevel', s.fan);
  text('runIdentifier', s.active ? s.runId : '실제 시설 연동 없음');
  const progress = { idle: -1, detect: 0, analyze: 1, plan: 1, navigate: 2, inspect: 2, cool: 2, verify: 3, return: 3, complete: 4 }[s.stage];
  for (const el of document.querySelectorAll('[data-step]')) {
    const i = Number(el.dataset.step); el.classList.toggle('current', i === progress); el.classList.toggle('done', i < progress);
  }
  if (lastStage !== s.stage) { lastStage = s.stage; $('stageSymbol').innerHTML = icon(s.stage === 'complete' ? 'check' : ['navigate', 'return', 'inspect'].includes(s.stage) ? 'robot' : 'pulse'); }
  $('start').disabled = preparing || running;
  $('reset').disabled = preparing;
  text('startLabel', preparing ? '정밀 물리 준비 중' : running ? '대응 시뮬레이션 진행 중' : s.stage === 'complete' ? '시나리오 다시 실행' : SCENARIOS[scenario].name + ' 시나리오 실행');
  text('mobileStartLabel', $('startLabel').textContent);
  $('mobileStart').disabled = preparing; $('mobileStart').hidden = running;
  text('scenarioSummary', SCENARIOS[scenario].summary);
  $('robotMode').disabled = preparing || running; $('agentMode').disabled = preparing || running;
  for (const el of document.querySelectorAll('[data-scenario]')) el.disabled = preparing || running;
  $('pause').disabled = !running || s.agentPending || Boolean(s.agentError);
  $('pause').innerHTML = icon(s.paused ? 'play' : 'pause'); $('pause').setAttribute('aria-label', s.paused ? '시뮬레이션 재개' : '시뮬레이션 일시정지');
  $('block').disabled = !running || s.paused || s.agentPending;
  $('disconnect').disabled = !running || s.paused || s.agentPending;
  $('lowBattery').disabled = preparing || s.agentPending;
  $('block').setAttribute('aria-pressed', s.blocked); $('block').innerHTML = icon('obstacle') + (s.blocked ? '통로 열기' : '통로 차단');
  $('disconnect').setAttribute('aria-pressed', !s.link); $('disconnect').innerHTML = icon('link') + (s.link ? '통신 끊기' : '연결 복구');
  $('lowBattery').setAttribute('aria-pressed', s.battery <= 20); $('lowBattery').innerHTML = icon('battery') + (s.battery <= 20 ? '충전 상태 복구' : '배터리 부족');
  $('report').disabled = !s.log.length;
  if (logCount !== s.log.length) {
    logCount = s.log.length; text('eventCount', logCount + '개');
    if (logCount) {
      $('eventList').innerHTML = [...s.log].reverse().map(e => '<li><time class="event-time">' + fmt(e.time) + '</time><span class="event-role ' + e.role + '" title="' + names[e.role] + '">' + icon(e.role === 'physical' ? 'robot' : e.role === 'agent' ? 'agent' : 'cube') + '</span><div class="event-info"><strong>' + escapeHtml(e.title) + '</strong><p>' + escapeHtml(e.detail) + '</p><span class="event-tool">' + escapeHtml(e.tool) + '</span></div></li>').join('');
    } else $('eventList').innerHTML = '<li class="event-invitation">' + icon('timeline') + '<div><strong>시설의 대응을 시작해보세요</strong><p>센서 관측부터 조치 확인까지, 실행한 근거가 이곳에 쌓입니다.</p></div></li>';
  }
  renderChart(s);
}

function openDialog(title, content, download = false) {
  text('dialogTitle', title); $('dialogContent').innerHTML = content;
  $('downloadReport').hidden = !download; $('infoDialog').showModal();
}
const modelInfo = '<p>이 MVP는 ICTWAY와의 실증 사업을 논의하기 위한 연구 시연물입니다. 시설 형상, 센서와 열화상 관측, 열모델은 예시이며 실제 시설이나 하드웨어에 연결되지 않습니다.</p><h3>두 가지 로봇 실행 모드</h3><p><b>경량:</b> A* 경로, 속도 제한, 장애물 여유 폭, 연결 감시를 사용하는 운동학 시뮬레이션입니다. 학습된 제어기가 아닙니다.</p><p><b>정밀:</b> 브라우저 MuJoCo의 강체·접촉 물리와 공개 Go1 ONNX 보행 정책을 실행합니다. 경로 계획은 A*이며 이 프로젝트에서 정책을 새로 학습하지 않았습니다. 현장 로봇의 성능을 보증하지 않습니다.</p><h3>Agent와 연구 확장</h3><p>기본 Agent는 규칙 기반입니다. 로컬 CLI 모드에서는 설치된 Codex/Hermes가 최초 점검 계획과 근거를 반환하며, 실행 단계는 고정된 제약으로 검증합니다. CLI가 사용하는 모델 서비스는 로그인 설정에 따르며 인터넷과 사용량이 필요할 수 있습니다.</p><p>초파리 뇌 연구와의 연결은 향후 장애물 회피·감각 통합 정책의 비교 실험입니다. 현재 초파리 커넥톰이나 신규 강화학습 모델이 탑재되었다고 주장하지 않습니다.</p><h3>공개 자산과 출처</h3><p>Go1 모델: Unitree / MuJoCo Menagerie (BSD-3). 보행 정책: Google DeepMind / MuJoCo Playground (Apache-2.0). 물리 어댑터: fly-brain-lab / CONNECT AI LAB (Apache-2.0), 시설 좌표와 장애물 지원을 추가했습니다. 전체 고지는 저장소 LICENSES와 THIRD_PARTY_NOTICES.md를 확인하세요.</p>';
$('help').onclick = () => openDialog('2분 데모 진행 안내', '<p>시설의 온도 경보가 실제 과열인지 확인하고, 로봇 점검과 설비 조치로 연결되는 흐름을 체험합니다.</p><ol><li><b>설비 과열을 실행하세요.</b> CH-02가 주황색으로 바뀌고 Agent가 두 관측을 비교합니다.</li><li><b>통로 차단을 누르세요.</b> 파란 경로가 바뀌고 로봇이 우회합니다. 로봇 바로 앞에는 장애물을 생성하지 않습니다.</li><li><b>온도 그래프를 확인하세요.</b> 현장 점검 후 환기를 높여 온도가 내려갑니다. 점선은 조치하지 않은 예시입니다.</li><li><b>센서 오류와 통신 단절을 비교하세요.</b> 오류에는 환기를 유지하고, 단절에는 정지 후 연결 복구를 기다립니다.</li><li><b>대응 리포트를 여세요.</b> 판단·관측·조치의 실행 근거를 JSON으로 내려받을 수 있습니다.</li></ol><h3>노트북에서 실제 Agent를 연결하려면</h3><p>별도 터미널에서 <code>npm run agent:bridge</code>를 실행하고 localhost 화면에서 <b>Codex · 로컬 CLI</b> 또는 <b>Hermes · 로컬 CLI</b>를 선택하세요. API 키를 앱에 넣지 않습니다. 학교 PC와 텔레그램 연동 방식은 저장소 문서에 정리되어 있습니다.</p>');
$('aboutModels').onclick = () => openDialog('모델과 공개 자산 안내', modelInfo);
$('report').onclick = () => {
  const r = sim.report(), m = r.summary;
  openDialog('이번 실행의 대응 리포트', '<p class="report-status">' + (r.completed ? '대응 완료' : '대응 진행 중') + ' · ' + escapeHtml(r.runId) + '</p><h3>' + escapeHtml(r.scenario) + '</h3><p>' + escapeHtml(r.diagnosis) + '</p><dl class="report-metrics"><div><dt>시뮬레이션 시간</dt><dd>' + m.elapsedSimulationSeconds + 's</dd></div><div><dt>현재 모델 온도</dt><dd>' + m.actualTemperature + '°C</dd></div><div><dt>조치 없는 경우</dt><dd>' + m.counterfactualTemperature + '°C</dd></div><div><dt>이동 거리</dt><dd>' + m.distanceMeters + 'm</dd></div><div><dt>경로 변경 / 정지</dt><dd>' + m.replans + ' / ' + m.safeStops + '</dd></div><div><dt>보행 정책 추론</dt><dd>' + m.policyCalls + '회</dd></div></dl><p>검증: <b>' + (r.verified ? '조건 충족' : '아직 확인되지 않음') + '</b> · 실행 기록 ' + r.evidence.length + '개</p><p class="report-model">' + escapeHtml(r.agent) + '<br>' + escapeHtml(r.controller) + '</p><p>예시 시설과 열모델의 실행 기록입니다. 실제 산업 현장의 조치 효과나 안전 인증 자료가 아닙니다.</p>', true);
};
$('downloadReport').onclick = () => {
  const blob = new Blob([JSON.stringify(sim.report(), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = 'facility-response-' + sim.s.runId + '.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
$('closeDialog').onclick = $('closeDialogBottom').onclick = () => $('infoDialog').close();
$('infoDialog').addEventListener('click', e => { if (e.target === $('infoDialog')) { const r = e.target.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) e.target.close(); } });
$('reset').onclick = reset;
$('robotMode').onchange = changeRobot;
$('agentMode').onchange = () => {
  if ($('agentMode').value !== 'rules' && !localBrowser) { $('agentMode').value = 'rules'; toast('로컬 CLI 모드는 노트북의 localhost에서 실행하세요.'); }
  sim.s.agentMode = $('agentMode').value; render();
};
$('start').onclick = async () => {
  if (preparing) return;
  await reset(); sim.start(scenario); render();
};
$('mobileStart').onclick = () => { $('start').click(); $('world').scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); };
$('pause').onclick = () => { sim.s.paused = !sim.s.paused; accumulator = 0; render(); };
$('block').onclick = () => { const before = sim.s.blocked; sim.toggleBlock(); body?.setObstruction(sim.s.blocked); if (before === sim.s.blocked) toast(sim.s.next); render(); };
$('disconnect').onclick = () => { sim.setLink(!sim.s.link); render(); };
$('lowBattery').onclick = () => {
  sim.setBattery(sim.s.battery <= 20 ? 85 : 15);
  if (sim.s.active) sim.event('twin', sim.s.battery <= 20 ? '배터리 부족 상태 주입' : '충전 상태 복구', '출동 제약에 사용할 배터리 상태를 변경했습니다.', 'update_robot_battery');
  render();
};
for (const el of document.querySelectorAll('[data-scenario]')) el.onclick = async () => {
  scenario = el.dataset.scenario;
  for (const b of document.querySelectorAll('[data-scenario]')) b.setAttribute('aria-pressed', b === el);
  await reset(); render();
};
for (const el of document.querySelectorAll('[data-view]')) el.onclick = () => {
  world?.setView(el.dataset.view);
  for (const b of document.querySelectorAll('[data-view]')) b.setAttribute('aria-pressed', b === el);
};
$('thermal').onclick = () => {
  const value = $('thermal').getAttribute('aria-pressed') !== 'true';
  $('thermal').setAttribute('aria-pressed', value); world?.setThermal(value); $('thermalLegend').hidden = !value;
};
$('fullscreen').onclick = async () => {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.querySelector('.world-panel').requestFullscreen(); }
  catch { toast('이 브라우저에서 전체 화면을 지원하지 않습니다.'); }
};
document.addEventListener('visibilitychange', () => { previous = performance.now(); accumulator = 0; });

async function advanceTick(step, g = generation) {
  if (body) {
    const command = sim.getDriveCommand();
    body.setVelocityCommand(command.forward, -command.turn);
    physicsStep = body.controlStep();
    await physicsStep;
    if (g !== generation) return false;
    const p = body.pose(); sim.step(step, { x: p.x, z: -p.y, yaw: -p.yaw });
    sim.s.policyCalls = body.state().policyCalls;
    if (body.state().fallen) { sim.physicsFailure('로봇 자세가 허용 범위를 벗어나 물리 실행을 중지했습니다.'); return false; }
  } else sim.step(step);
  return true;
}

async function animate(now) {
  const dt = document.hidden ? 0 : Math.min((now - previous) / 1000, 0.06); previous = now;
  try {
    if (!preparing) {
      const g = generation;
      if (sim.s.active && !sim.s.paused && !sim.s.agentPending && sim.s.stage !== 'complete') {
        accumulator += dt * Number($('speed').value);
        const step = body ? body.ctrlDt : 1 / 60;
        let ticks = 0;
        while (accumulator >= step && ticks++ < 12) {
          if (!await advanceTick(step, g)) break;
          accumulator -= step;
          if (sim.s.agentPending || sim.s.paused || sim.s.stage === 'complete') { accumulator = 0; break; }
        }
        physicsStep = null;
      } else accumulator = 0;
      if (sim.s.agentPending && !sim.s.agentRequested) requestAgent();
    }
    world?.update(sim.s, dt);
    render();
  } catch (e) {
    physicsStep = null; console.error(e);
    sim.physicsFailure('물리 계산 오류: ' + e.message); render();
  }
  requestAnimationFrame(animate);
}
render(); requestAnimationFrame(animate);
// Local QA only. No production global exposes mutable simulation state.
if (import.meta.env.DEV) window.__twin = {
  sim, render, get body() { return body; }, get world() { return world; },
  // Fast-forward uses the same control tick, without waiting for rendered frames.
  advance: async seconds => {
    preparing = true;
    if (physicsStep) await physicsStep.catch(() => {});
    const step = body ? body.ctrlDt : 1 / 60;
    try {
      for (let i = 0; i < seconds / step && sim.s.active && !sim.s.paused && !sim.s.agentPending && sim.s.stage !== 'complete'; i++) {
        if (!await advanceTick(step)) break;
        if (i % 100 === 0) { world?.update(sim.s, .016); await new Promise(r => setTimeout(r, 0)); }
      }
    } finally { preparing = false; physicsStep = null; accumulator = 0; render(); }
    return sim.report();
  },
};
