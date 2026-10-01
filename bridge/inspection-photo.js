import { createHash } from 'node:crypto';
import { validateGo1Notice } from '../src/go1-reports.js';
import { FACILITY } from '../src/facility.js';
import { INSPECTION_POINTS, FINDINGS, assessInspection } from '../src/inspection.js';

export const PHOTO_BODY_LIMIT = 2100000;
const fields = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join() === [...keys].sort().join();

export function validateInspectionPhoto(raw) {
  if (!fields(raw, ['id', 'snapshot', 'image']) || !fields(raw.image, ['dataUrl', 'capturedAt'])) throw Error('점검 사진 필드가 올바르지 않습니다.');
  const snapshot = validateGo1Notice({ id: raw.id, kind: 'report', snapshot: raw.snapshot }).snapshot;
  const goal = INSPECTION_POINTS[snapshot.targetId];
  if (snapshot.mission !== 'inspection' || snapshot.scenario !== 'inspection' || snapshot.finding === 'pending'
    || !['return', 'await_review'].includes(snapshot.stage) || snapshot.paused || !snapshot.link
    || snapshot.finding !== assessInspection({ reported: snapshot.reported, thermal: snapshot.thermal })
    || Math.hypot(snapshot.robot.x - goal.x, snapshot.robot.z - goal.z) > .6) throw Error('장비 앞에서 완료한 현장 관측 사진만 보낼 수 있습니다.');
  if (typeof raw.image.capturedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(raw.image.capturedAt)
    || !Number.isFinite(Date.parse(raw.image.capturedAt))) throw Error('사진 촬영 시각이 올바르지 않습니다.');
  const data = raw.image.dataUrl;
  if (typeof data !== 'string' || data.length > 2000023 || !/^data:image\/jpeg;base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw Error('크기 제한 내의 JPEG 점검 사진이 필요합니다.');
  const bytes = Buffer.from(data.slice(23), 'base64');
  if (bytes.length < 100 || bytes.length > 1500000 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) throw Error('JPEG 사진 내용이 올바르지 않습니다.');
  let width, height, offset = 2;
  while (offset + 4 < bytes.length) {
    if (bytes[offset] !== 0xff) break;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++]; if (marker === 0xda || marker === 0xd9) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) break;
    if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) { height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); break; }
    offset += length;
  }
  if (!width || !height || width > 2048 || height > 2048 || width / height > 4 || height / width > 4) throw Error('사진 해상도가 허용 범위를 벗어났습니다.');
  const image = { capturedAt: raw.image.capturedAt, bytes, width, height };
  const fingerprint = createHash('sha256').update(JSON.stringify({ snapshot, capturedAt: image.capturedAt })).update(bytes).digest('hex');
  return { id: raw.id, kind: 'photo', snapshot, image, fingerprint };
}

export function formatInspectionCaption(input) {
  const s = input.snapshot, asset = FACILITY.assets.find(a => a.id === s.targetId);
  const clock = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'medium' }).format(new Date(input.image.capturedAt));
  return ['📷 가상 Go1 R-01 · 설비 점검 사진', `${asset.id} · ${asset.name} / ${FINDINGS[s.finding]}`,
    `센서 ${s.reported.toFixed(1)}°C · 열화상 ${s.thermal.toFixed(1)}°C · 차이 ${Math.abs(s.reported - s.thermal).toFixed(1)}°C`,
    `${clock} KST · ${s.runId} · 관측 ${s.time.toFixed(1)}초`,
    `촬영 위치 x ${s.robot.x.toFixed(2)} / z ${s.robot.z.toFixed(2)} m`,
    '디지털 트윈의 3D 카메라 이미지와 합성 관측입니다.', '현장 관측을 기록했습니다. 장비 조치는 수행하지 않았습니다.'].join('\n');
}
