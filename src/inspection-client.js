import { FACILITY } from './facility.js';
import { FINDINGS } from './inspection.js';
import { photoAgentName } from './inspection-photo.js';

export function mountWebInspection({ getState, getPhoto, getSelected, isPreparing, onSelect, onInspect, onReturn, toast }) {
  const $ = id => document.getElementById(id);
  const write = (id, value) => { if ($(id).textContent !== value) $(id).textContent = value; };
  for (const asset of FACILITY.assets) $('inspectionTarget').add(new Option(asset.id + ' · ' + asset.name, asset.id));
  $('inspectionTarget').value = getSelected();
  $('inspectionTarget').onchange = () => {
    if ($('inspectionTarget').value !== 'CH-02' && ['heat', 'sensor'].includes($('inspectionProfile').value)) $('inspectionProfile').value = 'current';
    onSelect($('inspectionTarget').value);
  };
  $('inspectionProfile').onchange = () => {
    if (['heat', 'sensor'].includes($('inspectionProfile').value)) onSelect('CH-02');
    sync();
  };
  const start = async () => {
    try { await onInspect(getSelected(), $('inspectionProfile').value); }
    catch (error) { toast(error.message); }
  };
  $('inspectionStart').onclick = $('assetInspect').onclick = start;
  $('inspectionReturn').onclick = async () => {
    try { await onReturn(); } catch (error) { toast(error.message); }
  };
  function sync() {
    const s = getState(), inspection = s.inspection, running = s.active && s.stage !== 'complete', selected = getSelected();
    const busy = isPreparing() || running;
    $('inspectionTarget').value = selected;
    if (selected !== 'CH-02' && ['heat', 'sensor'].includes($('inspectionProfile').value)) $('inspectionProfile').value = 'current';
    for (const id of ['inspectionTarget', 'inspectionProfile', 'inspectionStart', 'assetInspect']) $(id).disabled = busy;
    write('inspectionStartLabel', isPreparing() ? '로봇 준비 중' : running ? '현재 임무 진행 중' : selected + ' 점검 보내기');
    $('inspectionReturn').hidden = !inspection || s.stage !== 'await_review';
    $('inspectionReturn').disabled = isPreparing() || s.paused || !s.link || s.battery <= 20;
    const photo = getPhoto(), response = !inspection && s.active;
    const observed = inspection ? inspection.finding !== 'pending' : Boolean(photo?.image);
    const finding = inspection?.finding || photo?.snapshot.finding || 'pending';
    const readings = inspection?.readings || photo?.snapshot;
    $('inspectionPhoto').hidden = !photo?.image;
    $('inspectionPhotoNotice').hidden = !photo || Boolean(photo.image);
    if (photo && !photo.image) write('inspectionPhotoNotice', photo.delivery);
    if (photo?.image) {
      if ($('inspectionPhotoImage').getAttribute('src') !== photo.image.dataUrl) {
        $('inspectionPhotoImage').src = photo.image.dataUrl;
        $('inspectionPhotoImage').alt = photo.snapshot.targetId + ' · 현장 위치에서 촬영한 가상 설비 이미지';
        $('inspectionPhotoDownload').href = photo.image.dataUrl;
        $('inspectionPhotoDownload').download = 'Go1-' + photo.snapshot.targetId + '-' + s.runId + '.jpg';
      }
      write('inspectionPhotoState', photo.delivery);
    }
    $('inspectionResult').dataset.finding = observed ? finding : 'pending';
    write('inspectionResultTarget', inspection ? inspection.targetId + ' · ' + inspection.name : response ? 'CH-02 · Agent 현장 보고' : '현장 점검 보고');
    write('inspectionVerdict', observed ? FINDINGS[finding] : '현장 관측 전');
    write('inspectionSensor', observed ? readings.reported.toFixed(1) + '°C' : '—');
    write('inspectionThermal', observed ? readings.thermal.toFixed(1) + '°C' : '—');
    write('inspectionDifference', observed ? Math.abs(readings.reported - readings.thermal).toFixed(1) + '°C' : '—');
    write('inspectionEvidenceNote', response ? '사진·온도·판정은 촬영 시점의 관측입니다. 조치 후 현재 상태는 위 Agent 설명과 온도 그래프에서 확인하세요.' : '예시 판정 기준: 온도 60°C · 관측 차이 5°C / 점검 중 환기 조치 없음');
    write('inspectionOutcome', response ? (observed ? 'Agent ' + photoAgentName(s.agentMode) + '가 현장 사진과 관측값을 웹으로 보고했습니다. ' + (s.stage === 'complete' ? '대응·복귀 완료. 촬영 시점의 판정은 기록으로 유지합니다.' : s.next) : 'Agent ' + photoAgentName(s.agentMode) + '의 대응 임무입니다. 장비 앞에서 관측하면 사진과 판정을 이곳에 표시합니다.')
      : !inspection ? '장비를 선택해 점검을 보내세요. 정상 판정이면 Go1이 자동으로 복귀합니다.'
      : s.paused ? '현재 위치에서 실행을 중지했습니다. 상단 재개 버튼으로 점검을 이어가세요.'
      : !s.link ? '통신이 끊겨 정지했습니다. 연결을 복구하면 점검을 이어갑니다.'
      : s.battery <= 20 && s.stage !== 'complete' ? '배터리가 부족해 주행을 보류했습니다. 충전 상태를 복구하세요.'
      : s.stage === 'await_review' ? '이상을 보고하고 현장에서 대기 중입니다. 보고를 확인한 뒤 복귀를 지시하세요.'
      : s.stage === 'complete' ? (inspection.finding === 'pending' ? '복귀 완료 · 현장 점검 미완료로 이상 유무는 확인하지 못했습니다.' : inspection.finding === 'normal' ? '정상 판정 · 자동 복귀 완료' : '복귀 완료 · 이상 판정은 유지되며 장비 조치는 수행하지 않았습니다.')
      : s.stage === 'return' ? (inspection.finding === 'pending' ? '점검을 중단하고 복귀 중 · 현장 관측 전' : inspection.remoteReturn ? '스마트폰 복귀 지시 반영 · 관측 판정을 유지하고 복귀 중' : inspection.finding === 'normal' ? '정상 판정 · 도킹 위치로 자동 복귀 중' : '이상 판정 기록을 유지하고 복귀 중') : s.next);
    const progress = !inspection && !response ? -1 : ({ plan: 0, navigate: 1, inspect: 2, await_review: 3, cool: 3, verify: 3, return: 4, complete: 5 }[s.stage] ?? -1);
    for (const el of document.querySelectorAll('[data-inspection-step]')) {
      const step = Number(el.dataset.inspectionStep);
      el.classList.toggle('current', step === progress); el.classList.toggle('done', step < progress);
      if (step === 3 && observed) el.classList.add('done');
    }
    write('inspectionProfileHint', ({ current: '현재 모델·센서 상태를 그대로 점검합니다.', normal: '정상 온도·센서 상태를 사용하는 예시입니다.', heat: 'CH-02에 과열 상태를 설정해 점검합니다.', sensor: 'CH-02에 센서 불일치를 설정해 점검합니다.' }[$('inspectionProfile').value]));
  }
  return { sync };
}
