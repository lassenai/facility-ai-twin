export const DECISION_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ['inspect_heat', 'inspect_sensor', 'hold_low_battery'] },
    target: { type: 'string', enum: ['CH-02'] },
    reason: { type: 'string' },
  },
  required: ['action', 'target', 'reason'],
};

// Model output selects a bounded plan; it never becomes executable code.
export function validateDecision(value, snapshot) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('판단 JSON 형식이 올바르지 않습니다.');
  if (Object.keys(value).sort().join(',') !== 'action,reason,target') throw Error('허용되지 않은 판단 필드가 있습니다.');
  if (value.target !== 'CH-02' || typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 1200) throw Error('대상 또는 판단 근거가 올바르지 않습니다.');
  const expected = snapshot.battery <= 20 ? 'hold_low_battery' : Math.abs(snapshot.reported - snapshot.thermal) > 10 ? 'inspect_sensor' : 'inspect_heat';
  if (value.action !== expected) throw Error('모델 판단이 센서 교차 확인 또는 배터리 제약과 일치하지 않아 실행을 보류했습니다.');
  return { action: value.action, target: 'CH-02', reason: value.reason.trim() };
}

export function observation(s) {
  return {
    runId: s.runId, target: 'CH-02', reported: +s.reported.toFixed(2),
    thermal: +s.thermal.toFixed(2), reference: 38.4,
    battery: +s.battery.toFixed(1), link: s.link,
    temperatureAlarm: 60, dispatchBatteryMinimum: 20,
  };
}
