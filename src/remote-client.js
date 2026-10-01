import { go1Snapshot } from './go1-reports.js';
import { FINDINGS } from './inspection.js';

export function mountRemoteCommands({ getState, getPhoto, isPreparing, onCommand, onResults, toast }) {
  const $ = id => document.getElementById(id);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  let clientId, token, timer, active = false, inFlight = false, jobId = null, ackId = null, error = '';
  const handled = new Set();
  const submittedPhotos = new Set();
  let photosSupported = false;
  const photoStatus = state => ({ sending: '텔레그램 사진 전송 중', sent: '텔레그램 사진 전송 완료', failed: '사진 전송 확인 필요 · 대화방을 확인하세요' }[state]);
  const ownsInspection = () => getState().inspection?.source === 'telegram' || getState().inspection?.remoteReturn;
  const label = (state, text) => { $('remoteState').dataset.state = state; $('remoteState').textContent = text; };
  const display = value => { $('remoteMission').textContent = value; };
  async function request(url, value) {
    const response = await fetch(url, { ...(value ? { method: 'POST', body: JSON.stringify(value) } : {}), headers: { 'Content-Type': 'application/json', 'X-Twin-Token': token }, signal: AbortSignal.timeout(15000) });
    const result = await response.json(); if (!response.ok) throw Error(result.error || '스마트폰 명령 연결을 확인하세요.');
    return result;
  }
  async function release() { if (token && clientId) await request('/agent/remote/release', { clientId }).catch(() => {}); }
  async function poll() {
    if (!active || inFlight) return;
    inFlight = true;
    try {
      const s = getState();
      const result = await request('/agent/remote/poll', { clientId, visible: !document.hidden, busy: isPreparing() || s.active && s.stage !== 'complete', snapshot: go1Snapshot(s), jobId, ackId, error });
      if (!active) { await release(); return; }
      onResults(result);
      const photo = getPhoto(), mission = result.mission;
      // An already submitted photo still belongs to this run when a later
      // stop/return command replaces the bridge's current command ID.
      const photoReceipt = photo?.deliveryId && result.deliveries?.find(d => d.id === photo.deliveryId);
      if (photoReceipt) photo.delivery = photoStatus(photoReceipt.state);
      if (photo?.image && mission?.id === jobId && mission.action === 'inspect' && mission.runId === photo.snapshot.runId) {
        if (mission.photo) photo.delivery = photoStatus(mission.photo.state);
        else if (!submittedPhotos.has(jobId) && !['offered', 'failed', 'cancelled'].includes(mission.state)) {
          submittedPhotos.add(jobId);
          if (!photosSupported) photo.delivery = '사진 전송을 사용하려면 브리지를 다시 실행하세요';
          else {
            photo.delivery = '텔레그램 사진 전송 준비';
            photo.deliveryId = jobId + ':photo';
            // Upload acceptance is separate from the receiver heartbeat. Slow
            // Telegram delivery must not block stop/return commands or the lease.
            request('/agent/remote/photo', { clientId, jobId, snapshot: photo.snapshot, image: photo.image }).then(() => {
              photo.delivery = '텔레그램 사진 전송 중';
            }).catch(failure => { photo.delivery = '사진 전송 확인 필요 · 자동 재전송 없음'; toast(failure.message); });
          }
        }
      }
      if (result.command && !handled.has(result.command.id)) {
        const command = result.command; handled.add(command.id); error = '';
        if (['inspect', 'return'].includes(command.action)) jobId = command.id;
        try { await onCommand(command, $('remoteProfile').value); ackId = command.id; }
        catch (failure) { error = failure.message.slice(0, 300); ackId = command.id; toast(error); }
      }
      const current = getState();
      label(document.hidden ? 'offline' : 'ready', document.hidden ? '화면을 열어두세요' : '스마트폰 명령 대기');
      if (ownsInspection() && jobId) display(current.inspection.targetId + ' · ' + (current.paused ? '실행 중지' : current.stage === 'complete' ? current.inspection.finding === 'pending' ? '복귀 완료 · 현장 점검 미완료' : '점검·복귀 완료' : current.next) + ' · ' + FINDINGS[current.inspection.finding]);
      else display('Hermes 대화방에서 Go1에게 장비 점검을 지시하세요.');
      if (ownsInspection() && result.mission?.id === jobId && ['failed', 'cancelled'].includes(result.mission.state)) {
        if (current.inspection && current.stage !== 'complete' && !current.paused) await onCommand({ action: 'stop' });
        label('offline', result.mission.state === 'cancelled' ? '정지 지시 완료' : '점검 확인 필요');
        display((current.inspection?.targetId || result.mission.targetId) + ' · 웹에서 현재 위치와 실행 상태를 확인하세요.');
      }
    } catch (failure) {
      active = false; $('remoteReceive').checked = false; label('offline', '명령 연결 필요'); display(failure.message); toast(failure.message);
      // A receiver losing its bridge connection freezes an active remote mission.
      if (ownsInspection() && getState().stage !== 'complete') await onCommand({ action: 'stop' }).catch(() => {});
      await release();
    } finally {
      inFlight = false;
      if (active) timer = setTimeout(poll, 1000);
      $('remoteProfile').disabled = active;
    }
  }
  $('remoteReceive').onchange = async () => {
    clearTimeout(timer);
    if (!$('remoteReceive').checked) {
      active = false;
      if (ownsInspection() && getState().stage !== 'complete') await onCommand({ action: 'stop' });
      await release(); label('offline', '명령 받기 꺼짐'); display('명령 받기를 켜면 이 화면의 Go1이 스마트폰 지시에 응답합니다.'); $('remoteProfile').disabled = false; return;
    }
    try {
      const health = await request('/agent/health');
      if (!health.capabilities?.remoteCommands) throw Error('스마트폰 명령 기능을 사용하려면 브리지를 다시 실행하세요.');
      token = health.token; clientId ||= crypto.randomUUID(); active = true;
      photosSupported = Boolean(health.capabilities?.inspectionPhotos);
      label('ready', '명령 연결 중'); $('remoteProfile').disabled = true; await poll();
    } catch (failure) { active = false; $('remoteReceive').checked = false; label('offline', '명령 연결 필요'); display(failure.message); toast(failure.message); }
  };
  document.addEventListener('visibilitychange', async () => {
    if (active && document.hidden && ownsInspection() && getState().stage !== 'complete') await onCommand({ action: 'stop' });
    if (active && !inFlight) { clearTimeout(timer); poll(); }
  });
  window.addEventListener('pagehide', () => {
    active = false; clearTimeout(timer);
    if (token && clientId) fetch('/agent/remote/release', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Twin-Token': token }, body: JSON.stringify({ clientId }), keepalive: true }).catch(() => {});
  });
  if (!local) { $('remoteReceive').disabled = true; $('remoteProfile').disabled = true; label('offline', '노트북에서 연결'); display('스마트폰 명령은 브리지가 실행 중인 노트북 localhost에서 받습니다.'); }
  return { sync: () => { if (active && ownsInspection() && getState().paused) label('offline', 'Go1 실행 중지'); } };
}
