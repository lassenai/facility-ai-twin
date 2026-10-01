"""Hermes owns Telegram updates and STT; 고원 maps to bounded Go1 commands."""
import asyncio
from collections import OrderedDict
import json
import logging
import re
import unicodedata
from urllib.request import Request, urlopen

BRIDGE = "http://127.0.0.1:5181"
PREFIX = re.compile(r"^(?:/go1(?:@[a-z0-9_]+)?\b|(?:go1|고1|고\s*원)(?:\s*[아야])?(?=\s|[,!:.?]|$))\s*[,!:.?]?\s*", re.I)
logger = logging.getLogger(__name__)
_VOICE_TASKS = set()
_VOICE_SEEN = OrderedDict()
_VOICE_LOCK = None

def normalize_command(text):
    if not isinstance(text, str):
        return None
    text = unicodedata.normalize("NFKC", text).strip().replace("。", ".")
    match = PREFIX.match(text)
    return "Go1 " + text[match.end():].strip() if match else None

def bridge_request(path, payload=None, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["X-Twin-Token"] = token
    data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = Request(BRIDGE + path, data=data, headers=headers, method="GET" if data is None else "POST")
    with urlopen(request, timeout=3) as response:
        return json.load(response)

def _adapter(gateway, source):
    resolve = getattr(gateway, "_adapter_for_source", None)
    return resolve(source) if callable(resolve) else gateway.adapters.get(source.platform)

async def _send(gateway, source, text):
    try:
        adapter = _adapter(gateway, source)
        if adapter:
            metadata = {"thread_id": source.thread_id} if source.thread_id else None
            await adapter.send(str(source.chat_id), text, metadata=metadata)
    except Exception:
        logger.warning("Facility Go1 reply delivery failed")

def _fallback(gateway, source):
    try:
        asyncio.get_running_loop().create_task(_send(gateway, source, "🐾 고원 · 가상 Go1\n로컬 점검 브리지에 연결하지 못했습니다. 노트북에서 npm run agent:bridge를 실행하고 웹의 스마트폰 명령 받기를 켜주세요."))
    except RuntimeError:
        pass

def _forward_text(event, gateway, text, loop=None):
    source = event.source
    message_id = getattr(event, "message_id", None) or getattr(source, "message_id", None)
    try:
        health = bridge_request("/agent/health")
        if health.get("service") != "facility-ai-twin-agent-bridge" or not health.get("capabilities", {}).get("remoteCommands"):
            raise RuntimeError("Bridge update required")
        result = bridge_request("/agent/remote/telegram", {
            "messageId": str(message_id), "chatId": str(source.chat_id), "userId": str(source.user_id),
            "threadId": str(source.thread_id) if source.thread_id else None, "text": text,
        }, health["token"])
        if not result.get("handled"):
            return None
    except Exception:
        if loop is not None:
            loop.call_soon_threadsafe(_fallback, gateway, source)
        else:
            _fallback(gateway, source)
    return {"action": "skip", "reason": "facility-go1 inspection command"}

async def _voice(event, gateway):
    source = event.source
    adapter = _adapter(gateway, source)
    transcribe = getattr(gateway, "_transcribe_and_echo_pending_voice", None)
    if not callable(transcribe) or adapter is None or not callable(getattr(adapter, "handle_message", None)):
        await _send(gateway, source, "🐾 고원\nHermes 음성 수신 기능을 확인해주세요. 우선 고원아, 상태 알려줘 같은 텍스트로 지시할 수 있습니다.")
        return
    try:
        # Reuse Hermes' download, provider selection, transcript echo and cache.
        # Serial decoding preserves the arrival order of inspection/stop/return.
        async with _VOICE_LOCK:
            if not gateway._is_user_authorized(source):
                return
            _, transcripts = await transcribe(event, adapter, source, getattr(event, "text", "") or "", log_context="Facility Go1 voice")
            if not gateway._is_user_authorized(source):
                return
            if not transcripts:
                await _send(gateway, source, "🎙️ 음성을 인식하지 못했습니다. 지시를 실행하지 않았습니다. 짧게 ‘고원아, 공조 유닛 점검해줘’라고 다시 말하거나 텍스트로 보내주세요.")
                return
            commands = [normalize_command(text) for text in transcripts]
            if any(command is not None for command in commands):
                if len(transcripts) != 1:
                    await _send(gateway, source, "🐾 고원\n여러 음성이 묶여 지시를 확정하지 못했습니다. 음성 메시지 한 개에 지시 하나를 보내주세요.")
                    return
                await asyncio.to_thread(_forward_text, event, gateway, commands[0], asyncio.get_running_loop())
                return
        # The original cached VOICE event re-enters the adapter's normal delivery
        # path. Hermes skips the STT/echo already done above, without losing media
        # metadata or bypassing its active-session and reply-delivery guards.
        event._facility_go1_voice_processed = True
        await adapter.handle_message(event)
    except Exception:
        logger.warning("Facility Go1 voice processing failed")
        await _send(gateway, source, "🎙️ 음성 지시 처리에 실패했습니다. 실행을 확인하지 못했습니다. 웹 상태를 확인하고 다시 지시해주세요.")

def _voice_done(task):
    _VOICE_TASKS.discard(task)
    if not task.cancelled() and task.exception() is not None:
        logger.warning("Facility Go1 voice task failed")

def forward_command(event=None, gateway=None, **kwargs):
    global _VOICE_LOCK
    source = getattr(event, "source", None)
    platform = getattr(getattr(source, "platform", None), "value", None)
    if platform != "telegram" or getattr(source, "is_bot", False):
        return None
    # This hook precedes gateway auth; authenticate before any STT or forwarding.
    authorize = getattr(gateway, "_is_user_authorized", None)
    if not callable(authorize) or not authorize(source):
        return None
    message_id = getattr(event, "message_id", None) or getattr(source, "message_id", None)
    if not message_id or not getattr(source, "user_id", None):
        return None
    if getattr(event, "_facility_go1_voice_processed", False):
        return None
    if getattr(getattr(event, "message_type", None), "value", None) == "voice":
        key = (str(source.chat_id), str(message_id))
        if key in _VOICE_SEEN:
            return {"action": "skip", "reason": "facility-go1 duplicate voice"}
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return None
        if len(_VOICE_TASKS) >= 4:
            loop.create_task(_send(gateway, source, "🎙️ 앞선 음성을 처리 중입니다. 잠시 후 지시를 다시 보내주세요."))
            return {"action": "skip", "reason": "facility-go1 voice busy"}
        if _VOICE_LOCK is None:
            _VOICE_LOCK = asyncio.Lock()
        _VOICE_SEEN[key] = True
        if len(_VOICE_SEEN) > 512:
            _VOICE_SEEN.popitem(last=False)
        task = loop.create_task(_voice(event, gateway))
        _VOICE_TASKS.add(task)
        task.add_done_callback(_voice_done)
        return {"action": "skip", "reason": "facility-go1 voice transcription"}
    text = normalize_command(getattr(event, "text", ""))
    return _forward_text(event, gateway, text) if text is not None else None

def register(ctx):
    ctx.register_hook("pre_gateway_dispatch", forward_command)
