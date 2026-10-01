import { STAGES, SCENARIOS } from './simulation.js';
import { FACILITY } from './facility.js';
import { FINDINGS } from './inspection.js';

export const GO1_REPORT_TOOLS = new Set([
  'read_sensor', 'classify_incident', 'local_cli_decision',
  'execute_navigation', 'capture_thermal', 'set_backup_ventilation', 'stop_robot',
  'verify_connection', 'replan_route', 'request_sensor_calibration',
  'verify_temperature', 'complete_mission', 'reject_decision', 'receive_remote_command', 'inspection_result', 'start_web_inspection', 'request_inspection_return',
]);

export function go1Snapshot(s) {
  const readings = s.inspection?.readings;
  return {
    targetId: s.inspection?.targetId || 'CH-02', mission: s.inspection ? 'inspection' : 'response', finding: s.inspection?.finding || 'pending', paused: s.paused,
    runId: s.runId, scenario: s.scenario, stage: s.stage, time: +s.time.toFixed(2),
    temperature: +(readings?.model ?? s.temperature).toFixed(2), reported: +(readings?.reported ?? s.reported).toFixed(2), thermal: +(readings?.thermal ?? s.thermal).toFixed(2),
    battery: +s.battery.toFixed(1), link: s.link, fan: s.fan,
    robot: { x: +s.robot.x.toFixed(2), z: +s.robot.z.toFixed(2), speed: +s.robot.speed.toFixed(2) },
    robotMode: s.robotMode, agentMode: s.agentMode, verified: s.verified,
    diagnosis: s.diagnosis, next: s.next, distance: +s.distance.toFixed(2),
    replans: s.replan, safeStops: s.safeStops, policyCalls: s.policyCalls,
  };
}

function keysEqual(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join() === [...keys].sort().join();
}

export function validateGo1Notice(input) {
  const required = ['id', 'kind', 'snapshot'];
  if (!keysEqual(input, input?.kind === 'event' ? [...required, 'event'] : required)) throw Error('Go1 보고 필드가 올바르지 않습니다.');
  if (typeof input.id !== 'string' || !/^[A-Za-z0-9:-]{8,100}$/.test(input.id)
    || !['status', 'report', 'test', 'event'].includes(input.kind)) throw Error('Go1 보고 종류가 올바르지 않습니다.');
  const s = input.snapshot;
  const fields = ['targetId', 'mission', 'finding', 'paused', 'runId', 'scenario', 'stage', 'time', 'temperature', 'reported', 'thermal', 'battery', 'link', 'fan', 'robot', 'robotMode', 'agentMode', 'verified', 'diagnosis', 'next', 'distance', 'replans', 'safeStops', 'policyCalls'];
  if (!keysEqual(s, fields) || typeof s.runId !== 'string' || !/^SIM-[A-Z0-9]{1,12}$/.test(s.runId)
    || !Object.hasOwn(STAGES, s.stage) || !Object.hasOwn(SCENARIOS, s.scenario)
    || !['light', 'precise'].includes(s.robotMode) || !['rules', 'codex', 'hermes'].includes(s.agentMode)
    || !FACILITY.assets.some(a => a.id === s.targetId) || !['inspection', 'response'].includes(s.mission) || !Object.hasOwn(FINDINGS, s.finding)
    || typeof s.paused !== 'boolean' || typeof s.link !== 'boolean' || typeof s.verified !== 'boolean') throw Error('Go1 관측 식별자가 올바르지 않습니다.');
  for (const key of ['time', 'temperature', 'reported', 'thermal', 'battery', 'fan', 'distance', 'replans', 'safeStops', 'policyCalls']) {
    if (typeof s[key] !== 'number' || !Number.isFinite(s[key]) || s[key] < 0 || s[key] > 10000000) throw Error('Go1 관측 수치가 올바르지 않습니다.');
  }
  if (s.battery > 100 || s.fan > 100 || ['temperature', 'reported', 'thermal'].some(k => s[k] > 150)) throw Error('Go1 관측 범위를 초과했습니다.');
  if (!keysEqual(s.robot, ['x', 'z', 'speed']) || ['x', 'z', 'speed'].some(k => typeof s.robot[k] !== 'number' || !Number.isFinite(s.robot[k]) || Math.abs(s.robot[k]) > 1000)
    || s.robot.speed < 0 || ['diagnosis', 'next'].some(k => typeof s[k] !== 'string' || s[k].length > 600)) throw Error('Go1 상태가 올바르지 않습니다.');
  if (input.kind === 'event') {
    const e = input.event;
    if (!keysEqual(e, ['id', 'tool', 'title', 'detail', 'time']) || typeof e.id !== 'string' || !new RegExp('^' + s.runId + '-E[0-9]{3,6}$').test(e.id)
      || !GO1_REPORT_TOOLS.has(e.tool) || typeof e.time !== 'number' || !Number.isFinite(e.time) || e.time < 0 || e.time > s.time + 1
      || ['title', 'detail'].some(k => typeof e[k] !== 'string' || e[k].length > 600)) throw Error('Go1 임무 이벤트가 올바르지 않습니다.');
  }
  return structuredClone(input);
}

export function go1Event(e) {
  return { id: e.id, tool: e.tool, title: e.title, detail: e.detail, time: e.time };
}

const voice = {
  idle: '도킹 위치에서 다음 시설 점검 임무를 기다리고 있습니다.',
  detect: 'CH-02의 온도 경보를 받았습니다. 센서와 열화상을 확인하겠습니다.',
  analyze: 'Agent의 점검 판단을 기다리고 있습니다.',
  plan: '점검 지점까지 이동할 경로를 준비하고 있습니다.',
  navigate: 'CH-02 점검 지점으로 이동하고 있습니다.',
  inspect: '점검 위치에 도착했습니다. 열화상과 설비 상태를 확인합니다.',
  await_review: '현장 점검에서 이상을 발견했습니다. 현재 위치에서 복귀 지시를 기다립니다.',
  cool: '현장 점검 후 보조 환기 명령이 반영됐습니다.',
  verify: '조치 후 온도가 안정되는지 확인하고 있습니다.',
  return: '점검을 마치고 도킹 위치로 복귀하고 있습니다.',
  complete: '도킹 위치로 복귀했습니다. 이번 대응 결과를 보고합니다.',
};

export function formatGo1Message(input) {
  const s = input.snapshot;
  const header = '🐾 가상 Go1 R-01 · ' + ({ status: '현재 상태', report: '대응 요약', test: '텔레그램 연결 확인', event: '현장 보고' }[input.kind]);
  const lines = [header, '브라우저 시뮬레이션에서 보내는 보고입니다.', '', '임무 ' + s.runId];
  if (s.stage !== 'idle') lines.push('상황: ' + SCENARIOS[s.scenario].name);
  lines.push('단계: ' + STAGES[s.stage]);
  if (s.mission === 'inspection') lines.push('점검 장비: ' + s.targetId + ' / 판정: ' + FINDINGS[s.finding]);
  if (input.kind === 'event') {
    lines.push('', input.event.title, input.event.detail);
  } else {
    lines.push('', s.paused ? '현재 위치에서 실행을 중지했습니다.' : !s.link ? '연결이 끊겨 현재 위치에서 정지하고 있습니다.' : s.battery <= 20 ? '배터리가 부족해 주행을 보류하고 있습니다.' : voice[s.stage].replaceAll('CH-02', s.targetId));
    if (input.kind === 'test') lines.push('이 대화방으로 Go1 보고 전송이 연결되었습니다.');
  }
  lines.push('', '📍 위치 x ' + s.robot.x.toFixed(2) + ' / z ' + s.robot.z.toFixed(2) + ' m',
    '🌡 모델 온도 ' + s.temperature.toFixed(1) + '°C / 센서 ' + s.reported.toFixed(1) + '°C / 열화상 ' + s.thermal.toFixed(1) + '°C',
    '🔋 배터리 ' + s.battery.toFixed(1) + '% / 연결 ' + (s.link ? '정상' : '단절'),
    '이동 속도 ' + s.robot.speed.toFixed(2) + ' m/s / 환기 ' + s.fan + '%');
  if (input.kind === 'report' || input.event?.tool === 'complete_mission') {
    lines.push('', '판단: ' + s.diagnosis,
      '결과: ' + (s.stage === 'complete' ? '복귀 완료' : s.mission === 'inspection' ? '점검 진행 중' : '대응 진행 중') + ' / ' + (s.mission === 'inspection' ? '관측 판정 ' + FINDINGS[s.finding] : '검증 ' + (s.verified ? '조건 충족' : '아직 확인되지 않음')),
      '시뮬레이션 ' + s.time.toFixed(1) + '초 / 이동 ' + s.distance.toFixed(2) + 'm',
      '경로 변경 ' + s.replans + '회 / 정지 ' + s.safeStops + '회 / 보행 정책 추론 ' + s.policyCalls + '회');
  }
  if (s.mission === 'inspection') lines.push('', '점검 임무: 관측·보고·복귀 / 환기 조치 없음', '이상 판정은 예시 관측 기준이며 장비 정상·안전을 보증하지 않습니다.');
  if (s.mission === 'inspection' && s.finding === 'pending' && ['return', 'complete'].includes(s.stage)) lines.push('현장 점검 미완료: 관측 전에 복귀 지시를 받았으므로 이상 유무는 확인하지 못했습니다.');
  lines.push('', '제어: ' + (s.robotMode === 'precise' ? 'MuJoCo + 공개 Go1 보행 정책' : '경량 운동학 시뮬레이션') + ' / Agent ' + s.agentMode);
  return lines.join('\n');
}
