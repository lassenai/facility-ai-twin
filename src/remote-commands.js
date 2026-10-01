import { FACILITY } from './facility.js';

export const GO1_COMMAND_HELP = '🐾 고원 · 가상 Go1 원격 점검\n\n기존 Hermes 대화방의 마이크로 말해보세요.\n고원아, 냉각 설비 점검해줘\n고원아, 공조 유닛 점검해줘\n고원아, 상태 알려줘\n고원아, 정지해줘\n고원아, 복귀해줘\n\nGo1 CH-02 점검해줘 같은 텍스트 명령도 지원합니다. 웹 데모에서 스마트폰 명령 받기를 켜고 화면을 열어두세요.';

// The spoken name maps only at the beginning; ordinary Hermes text stays intact.
export function normalizeGo1Command(text) {
  if (typeof text !== 'string') return null;
  const normalized = text.normalize('NFKC').trim().replace(/。/g, '.');
  const prefix = /^(?:\/go1(?:@[a-z0-9_]+)?\b|(?:go1|고1|고\s*원)(?:\s*[아야])?(?=\s|[,!:.?]|$))\s*[,!:.?]?\s*/i;
  if (!prefix.test(normalized)) return null;
  return 'Go1 ' + normalized.replace(prefix, '').trim();
}

export function parseGo1Command(text) {
  const normalized = normalizeGo1Command(text);
  if (normalized === null) return null;
  const content = normalized.slice(4).trim();
  if (normalized.length > 160 || /[\n;|`$<>]/.test(content)) return { action: 'help' };
  if (/^(?:정지(?:\s*해\s*(?:줘|주세요))?|멈춰(?:\s*(?:줘|주세요))?|중지(?:\s*해\s*(?:줘|주세요))?|stop)[.!?]*$/i.test(content)) return { action: 'stop' };
  if (/^(?:상태(?:\s*(?:알려\s*(?:줘|주세요)|보고\s*해\s*(?:줘|주세요)|확인))?|어디(?:에)?\s*있어|status)[.!?]*$/i.test(content)) return { action: 'status' };
  if (/^(?:(?:도킹\s*위치|기지)로\s*)?(?:복귀(?:\s*해\s*(?:줘|주세요))?|돌아\s*와(?:\s*(?:줘|주세요))?|도킹(?:\s*해\s*(?:줘|주세요))?|return|dock)[.!?]*$/i.test(content)) return { action: 'return' };
  if (!/(?:점검|확인|이상\s*유무|inspect|check)/i.test(content) || /(?:하지|취소|환기|가동|삭제|파일|powershell|shell|bash)/i.test(content)) return { action: 'help' };
  const ids = [...content.toUpperCase().matchAll(/\b[A-Z]{1,6}[\s-]?\d{1,3}\b/g)].map(m => m[0].replace(/\s/g, '').replace(/^([A-Z]+)-?(\d+)$/, (_, prefix, number) => prefix + '-' + number.padStart(2, '0')));
  const aliases = [['공조', 'AHU-01'], ['냉각', 'CH-02'], ['탱크', 'TK-01'], ['펌프', 'PU-01'], ['배전', 'EL-01']];
  for (const [name, id] of aliases) if (content.includes(name)) ids.push(id);
  const targets = [...new Set(ids)];
  if (targets.length > 1 || targets.some(id => !FACILITY.assets.some(a => a.id === id))) return { action: 'help' };
  return { action: 'inspect', targetId: targets[0] || 'CH-02' };
}
