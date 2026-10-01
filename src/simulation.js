import { FACILITY, obstacles, findPath, clearSegment, pathLength, wrapAngle } from './facility.js';
import { validateDecision, observation } from './decision.js';

export const STAGES = {
  idle: '시설 정상 운영',
  detect: '이상 신호 감지',
  analyze: 'Agent 교차 확인',
  plan: '대응 계획 수립',
  navigate: '로봇 현장 점검',
  inspect: '관측 결과 확인',
  await_review: '현장 보고 · 복귀 지시 대기',
  cool: '환기 조치 실행',
  verify: '조치 효과 검증',
  return: '로봇 복귀',
  complete: '대응 종료',
};
export const SCENARIOS = {
  inspection: { name: 'Go1 장비 점검', summary: '지정 장비로 이동해 온도·열화상을 확인하고 이상 유무를 보고합니다.' },
  heat: { name: '설비 과열', summary: '온도 상승을 확인하고, 로봇 점검과 보조 환기로 대응합니다.' },
  sensor: { name: '센서 오류', summary: '온도 신호와 열화상이 다를 때, 불필요한 조치를 피합니다.' },
  link: { name: '통신 단절', summary: '점검 도중 연결이 끊기면 정지하고 복구를 기다립니다.' },
};

export class Simulation {
  constructor() { this.reset(); }

  reset() {
    this.s = {
      runId: 'SIM-' + Math.random().toString(36).slice(2, 10).toUpperCase(),
      time: 0, stage: 'idle', stageAt: 0, scenario: 'heat', active: false,
      temperature: 38.4, reported: 38.4, thermal: 38.1, baseline: 38.4,
      fan: 35, battery: 85, link: true, blocked: false, paused: false,
      robot: { ...FACILITY.dock, yaw: 0, speed: 0 },
      route: [], routeVersion: 0, waypoint: 1, distance: 0,
      interventions: 0, replan: 0, log: [], samples: [],
      diagnosis: '모든 설비가 정상 범위에 있습니다.',
      observation: '온도 신호와 열화상을 교차 확인합니다.',
      next: '이상 상황을 실행해 대응 과정을 확인하세요.',
      verified: false, stableFor: 0, policyCalls: 0, robotMode: 'light',
      peak: 38.4, sensorConfirmed: false, linkInjected: false,
      safeStops: 0, lowBatteryNoted: false, routeFailed: false,
      agentMode: 'rules', agentPending: false, agentRequested: false, agentDecision: null, agentError: null,
      physicsError: false,
    };
    this.sampleAt = -1; this.lastPose = null; this.scanAt = null;
  }

  setBattery(value) {
    this.s.battery = Math.max(0, Math.min(100, Number(value) || 0));
  }

  event(role, title, detail, tool, evidence = {}) {
    const s = this.s;
    s.log.push({
      id: s.runId + '-E' + String(s.log.length + 1).padStart(3, '0'),
      time: +s.time.toFixed(2), role, title, detail, tool,
      evidence: { temperature: +s.temperature.toFixed(2), reported: +s.reported.toFixed(2), thermal: +s.thermal.toFixed(2), link: s.link, battery: +s.battery.toFixed(1), routeVersion: s.routeVersion, ...evidence },
    });
  }

  stage(value) { this.s.stage = value; this.s.stageAt = this.s.time; }

  start(scenario = 'heat') {
    if (!SCENARIOS[scenario]) throw Error('Unknown scenario');
    const battery = this.s.battery, mode = this.s.robotMode, agentMode = this.s.agentMode;
    this.reset();
    const s = this.s;
    s.battery = battery; s.robotMode = mode; s.agentMode = agentMode;
    s.scenario = scenario; s.active = true;
    if (scenario !== 'sensor') {
      s.temperature = 64.2; s.thermal = 63.8; s.baseline = 64.2; s.reported = 64.2;
    } else s.reported = 70.4;
    s.peak = s.temperature;
    this.stage('detect');
    s.diagnosis = 'CH-02에서 온도 경보가 발생했습니다.';
    s.next = 'Agent가 센서 신호와 점검 이력을 확인합니다.';
    this.event('twin', 'CH-02 온도 경보', '온도 센서가 60°C 경보 기준을 초과했습니다.', 'read_sensor', { requirement: 'REQ-01' });
    this.recordSample();
  }

  planRoute(goal) {
    const s = this.s;
    s.route = findPath(s.robot, goal, obstacles(s.blocked));
    s.waypoint = 1; s.routeVersion++;
    if (!s.route.length) {
      s.routeFailed = true; s.robot.speed = 0;
      s.next = '통행 가능한 경로가 없어 로봇을 정지했습니다.';
      this.event('physical', '경로 확보 실패 · 정지', '통행 경계를 벗어나지 않고 점검을 보류합니다.', 'stop_robot', { requirement: 'REQ-03' });
      return false;
    }
    s.routeFailed = false;
    return true;
  }

  toggleBlock() {
    const s = this.s;
    if (!s.active || ['complete', 'idle'].includes(s.stage)) return;
    const o = FACILITY.obstruction;
    if (!s.blocked && Math.hypot(s.robot.x - o.x, s.robot.z - o.z) < 2.1) {
      s.next = '로봇이 해당 구역을 통과 중입니다. 잠시 후 차단하세요.';
      return;
    }
    s.blocked = !s.blocked; s.interventions++;
    this.event('twin', s.blocked ? '점검 통로 차단' : '점검 통로 개방', '통행 가능 구역이 갱신되었습니다.', 'update_passability', { blocked: s.blocked });
    if (['navigate', 'return'].includes(s.stage)) {
      s.robot.speed = 0; s.safeStops++; s.replan++;
      this.planRoute(s.stage === 'return' ? FACILITY.dock : FACILITY.inspection);
      this.event('physical', '주변 관측에 따라 경로 변경', '차단 구역과 로봇의 여유 폭을 반영해 A* 경로를 다시 계산했습니다.', 'replan_route', { pathLength: +pathLength(s.route).toFixed(2), requirement: 'REQ-03' });
    }
  }

  setLink(value) {
    const s = this.s;
    if (s.link === value) return;
    s.link = value;
    if (!value) {
      s.robot.speed = 0; s.safeStops++;
      s.next = '로봇이 정지했습니다. 연결을 복구하면 점검을 이어갑니다.';
      this.event('physical', '통신 감시 · 로봇 정지', '상위 명령 연결이 끊겨 주행 명령을 0으로 제한했습니다.', 'stop_robot', { requirement: 'REQ-04' });
    } else {
      s.next = '연결이 복구되었습니다. 상태 확인 후 임무를 이어갑니다.';
      this.event('agent', '연결 복구 확인', '현재 위치와 경로를 다시 확인하고 제한된 주행을 허용합니다.', 'verify_connection', { requirement: 'REQ-04' });
      if (['navigate', 'return'].includes(s.stage)) this.planRoute(s.stage === 'return' ? FACILITY.dock : FACILITY.inspection);
    }
  }

  getDriveCommand(pose = this.s.robot) {
    const s = this.s;
    if (s.paused || !s.active || !s.link || s.battery <= 20 || s.routeFailed || !['navigate', 'return'].includes(s.stage)) return { forward: 0, turn: 0 };
    while (s.waypoint < s.route.length - 1 && Math.hypot(pose.x - s.route[s.waypoint].x, pose.z - s.route[s.waypoint].z) < 0.4 && clearSegment(pose, s.route[s.waypoint + 1], obstacles(s.blocked))) s.waypoint++;
    const goal = s.route[s.waypoint];
    if (!goal) return { forward: 0, turn: 0 };
    const distance = Math.hypot(goal.x - pose.x, goal.z - pose.z);
    const angle = wrapAngle(Math.atan2(goal.z - pose.z, goal.x - pose.x) - pose.yaw);
    const top = s.robotMode === 'precise' ? 0.62 : 1.15;
    const stopDistance = s.waypoint === s.route.length - 1 ? 0.25 : 0.06;
    const aligned = s.robotMode === 'precise' || Math.abs(angle) < .25;
    return { forward: distance < stopDistance || !aligned ? 0 : top * Math.max(0, Math.cos(angle)) * Math.min(1, distance / 0.5), turn: Math.max(-1.2, Math.min(1.2, angle * 2.4)) };
  }

  physicsFailure(detail) {
    this.s.physicsError = true;
    this.s.paused = true; this.s.robot.speed = 0;
    this.s.next = '물리 실행을 중지했습니다. 초기화 후 다시 시작하세요.';
    this.event('physical', '물리 실행 중지', detail, 'stop_robot', { requirement: 'REQ-04' });
  }

  acceptDecision(value, snapshot) {
    const s = this.s;
    if (!s.agentPending || snapshot.runId !== s.runId) return false;
    try {
      s.agentDecision = validateDecision(value, snapshot);
      s.agentPending = false;
      this.finishAnalysis();
      this.event('agent', '로컬 ' + s.agentMode + ' 판단 수신', s.agentDecision.reason, 'local_cli_decision', { action: s.agentDecision.action, engine: s.agentMode, observation: snapshot });
      return true;
    } catch (e) { this.agentFailure(e.message); return false; }
  }

  agentFailure(message) {
    this.s.agentPending = false; this.s.paused = true; this.s.agentError = message;
    this.s.next = '로컬 Agent 판단을 실행하지 못했습니다. 초기화 후 연결을 확인하세요.';
    this.event('agent', 'Agent 판단 보류', message, 'reject_decision');
  }

  finishAnalysis() {
    const s = this.s;
    this.stage('plan');
    if (s.scenario !== 'sensor') {
      s.diagnosis = '온도와 열화상이 함께 상승했습니다. 냉각 성능 저하가 의심됩니다.';
      s.observation = '과열 신호가 일치합니다. 현장 점검 후 보조 환기를 가동합니다.';
      this.event('agent', '실제 과열 후보로 분류', '온도와 열화상의 차이가 1°C 이내입니다. 고장 원인의 확정 진단은 보류합니다.', 'classify_incident', { classification: 'corroborated_heat', requirement: 'REQ-02' });
    } else {
      s.diagnosis = '온도 신호와 열화상이 다릅니다. 센서 오류를 우선 점검합니다.';
      s.observation = '32°C의 불일치가 있습니다. 환기를 변경하지 않고 센서를 확인합니다.';
      this.event('agent', '센서 불일치 분류', '독립 열화상은 정상입니다. 불필요한 환기 조치를 보류하고 관측을 확인합니다.', 'classify_incident', { classification: 'sensor_mismatch', requirement: 'REQ-02' });
    }
    s.next = '로봇 상태와 이동 경로를 확인합니다.';
  }

  step(dt, externalPose) {
    const s = this.s;
    if (s.paused || s.agentPending || !s.active || s.stage === 'complete') return;
    dt = Math.max(0, Math.min(0.1, dt)); s.time += dt;
    const hot = s.scenario !== 'sensor';
    if (hot) {
      const coefficient = s.fan > 35 ? 0.145 : 0.012;
      s.temperature += (2 - coefficient * (s.temperature - 23)) * dt;
      s.baseline += (2 - 0.012 * (s.baseline - 23)) * dt;
      s.temperature = Math.min(110, s.temperature); s.baseline = Math.min(110, s.baseline);
    }
    s.thermal = s.temperature - 0.3;
    s.reported = s.scenario === 'sensor' && !s.sensorConfirmed ? s.temperature + 32 : s.temperature;
    s.peak = Math.max(s.peak, s.temperature);
    if (externalPose) {
      const d = Math.hypot(externalPose.x - s.robot.x, externalPose.z - s.robot.z);
      s.distance += d; s.robot = { ...externalPose, speed: d / dt };
    } else {
      const c = this.getDriveCommand();
      s.robot.yaw = wrapAngle(s.robot.yaw + c.turn * dt);
      const next = { x: s.robot.x + Math.cos(s.robot.yaw) * c.forward * dt, z: s.robot.z + Math.sin(s.robot.yaw) * c.forward * dt };
      if (clearSegment(s.robot, next, obstacles(s.blocked))) {
        s.distance += Math.hypot(next.x - s.robot.x, next.z - s.robot.z);
        s.robot.x = next.x; s.robot.z = next.z; s.robot.speed = c.forward;
      } else {
        s.robot.speed = 0; s.safeStops++; s.replan++;
        this.planRoute(s.stage === 'return' ? FACILITY.dock : FACILITY.inspection);
        this.event('physical', '통행 여유 폭 재확인', '다음 이동이 장애물 여유 폭을 침범해 정지하고 현재 위치에서 경로를 재계산했습니다.', 'replan_route', { requirement: 'REQ-03' });
      }
    }
    if (s.robot.speed > 0.05) s.battery = Math.max(0, s.battery - dt * 0.018);
    if (s.battery <= 20 && ['navigate', 'return'].includes(s.stage) && !s.lowBatteryNoted) {
      s.lowBatteryNoted = true; s.safeStops++; s.next = '배터리가 부족해 주행을 보류했습니다. 충전 상태를 복구하세요.';
      this.event('physical', '배터리 제약 · 주행 정지', '배터리 20% 이하에서는 주행 명령을 0으로 제한합니다.', 'stop_robot', { requirement: 'REQ-05' });
    }
    if (s.battery > 20) s.lowBatteryNoted = false;
    const age = s.time - s.stageAt;
    if (s.stage === 'detect' && age > 1.2) {
      this.stage('analyze');
      this.event('agent', '두 센서 신호 교차 확인', '온도 센서, 열화상 관측, 최근 정상 이력을 조회했습니다.', 'query_asset_history', { referenceTemperature: 38.4, requirement: 'REQ-02' });
    } else if (s.stage === 'analyze' && age > 2.2) {
      if (s.agentMode === 'rules') this.finishAnalysis();
      else {
        s.agentPending = true;
        s.next = '로컬 ' + s.agentMode + '가 관측값을 판단하고 있습니다. 응답 대기 중 시뮬레이션 시간을 멈춥니다.';
        this.event('agent', '로컬 Agent에 관측 전달', '고정된 관측 JSON에서 점검 계획을 선택합니다.', 'request_local_decision', { engine: s.agentMode, observation: observation(s) });
      }
    } else if (s.stage === 'plan' && age > 2) {
      if (s.battery <= 20) {
        if (!s.lowBatteryNoted) {
          s.lowBatteryNoted = true; s.next = '배터리가 부족해 출동을 보류했습니다. 충전 상태를 복구하세요.';
          this.event('agent', '배터리 부족 · 출동 보류', '배터리 20% 이하에서는 점검 임무를 배포하지 않습니다.', 'check_robot', { requirement: 'REQ-05' });
        }
      } else if (s.link && this.planRoute(FACILITY.inspection)) {
        this.stage('navigate');
        s.next = 'CH-02 앞 점검 위치로 이동합니다.';
        this.event('agent', '현장 점검 임무 배포', '목표, 속도 제한, 경로 버전을 지정했습니다.', 'dispatch_robot', { goal: FACILITY.inspection, pathLength: +pathLength(s.route).toFixed(2), requirement: 'REQ-03' });
        this.event('physical', '센서와 경로를 따라 이동', '장애물 여유 폭을 유지하며 점검 지점으로 이동합니다.', 'execute_navigation');
      }
    } else if (s.stage === 'navigate') {
      if (s.scenario === 'link' && !s.linkInjected && age > 3.5) { s.linkInjected = true; this.setLink(false); }
      if (s.link && Math.hypot(s.robot.x - FACILITY.inspection.x, s.robot.z - FACILITY.inspection.z) < 0.4) {
        this.stage('inspect'); s.robot.speed = 0;
        s.next = '열화상과 설비 상태를 확인합니다.';
        this.event('physical', '점검 위치 도착 · 관측', '로봇의 실제 시뮬레이션 위치에서 관측값을 기록했습니다.', 'capture_thermal', { robotPosition: { x: s.robot.x, z: s.robot.z }, requirement: 'REQ-06' });
      }
    } else if (s.stage === 'inspect' && age > 3) {
      if (hot) {
        this.stage('cool'); s.fan = 85;
        s.next = '보조 환기를 85%로 가동하고 온도 변화를 확인합니다.';
        this.event('agent', '보조 환기 조치 선택', '현장 관측도 과열과 일치합니다. 허용된 35~85% 범위에서 환기를 조절합니다.', 'set_backup_ventilation', { fan: 85, requirement: 'REQ-07' });
        this.event('physical', '환기 설비 명령 반영', '예시 열모델에 환기 효과를 반영했습니다.', 'apply_ventilation');
      } else {
        s.sensorConfirmed = true; s.verified = true;
        s.next = '센서 불일치가 확인되었습니다. 환기 설정을 유지하고 복귀합니다.';
        this.event('agent', '센서 오류 대응 종료', '실제 모델 온도는 정상입니다. 센서 재교정 요청을 기록하고 냉각 조치는 수행하지 않았습니다.', 'request_sensor_calibration', { requirement: 'REQ-08' });
        this.stage('return'); this.planRoute(FACILITY.dock);
      }
    } else if (s.stage === 'cool' && age > 2) {
      this.stage('verify');
      s.next = '45°C 이하가 4초 유지되는지 확인합니다.';
    } else if (s.stage === 'verify') {
      s.stableFor = s.temperature <= 45 ? s.stableFor + dt : 0;
      if (s.stableFor >= 4) {
        s.verified = true;
        this.event('agent', '조치 효과 확인', '45°C 이하가 시뮬레이션 시간 4초 동안 유지되었습니다.', 'verify_temperature', { requirement: 'REQ-08' });
        this.stage('return'); this.planRoute(FACILITY.dock);
        s.next = '시설이 안정화되었습니다. 로봇이 도킹 위치로 복귀합니다.';
      }
    } else if (s.stage === 'return' && s.link && Math.hypot(s.robot.x - FACILITY.dock.x, s.robot.z - FACILITY.dock.z) < 0.4) {
      this.stage('complete'); s.robot.speed = 0;
      s.next = '대응이 끝났습니다. 실행 근거와 리포트를 확인하세요.';
      this.event('physical', '로봇 복귀 완료', '점검 임무를 종료했습니다.', 'complete_mission', { requirement: 'REQ-09' });
      this.event('agent', '대응 리포트 생성', '현재 실행의 판단, 관측, 조치, 검증 결과를 연결했습니다.', 'generate_report', { verified: s.verified });
    }
    if (s.time - this.sampleAt >= 0.5) this.recordSample();
  }

  recordSample() {
    const s = this.s;
    s.samples.push({ time: +s.time.toFixed(2), actual: +s.temperature.toFixed(2), baseline: +s.baseline.toFixed(2), reported: +s.reported.toFixed(2) });
    if (s.samples.length > 900) s.samples.shift();
    this.sampleAt = s.time;
  }

  report() {
    const s = this.s;
    return structuredClone({
      schemaVersion: 1, runId: s.runId, generatedAt: new Date().toISOString(),
      facility: FACILITY.id, scenario: SCENARIOS[s.scenario].name, stage: STAGES[s.stage],
      agent: s.agentMode === 'rules' ? 'Local rule-based decision engine (not an LLM)' : 'Local ' + s.agentMode + ' CLI (initial classification) + deterministic execution guards',
      agentDecision: s.agentDecision,
      controller: s.robotMode === 'precise' ? 'MuJoCo + public Go1 locomotion policy + A* navigation' : 'Kinematic navigation simulation + A*',
      verified: s.verified, completed: s.stage === 'complete',
      summary: { elapsedSimulationSeconds: +s.time.toFixed(2), actualTemperature: +s.temperature.toFixed(2), counterfactualTemperature: +s.baseline.toFixed(2), peakTemperature: +s.peak.toFixed(2), distanceMeters: +s.distance.toFixed(2), replans: s.replan, safeStops: s.safeStops, policyCalls: s.policyCalls },
      diagnosis: s.diagnosis, samples: s.samples, evidence: s.log,
      limitations: ['Illustrative facility and thermal model', 'No live hardware or ICTWAY integration', 'No industrial safety or control performance claim'],
    });
  }
}
