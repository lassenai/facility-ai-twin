import { FACILITY } from './facility.js';
import { FINDINGS, INSPECTION_POINTS, assessInspection } from './inspection.js';
import { go1Snapshot } from './go1-reports.js';

export const photoAgentName = mode => ({ rules: '규칙 기반', codex: 'Codex', hermes: 'Hermes' }[mode] || mode);

export function inspectionPhotoSnapshot(state) {
  if (!state.active || state.paused || !state.link || state.physicsError) return null;
  const snapshot = go1Snapshot(state);
  if (state.inspection) {
    if (snapshot.finding === 'pending') return null;
  } else {
    if (state.stage !== 'inspect' || !state.log.some(e => e.tool === 'capture_thermal' && e.id.startsWith(state.runId + '-'))) return null;
    // Preserve the values at the robot's actual observation, before cooling
    // or sensor confirmation changes the current state later in the response.
    snapshot.finding = assessInspection({ reported: snapshot.reported, thermal: snapshot.thermal });
  }
  const goal = INSPECTION_POINTS[snapshot.targetId];
  if (Math.hypot(snapshot.robot.x - goal.x, snapshot.robot.z - goal.z) > .6) return null;
  return snapshot;
}

// Photograph the rendered facility at the observed robot pose, once per run.
// The JPEG stays outside simulation state so JSON reports remain small.
export function captureInspectionPhoto(world, state) {
  const snapshot = inspectionPhotoSnapshot(state);
  if (!snapshot) throw Error('장비 앞에서 현장 관측 후에 촬영할 수 있습니다.');
  const asset = FACILITY.assets.find(a => a.id === snapshot.targetId);
  const frame = world.captureInspection(snapshot.targetId, snapshot.robot);
  const capturedAt = new Date().toISOString();
  const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 960;
  const ctx = canvas.getContext('2d');
  const font = '"Pretendard", "Malgun Gothic", sans-serif';
  const normal = snapshot.finding === 'normal', accent = normal ? '#62d6bc' : '#ffc070';
  ctx.fillStyle = '#102536'; ctx.fillRect(0, 0, 1280, 960);
  ctx.fillStyle = '#80a9bc'; ctx.font = `600 19px ${font}`;
  ctx.fillText('LASSEN AI LABS  /  GO1 FIELD REPORT', 36, 37);
  ctx.textAlign = 'right'; ctx.fillText('Agent · ' + photoAgentName(snapshot.agentMode), 1244, 37); ctx.textAlign = 'left';
  ctx.fillStyle = '#ffffff'; ctx.font = `700 29px ${font}`;
  ctx.fillText(asset.id + '  ·  ' + asset.name, 36, 79);
  ctx.fillStyle = accent; ctx.font = `700 23px ${font}`;
  ctx.textAlign = 'right'; ctx.fillText(FINDINGS[snapshot.finding], 1244, 76); ctx.textAlign = 'left';
  ctx.drawImage(frame, 0, 104, 1280, 720);
  ctx.fillStyle = '#102536de'; ctx.fillRect(24, 126, 282, 39);
  ctx.fillStyle = '#ffffff'; ctx.font = `600 18px ${font}`;
  ctx.fillText('가상 점검 이미지 · 3D 카메라', 39, 153);
  // Viewfinder corners give the capture a recognisable robot-camera identity.
  ctx.strokeStyle = '#ffffffb0'; ctx.lineWidth = 2;
  for (const [x, y, dx, dy] of [[30, 188, 1, 1], [1250, 188, -1, 1], [30, 794, 1, -1], [1250, 794, -1, -1]]) {
    ctx.beginPath(); ctx.moveTo(x + dx * 30, y); ctx.lineTo(x, y); ctx.lineTo(x, y + dy * 30); ctx.stroke();
  }
  for (const [x, label, value] of [[36, '온도 센서', snapshot.reported], [350, '열화상 관측', snapshot.thermal], [664, '관측 차이', Math.abs(snapshot.reported - snapshot.thermal)]]) {
    ctx.fillStyle = '#9bb8c8'; ctx.font = `500 18px ${font}`; ctx.fillText(label, x, 856);
    ctx.fillStyle = '#ffffff'; ctx.font = `700 29px ${font}`; ctx.fillText(value.toFixed(1) + ' °C', x, 895);
  }
  ctx.fillStyle = accent; ctx.font = `600 18px ${font}`; ctx.fillText('합성 관측 · 실제 시설 연동 없음', 972, 857);
  ctx.fillStyle = '#9bb8c8'; ctx.font = `500 16px ${font}`;
  const clock = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'medium' }).format(new Date(capturedAt));
  ctx.fillText(`${clock} KST  ·  ${snapshot.runId}  ·  관측 ${snapshot.time.toFixed(1)} s  ·  x ${snapshot.robot.x.toFixed(2)} / z ${snapshot.robot.z.toFixed(2)} m`, 36, 938);
  return { snapshot, image: { dataUrl: canvas.toDataURL('image/jpeg', .9), capturedAt }, delivery: state.inspection?.source === 'telegram' ? '촬영 완료 · 전송 준비' : '웹 보고에 사진 표시됨 · 저장 가능' };
}
