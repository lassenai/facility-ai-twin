import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { parseGo1Command, GO1_COMMAND_HELP } from '../src/remote-commands.js';
import { validateGo1Notice } from '../src/go1-reports.js';
import { validateInspectionPhoto } from './inspection-photo.js';

const LEASE_MS = 30000;
const fields = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join() === [...keys].sort().join();

export function createRemoteControl({ telegram, root, now = Date.now, persist = true } = {}) {
  const seen = new Map(); let receiver = null, mission = null, stop = null, inbox = Promise.resolve(), writes = Promise.resolve(), lastError = null;
  const deliveries = [];
  const file = root && path.join(root, '.runtime', 'go1-inbox.json');
  const ready = !persist ? Promise.resolve() : readFile(file, 'utf8').then(text => {
    const data = JSON.parse(text);
    for (const entry of data.seen || []) if (typeof entry.key === 'string') seen.set(entry.key, { id: entry.id, duplicate: true });
  }).catch(error => { if (error.code !== 'ENOENT') throw Error('Go1 명령 기록을 읽지 못했습니다. 브리지의 .runtime 파일을 확인하세요.'); });
  ready.catch(() => {});
  function save() {
    if (!persist) return Promise.resolve();
    const entries = [...seen].slice(-1000).map(([key, record]) => ({ key, id: record.id }));
    writes = writes.then(async () => {
      await mkdir(path.dirname(file), { recursive: true }); const temp = file + '.tmp';
      await writeFile(temp, JSON.stringify({ seen: entries })); await rename(temp, file);
    });
    return writes.catch(() => { throw Error('Go1 명령 기록을 저장하지 못했습니다. 디스크와 .runtime 접근 권한을 확인하세요.'); });
  }
  function online() { return Boolean(receiver && receiver.visible && now() - receiver.at < LEASE_MS); }
  function safeJob(job) { return job && { id: job.id, action: job.action, targetId: job.targetId, state: job.state, runId: job.runId || null, photo: job.photo ? { ...job.photo } : null }; }
  function track(id, label, send) {
    const receipt = { id, label, state: 'sending', error: null }; deliveries.unshift(receipt); deliveries.splice(20);
    Promise.resolve().then(send).then(result => {
      if (!result?.delivered) throw Error('텔레그램 발송 응답을 확인하지 못했습니다.');
      receipt.state = 'sent';
    }).catch(error => { lastError = error.message; receipt.state = 'failed'; receipt.error = error.message; });
  }
  function report(id, kind, snapshot) {
    const label = snapshot.targetId + ' · ' + (id.endsWith(':finding') ? '현장 점검 결과' : id.endsWith(':return-ack') ? '복귀 지시 반영 확인' : id.endsWith(':returned') ? '복귀 완료 요약' : id.endsWith(':complete') ? '점검·복귀 요약' : snapshot.paused ? '정지 확인' : '현재 상태');
    track(id, label, () => telegram.send({ id, kind, snapshot }));
  }
  function notify(id, text) { track(id, id.endsWith(':accepted') ? '명령 접수' : 'Go1 명령 안내', () => telegram.notify(id, text)); }
  function expire() {
    if (mission && !['complete', 'failed', 'cancelled'].includes(mission.state) && (!online() || now() - mission.created > 10 * 60 * 1000)) {
      mission.state = 'failed'; notify(mission.id + ':offline', '🐾 가상 Go1\n웹 점검 화면의 연결이 끊겼거나 임무 제한 시간을 초과했습니다. 점검 완료를 확인하지 못했습니다. 웹 화면의 로봇 상태를 확인하세요.');
    }
  }
  function status() { expire(); return { receiving: online(), busy: online() && receiver.busy, mission: safeJob(mission), lastError, deliveries: deliveries.map(d => ({ ...d })), sentCount: telegram.counters?.().sentCount ?? null }; }

  async function handle(raw) {
    await ready;
    if (!fields(raw, ['messageId', 'chatId', 'userId', 'threadId', 'text']) || !/^\d{1,20}$/.test(raw.messageId)
      || !/^-?\d{1,20}$/.test(raw.chatId) || !/^\d{1,20}$/.test(raw.userId)
      || raw.threadId !== null && !/^\d{1,13}$/.test(raw.threadId) || typeof raw.text !== 'string' || raw.text.length > 2000) throw Error('Go1 수신 메시지 형식이 올바르지 않습니다.');
    if (!await telegram.authorizeRemote(raw)) throw Object.assign(Error('등록한 텔레그램 대화방과 사용자만 Go1에게 지시할 수 있습니다.'), { code: 'REMOTE_DENIED' });
    const command = parseGo1Command(raw.text); if (!command) return { handled: false };
    const key = createHash('sha256').update(raw.chatId + ':' + raw.messageId).digest('hex');
    if (seen.has(key)) return { handled: true, duplicate: true, id: seen.get(key).id };
    const id = 'GO1-' + randomUUID(); seen.set(key, { id });
    if (seen.size > 1000) seen.delete(seen.keys().next().value);
    await save(); expire();
    if (command.action === 'help') notify(id, GO1_COMMAND_HELP);
    else if (!online()) notify(id, '🐾 가상 Go1\n점검 화면이 연결되지 않았습니다. 노트북의 http://localhost:5180/에서 스마트폰 명령 받기를 켜고 화면을 열어둔 뒤 다시 지시하세요.');
    else if (command.action === 'status') report(id, 'status', receiver.snapshot);
    else if (command.action === 'stop') {
      if (stop?.state === 'offered') notify(id, '🐾 가상 Go1\n앞선 정지 지시를 처리 중입니다.');
      else { stop = { id, action: 'stop', state: 'offered' }; notify(id + ':accepted', '🐾 가상 Go1\n정지 지시를 받았습니다. 웹 로봇의 정지 결과를 확인하겠습니다.'); }
    } else if (command.action === 'return') {
      const s = receiver.snapshot;
      if (stop?.state === 'offered') notify(id, '🐾 가상 Go1\n정지 지시를 처리 중입니다. 정지 확인을 받은 뒤 복귀를 다시 지시하세요.');
      else if (mission?.action === 'return' && mission.state === 'offered') notify(id, '🐾 가상 Go1\n앞선 복귀 지시를 처리 중입니다. 웹 로봇의 실행 확인을 기다립니다.');
      else if (['idle', 'complete'].includes(s.stage)) report(id, 'status', s);
      else if (s.mission !== 'inspection') notify(id, '🐾 가상 Go1\n현재는 시설 대응 시나리오를 실행 중입니다. Go1 복귀는 장비 점검 임무에서 사용할 수 있습니다.');
      else if (s.stage === 'return' && !s.paused) report(id, 'status', s);
      else if (!s.link || s.battery <= 20) notify(id, '🐾 가상 Go1\n연결 또는 배터리 제약으로 복귀를 보류했습니다. 웹에서 연결·충전 상태를 복구한 뒤 복귀를 다시 지시하세요.');
      else {
        mission = { id, action: 'return', targetId: s.targetId, state: 'offered', clientId: receiver.id, created: now(), findingSent: true, returnAckSent: false, runId: s.runId };
        notify(id + ':accepted', '🐾 가상 Go1 · 복귀 지시 접수\n' + s.targetId + ' 점검 위치에서 도킹 위치로 돌아가겠습니다. 관측 판정은 유지하며 웹 로봇의 복귀를 확인해 보고합니다.');
      }
    } else if (receiver.busy || mission && !['complete', 'failed', 'cancelled'].includes(mission.state)) notify(id, '🐾 가상 Go1\n현재 임무가 진행 중입니다. Go1 상태로 진행을 확인하세요. 정지한 임무는 웹에서 초기화한 뒤 새 점검을 지시하세요.');
    else if (!receiver.snapshot.link || receiver.snapshot.battery <= 20) notify(id, '🐾 가상 Go1\n연결 또는 배터리 제약으로 출동을 보류했습니다. 웹에서 연결·충전 상태를 복구한 뒤 다시 지시하세요.');
    else {
      mission = { id, ...command, state: 'offered', clientId: receiver.id, created: now(), findingSent: false, runId: null };
      notify(id + ':accepted', '🐾 가상 Go1 · 점검 접수\n' + command.targetId + '로 이동해 이상 유무를 확인하고 가상 설비 사진과 관측값을 보고하겠습니다.\n브라우저 시뮬레이션의 점검 임무입니다.');
    }
    return { handled: true, duplicate: false, id, action: command.action };
  }
  function accept(raw) { const request = inbox.catch(() => {}).then(() => handle(raw)); inbox = request; return request; }
  async function poll(raw) {
    await ready;
    if (!fields(raw, ['clientId', 'visible', 'busy', 'snapshot', 'ackId', 'jobId', 'error']) || !/^[a-f0-9-]{36}$/.test(raw.clientId)
      || typeof raw.visible !== 'boolean' || typeof raw.busy !== 'boolean' || raw.ackId !== null && !/^GO1-[a-f0-9-]{36}$/.test(raw.ackId)
      || raw.jobId !== null && !/^GO1-[a-f0-9-]{36}$/.test(raw.jobId) || typeof raw.error !== 'string' || raw.error.length > 300) throw Error('Go1 점검 화면 상태가 올바르지 않습니다.');
    const snapshot = validateGo1Notice({ id: 'remote-preview', kind: 'status', snapshot: raw.snapshot }).snapshot;
    expire();
    if (receiver && now() - receiver.at < LEASE_MS && receiver.id !== raw.clientId) throw Object.assign(Error('다른 웹 화면이 스마트폰 명령을 받고 있습니다. 그 화면에서 명령 받기를 꺼주세요.'), { code: 'REMOTE_BUSY' });
    receiver = { id: raw.clientId, visible: raw.visible, busy: raw.busy, snapshot, at: now() };
    if (stop && raw.ackId === stop.id && stop.state === 'offered') {
      stop.state = raw.error || !snapshot.paused ? 'failed' : 'complete';
      if (stop.state === 'complete') { if (mission && mission.state !== 'complete') mission.state = 'cancelled'; report(stop.id + ':stopped', 'status', snapshot); }
      else notify(stop.id + ':failed', '🐾 가상 Go1\n정지 결과를 확인하지 못했습니다. 웹 화면에서 상태를 확인하세요.');
    }
    if (mission && mission.clientId === raw.clientId && raw.jobId === mission.id && !['complete', 'failed', 'cancelled'].includes(mission.state)) {
      if (raw.error || snapshot.mission !== 'inspection' || snapshot.targetId !== mission.targetId || mission.runId && snapshot.runId !== mission.runId
        || mission.action === 'return' && mission.state === 'offered' && (raw.ackId !== mission.id || !['return', 'complete'].includes(snapshot.stage) || snapshot.paused)) {
        mission.state = 'failed'; notify(mission.id + ':failed', '🐾 가상 Go1\n점검 실행을 완료하지 못했습니다. 웹 화면의 실행 상태와 오류를 확인하세요.');
      } else {
        mission.runId = snapshot.runId; mission.state = snapshot.paused || !snapshot.link || snapshot.battery <= 20 ? 'paused' : snapshot.stage;
        if (mission.action === 'return' && !mission.returnAckSent) { mission.returnAckSent = true; report(mission.id + ':return-ack', 'status', snapshot); }
        if (snapshot.finding !== 'pending' && !mission.findingSent) { mission.findingSent = true; report(mission.id + ':finding', 'report', snapshot); }
        if (snapshot.stage === 'complete') { mission.state = 'complete'; report(mission.id + (mission.action === 'return' ? ':returned' : ':complete'), 'report', snapshot); }
      }
    }
    return { ...status(), command: raw.visible ? safeJob(stop?.state === 'offered' ? stop : mission?.state === 'offered' && mission.clientId === raw.clientId ? mission : null) : null };
  }
  function release(clientId) {
    if (receiver?.id === clientId) { receiver = null; expire(); stop = null; }
    return { receiving: false };
  }
  function photo(raw) {
    expire();
    if (!fields(raw, ['clientId', 'jobId', 'snapshot', 'image'])) throw Error('점검 사진 요청이 올바르지 않습니다.');
    if (!online() || !mission || mission.action !== 'inspect' || mission.clientId !== raw.clientId || receiver.id !== raw.clientId || mission.id !== raw.jobId
      || ['offered', 'failed', 'cancelled'].includes(mission.state) || !mission.findingSent) throw Object.assign(Error('현재 연결된 점검 임무의 관측 사진만 보낼 수 있습니다.'), { code: 'REMOTE_DENIED' });
    const input = { id: mission.id + ':photo', snapshot: raw.snapshot, image: raw.image };
    const checked = validateInspectionPhoto(input), observed = receiver.snapshot;
    if (checked.snapshot.runId !== mission.runId || checked.snapshot.runId !== observed.runId || checked.snapshot.targetId !== mission.targetId
      || checked.snapshot.finding !== observed.finding || ['temperature', 'reported', 'thermal'].some(k => checked.snapshot[k] !== observed[k])
      || checked.snapshot.time > observed.time + .1 || Date.parse(checked.image.capturedAt) > now() + 5000 || now() - Date.parse(checked.image.capturedAt) > 10 * 60 * 1000) throw Error('사진과 현재 점검 관측 기록이 일치하지 않습니다.');
    if (mission.photo) {
      if (mission.photoFingerprint !== checked.fingerprint) throw Error('같은 임무의 점검 사진을 변경할 수 없습니다.');
      return { accepted: true, id: input.id, duplicate: true };
    }
    const job = mission;
    job.photoFingerprint = checked.fingerprint;
    job.photo = { state: 'sending', error: null };
    track(input.id, mission.targetId + ' · 가상 설비 점검 사진', async () => {
      try {
        const receipt = await telegram.sendPhoto(input);
        if (!receipt?.delivered) throw Error('텔레그램 사진 발송 응답을 확인하지 못했습니다.');
        job.photo = { state: 'sent', error: null }; return receipt;
      } catch (error) { job.photo = { state: 'failed', error: error.message }; throw error; }
    });
    return { accepted: true, id: input.id, duplicate: false };
  }
  return { accept, poll, release, status, photo };
}
