import { GO1_REPORT_TOOLS, go1Snapshot, go1Event, formatGo1Message } from './go1-reports.js';

export function mountTelegram({ getState, toast }) {
  const $ = id => document.getElementById(id);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  let token = null, connected = false, checking = false, sending = false, queue = [], sent = 0;
  let runId = '', cursor = 0, lastPreview = 0, history = [];
  const remoteReceipts = new Set();
  const write = (id, value) => { $(id).textContent = value; };
  const notice = (kind, id = crypto.randomUUID(), event) => ({ id, kind, snapshot: go1Snapshot(getState()), ...(event ? { event: go1Event(event) } : {}) });
  function controls() {
    $('telegramSend').disabled = !connected || sending;
    $('telegramTest').disabled = !connected || sending;
    $('telegramAuto').disabled = !connected;
    $('remoteReceive').disabled = !local || !connected;
    $('telegramRefresh').disabled = checking || sending;
    write('telegramSendLabel', sending ? '보고 전송 중' : $('telegramKind').value === 'report' ? '대응 요약 보내기' : '현재 상태 보내기');
    $('telegramState').dataset.state = connected ? 'ready' : 'offline';
  }
  async function json(url, options = {}) {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(20000) });
    let result;
    try { result = await response.json(); } catch { throw Error('로컬 브리지를 실행하세요: npm run agent:bridge'); }
    if (!response.ok) throw Error(result.error || '텔레그램 요청을 처리하지 못했습니다.');
    return result;
  }
  async function check(refresh = false) {
    if (checking || !local) return;
    checking = true; controls(); write('telegramState', '연결 확인 중');
    try {
      const health = await json('/agent/health'); token = health.token;
      if (!health.capabilities?.telegram) throw Error('새 텔레그램 기능을 사용하려면 로컬 브리지를 다시 실행하세요.');
      const status = await json('/agent/telegram/status' + (refresh ? '?refresh=1' : ''), { headers: { 'X-Twin-Token': token } });
      connected = status.connected; sent = status.sentCount || 0;
      write('telegramState', connected ? '전송 준비됨' : '연결 필요');
      write('telegramDestination', connected ? (status.botUsername ? '@' + status.botUsername + ' → ' : '') + status.chatTitle + ' (' + status.recipient + ')' : '받는 대화방을 연결해 주세요');
      write('telegramDetail', connected ? status.source + '로 Go1의 관측과 임무 결과를 보냅니다.' : status.error);
      write('telegramCount', sent + '개 전송');
    } catch (error) {
      connected = false; write('telegramState', '연결 필요'); write('telegramDetail', error.message);
    } finally {
      checking = false;
      if (!connected) $('telegramAuto').checked = false;
      controls();
    }
  }
  function log(message, success) {
    history.unshift({ message, success }); history = history.slice(0, 4);
    $('telegramHistory').replaceChildren(...history.map(item => {
      const row = document.createElement('li'); row.dataset.result = item.success ? 'sent' : 'failed';
      const badge = document.createElement('span'); badge.textContent = item.success ? '전송됨' : '확인 필요';
      const detail = document.createElement('span'); detail.textContent = item.message;
      row.append(badge, detail); return row;
    }));
  }
  async function drain() {
    if (sending) return;
    sending = true; controls();
    while (queue.length) {
      const input = queue.shift();
      try {
        const receipt = await json('/agent/telegram/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Twin-Token': token }, body: JSON.stringify(input) });
        if (!receipt.delivered) throw Error('전송 완료를 확인하지 못했습니다.');
        sent++; write('telegramCount', sent + '개 전송');
        const label = input.event?.title || ({ test: '연결 확인', status: '현재 상태', report: '대응 요약' }[input.kind]);
        log(label + ' · ' + receipt.runId, true);
        if (input.kind !== 'event') toast('Go1의 ' + label + '를 텔레그램으로 보냈습니다.');
      } catch (error) {
        const message = error.name === 'TimeoutError' || error.name === 'TypeError' ? '전송 결과를 확인하지 못했습니다. 텔레그램 대화방을 확인하세요.' : error.message;
        log(message, false); toast(message); queue = []; $('telegramAuto').checked = false;
      }
    }
    sending = false; controls();
  }
  function enqueue(input) {
    if (!connected) return;
    if (queue.length >= 20) {
      $('telegramAuto').checked = false; queue = queue.filter(item => item.kind !== 'event');
      toast('Go1 보고가 많이 쌓여 자동 보고를 중지했습니다.'); return;
    }
    queue.push(input); drain();
  }
  function sync(force = false) {
    const s = getState();
    if (runId !== s.runId) { runId = s.runId; cursor = 0; }
    const updates = s.log.slice(cursor); cursor = s.log.length;
    if ($('telegramAuto').checked && connected && (!s.inspection || s.inspection.source === 'web' && !s.inspection.remoteReturn)) {
      for (const event of updates) {
        if (!$('telegramAuto').checked) break;
        if (GO1_REPORT_TOOLS.has(event.tool)) enqueue(notice('event', event.id + ':telegram', event));
      }
    }
    if (force || performance.now() - lastPreview > 1000) {
      lastPreview = performance.now(); write('telegramPreview', formatGo1Message(notice($('telegramKind').value, 'preview-only')));
    }
  }
  $('telegramRefresh').onclick = () => check(true);
  $('telegramJump').onclick = () => $('telegramPanel').scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  $('telegramKind').onchange = () => { sync(true); controls(); };
  $('telegramSend').onclick = () => enqueue(notice($('telegramKind').value));
  $('telegramTest').onclick = () => enqueue(notice('test'));
  $('telegramAuto').onchange = () => {
    const s = getState(); runId = s.runId; cursor = s.log.length;
    if (!$('telegramAuto').checked) queue = queue.filter(input => input.kind !== 'event');
    toast($('telegramAuto').checked ? '이후 경보·판단·점검·조치·복귀를 Go1이 자동 보고합니다.' : 'Go1 자동 보고를 중지했습니다.');
  };
  if (local) check();
  else {
    write('telegramState', '노트북에서 연결'); write('telegramDetail', '텔레그램 전송은 브리지가 실행 중인 localhost에서 사용할 수 있습니다. 공개 데모에서는 보고 미리보기를 확인하세요.');
    controls(); $('telegramRefresh').disabled = true;
  }
  sync(true);
  function receiveRemoteResults(result) {
    if (Number.isInteger(result.sentCount)) { sent = result.sentCount; write('telegramCount', sent + '개 전송'); }
    for (const receipt of [...(result.deliveries || [])].reverse()) {
      if (receipt.state === 'sending' || remoteReceipts.has(receipt.id)) continue;
      remoteReceipts.add(receipt.id); if (remoteReceipts.size > 100) remoteReceipts.delete(remoteReceipts.values().next().value);
      log(receipt.state === 'sent' ? receipt.label : receipt.error, receipt.state === 'sent');
    }
  }
  return { sync, receiveRemoteResults };
}
