import { Simulation } from './simulation.js';
import { FACILITY, clearSegment, obstacles } from './facility.js';

export const INSPECTION_POINTS = {
  'CH-02': FACILITY.inspection, 'AHU-01': { x: -2.4, z: -2.6 },
  'TK-01': { x: -2.6, z: .55 }, 'PU-01': { x: 1.55, z: -1.15 }, 'EL-01': { x: 3, z: 3.3 },
};
export const FINDINGS = {
  pending: '현장 관측 전', normal: '정상 범위', overheat: '과열 의심',
  sensor_mismatch: '센서 불일치', unconfirmed: '추가 점검 필요',
};
export function assessInspection({ reported, thermal }) {
  if (Math.abs(reported - thermal) > 5) return 'sensor_mismatch';
  if (reported >= 60 && thermal >= 60) return 'overheat';
  if (reported < 60 && thermal < 60) return 'normal';
  return 'unconfirmed';
}

export class FacilitySimulation extends Simulation {
  startInspection(targetId, profile = 'current', { source = 'telegram', returnPolicy = 'always' } = {}) {
    const asset = FACILITY.assets.find(a => a.id === targetId);
    if (!asset || !['current', 'heat', 'sensor', 'normal'].includes(profile)
      || !['web', 'telegram'].includes(source) || !['always', 'normal_only'].includes(returnPolicy)) throw Error('지원하는 장비와 점검 환경을 선택하세요.');
    if (this.s.active && this.s.stage !== 'complete') throw Error('현재 임무를 완료하거나 초기화한 뒤 점검하세요.');
    const previous = this.s;
    this.reset();
    const s = this.s;
    for (const key of ['battery', 'link', 'blocked', 'robotMode', 'fan']) s[key] = previous[key];
    s.robot = { ...previous.robot, speed: 0 }; s.agentMode = 'rules';
    if (profile === 'current') for (const key of ['temperature', 'reported', 'thermal', 'fan']) s[key] = previous[key];
    else if (profile === 'heat') { s.temperature = 64.2; s.reported = 64.2; s.thermal = 63.8; }
    else if (profile === 'sensor') s.reported = 70.4;
    s.baseline = s.temperature; s.peak = s.temperature;
    const readings = asset.id === 'CH-02' ? { model: s.temperature, reported: s.reported, thermal: s.thermal }
      : { model: asset.temperature, reported: asset.temperature, thermal: +(asset.temperature - .3).toFixed(1) };
    s.inspection = { targetId, name: asset.name, profile, source, returnPolicy, goal: INSPECTION_POINTS[targetId], readings, finding: 'pending' };
    s.scenario = 'inspection'; s.active = true; this.stage('plan');
    s.diagnosis = targetId + '의 이상 유무를 현장에서 확인합니다.';
    s.observation = '점검 위치에 도착한 뒤 온도 센서와 독립 열화상을 비교합니다.';
    s.next = targetId + ' 점검 경로와 배터리·연결 상태를 확인합니다.';
    this.event('agent', targetId + (source === 'web' ? ' 웹 점검 접수' : ' 원격 점검 접수'),
      source === 'web' ? '웹에서 지정한 장비로 이동합니다. 정상 판정이면 자동 복귀하고 이상 판정이면 현장에서 복귀 지시를 기다립니다.' : '스마트폰 명령에 따라 이동·관측·보고·복귀 임무를 준비합니다.',
      source === 'web' ? 'start_web_inspection' : 'receive_remote_command', { targetId, profile, returnPolicy });
    this.recordSample();
  }

  returnFromInspection({ remote = false, runId, targetId } = {}) {
    const s = this.s;
    if (!s.inspection || !s.active || ['idle', 'complete'].includes(s.stage) || !remote && s.stage !== 'await_review') throw Error('현장 보고 후 복귀 지시를 기다리는 임무가 없습니다.');
    if ((runId && runId !== s.runId) || (targetId && targetId !== s.inspection.targetId)) throw Error('점검 임무가 바뀌었습니다. 현재 상태를 확인한 뒤 복귀를 다시 지시하세요.');
    if (s.physicsError) throw Error('물리 실행 오류로 복귀를 보류했습니다. 웹에서 초기화한 뒤 다시 점검하세요.');
    if ((!remote && s.paused) || !s.link || s.battery <= 20) throw Error('실행·연결·충전 상태를 복구한 뒤 복귀를 지시하세요.');
    if (!this.planRoute(FACILITY.dock)) throw Error(s.next);
    if (remote) { s.paused = false; s.inspection.remoteReturn = true; }
    this.stage('return'); s.next = s.inspection.finding === 'pending' ? '점검을 중단하고 도킹 위치로 복귀합니다. 현장 관측 전이므로 이상 유무는 확인하지 못했습니다.' : '관측 판정 기록을 유지하고 도킹 위치로 복귀합니다. 장비 조치는 수행하지 않았습니다.';
    this.event('agent', remote ? '스마트폰 복귀 지시 반영' : '현장 보고 확인 · 복귀 지시', s.next, 'request_inspection_return', { finding: s.inspection.finding });
  }

  planRoute(goal) {
    return super.planRoute(goal === FACILITY.inspection && this.s.inspection ? this.s.inspection.goal : goal);
  }

  step(dt, externalPose) {
    if (!this.s.inspection) return super.step(dt, externalPose);
    const s = this.s, inspection = s.inspection;
    if (s.paused || !s.active || s.stage === 'complete') return;
    dt = Math.max(0, Math.min(.1, dt)); if (!dt) return;
    s.time += dt;
    if (externalPose) {
      const distance = Math.hypot(externalPose.x - s.robot.x, externalPose.z - s.robot.z);
      s.distance += distance; s.robot = { ...externalPose, speed: distance / dt };
    } else {
      const command = this.getDriveCommand(); s.robot.yaw += command.turn * dt;
      const next = { x: s.robot.x + Math.cos(s.robot.yaw) * command.forward * dt, z: s.robot.z + Math.sin(s.robot.yaw) * command.forward * dt };
      if (clearSegment(s.robot, next, obstacles(s.blocked))) {
        s.distance += Math.hypot(next.x - s.robot.x, next.z - s.robot.z);
        Object.assign(s.robot, next, { speed: command.forward });
      } else {
        s.robot.speed = 0; s.safeStops++; s.replan++;
        this.planRoute(s.stage === 'return' ? FACILITY.dock : inspection.goal);
        this.event('physical', '점검 경로 재계산', '장애물 여유 폭을 확인하고 이동 경로를 다시 계산했습니다.', 'replan_route');
      }
    }
    if (s.robot.speed > .05) s.battery = Math.max(0, s.battery - dt * .018);
    if (s.battery <= 20 && !s.lowBatteryNoted) {
      s.lowBatteryNoted = true; s.safeStops++;
      s.next = '배터리가 부족해 점검을 보류했습니다. 충전 상태를 복구하세요.';
      this.event('physical', '배터리 제약 · 점검 보류', s.next, 'stop_robot');
    }
    if (s.battery > 20) s.lowBatteryNoted = false;
    const age = s.time - s.stageAt;
    if (s.stage === 'plan' && age > 1 && s.battery > 20 && s.link && this.planRoute(inspection.goal)) {
      this.stage('navigate'); s.next = inspection.targetId + ' 점검 위치로 이동합니다.';
      this.event('physical', inspection.targetId + ' 이동 시작', '통행 가능한 경로를 따라 지정 장비로 이동합니다.', 'execute_navigation');
    } else if (s.stage === 'navigate' && s.link && s.battery > 20 && Math.hypot(s.robot.x - inspection.goal.x, s.robot.z - inspection.goal.z) < .4) {
      this.stage('inspect'); s.robot.speed = 0; s.next = inspection.targetId + '의 온도 센서와 열화상을 관측합니다.';
      this.event('physical', inspection.targetId + ' 현장 도착', '점검 위치에 도착해 합성 온도·열화상 관측을 기록했습니다.', 'capture_thermal', { targetId: inspection.targetId, readings: inspection.readings, robotPosition: { x: s.robot.x, z: s.robot.z } });
    } else if (s.stage === 'inspect' && age > 3 && s.link) {
      inspection.finding = assessInspection(inspection.readings);
      const findings = {
        normal: '온도 센서와 열화상이 모두 60°C 미만이고 서로 일치합니다. 이 관측 기준에서 정상 범위입니다.',
        overheat: '온도 센서와 열화상이 모두 60°C 이상입니다. 과열이 의심되며 별도 조치가 필요합니다.',
        sensor_mismatch: '온도 센서와 열화상의 차이가 5°C를 초과합니다. 센서 불일치가 있어 추가 점검이 필요합니다.',
        unconfirmed: '두 관측만으로 이상 유무를 확정하기 어렵습니다. 추가 점검이 필요합니다.',
      };
      s.diagnosis = inspection.targetId + ' · ' + FINDINGS[inspection.finding] + '. ' + findings[inspection.finding];
      s.verified = inspection.finding !== 'unconfirmed';
      s.observation = '현장 관측을 기록했습니다. 점검 명령에서 환기 설정은 변경하지 않습니다.';
      this.event('agent', inspection.targetId + ' 점검 결과 · ' + FINDINGS[inspection.finding], s.diagnosis, 'inspection_result', { readings: inspection.readings, finding: inspection.finding });
      if (inspection.returnPolicy === 'normal_only' && inspection.finding !== 'normal') {
        this.stage('await_review'); s.robot.speed = 0; s.route = []; s.waypoint = 0;
        s.next = '이상 판정을 보고했습니다. 현장에서 복귀 지시를 기다립니다. 장비 조치는 수행하지 않았습니다.';
      } else {
        this.stage('return'); this.planRoute(FACILITY.dock);
        s.next = inspection.finding === 'normal' ? '정상 범위로 판정해 별도 지시 없이 도킹 위치로 자동 복귀합니다.' : '점검 결과를 보고하고 도킹 위치로 복귀합니다.';
      }
    } else if (s.stage === 'return' && s.link && s.battery > 20 && Math.hypot(s.robot.x - FACILITY.dock.x, s.robot.z - FACILITY.dock.z) < .4) {
      this.stage('complete'); s.robot.speed = 0;
      s.next = inspection.finding === 'pending' ? '도킹 위치로 복귀했습니다. ' + inspection.targetId + ' 현장 점검은 미완료이며 이상 유무는 확인하지 못했습니다.' : inspection.targetId + ' 점검과 복귀를 마쳤습니다. 이상 유무는 관측 판정입니다.';
      this.event('physical', inspection.finding === 'pending' ? '복귀 완료 · 현장 관측 전' : '장비 점검 · 복귀 완료', s.next, 'complete_mission', { finding: inspection.finding });
    }
    if (s.time - this.sampleAt >= .5) this.recordSample();
  }

  report() {
    const result = super.report();
    if (this.s.inspection) { result.inspection = structuredClone(this.s.inspection); result.agent = 'Observed sensor / thermal inspection + deterministic navigation guards'; }
    return result;
  }
}
