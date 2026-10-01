import importlib.util
import asyncio
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("facility_go1", ROOT / "integrations/hermes/facility-go1/__init__.py")
relay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(relay)

class RelayTests(unittest.TestCase):
    def event(self, text="Go1 CH-02 점검해줘", bot=False, platform="telegram"):
        source = SimpleNamespace(platform=SimpleNamespace(value=platform), chat_id="12345", user_id="12345", thread_id=None, is_bot=bot)
        return SimpleNamespace(text=text, source=source, message_id="11")

    def test_only_authorized_telegram_go1_messages_are_forwarded(self):
        gateway = SimpleNamespace(_is_user_authorized=lambda source: True)
        with patch.object(relay, "bridge_request") as request:
            for event in [self.event("오늘 일정"), self.event(bot=True), self.event(platform="discord")]:
                self.assertIsNone(relay.forward_command(event, gateway))
            self.assertEqual(request.call_count, 0)
        with patch.object(relay, "bridge_request") as request:
            gateway._is_user_authorized = lambda source: False
            self.assertIsNone(relay.forward_command(self.event(), gateway))
            self.assertEqual(request.call_count, 0)

    def test_forwarded_event_preserves_sender_and_message_id_without_bot_credentials(self):
        gateway = SimpleNamespace(_is_user_authorized=lambda source: True)
        with patch.object(relay, "bridge_request", side_effect=[{"service": "facility-ai-twin-agent-bridge", "capabilities": {"remoteCommands": True}, "token": "fixture-local-session"}, {"handled": True}]) as request:
            self.assertEqual(relay.forward_command(self.event(), gateway)["action"], "skip")
            _, payload, token = request.call_args.args
            self.assertEqual(payload["userId"], "12345")
            self.assertEqual(payload["messageId"], "11")
            self.assertEqual(payload["threadId"], None)
            self.assertEqual(token, "fixture-local-session")
            self.assertNotIn("botToken", payload)

    def test_bridge_failure_is_consumed_and_has_an_explicit_gateway_reply(self):
        gateway = SimpleNamespace(_is_user_authorized=lambda source: True)
        with patch.object(relay, "bridge_request", side_effect=OSError("offline")), patch.object(relay, "_fallback") as fallback:
            self.assertEqual(relay.forward_command(self.event(), gateway)["action"], "skip")
            fallback.assert_called_once()

    def test_registers_the_supported_gateway_hook(self):
        class Context:
            def register_hook(self, name, callback):
                self.name = name
                self.callback = callback
        ctx = Context(); relay.register(ctx)
        self.assertEqual(ctx.name, "pre_gateway_dispatch")
        self.assertIs(ctx.callback, relay.forward_command)

    def test_spoken_name_is_normalized_only_at_the_beginning(self):
        for text in ["고원아, 복귀해 줘.", "고 원아! 복귀해 줘.", "Ｇｏ１ 복귀해 줘."]:
            self.assertEqual(relay.normalize_command(text), "Go1 복귀해 줘.")
        for text in ["오늘 고원아라고 말했어", "고원에서 날씨 알려줘", "고원아빠의 일정"]:
            self.assertIsNone(relay.normalize_command(text))


class VoiceRelayTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        relay._VOICE_SEEN.clear()
        relay._VOICE_LOCK = None
        self.adapter = SimpleNamespace(send=AsyncMock(), handle_message=AsyncMock())
        self.gateway = SimpleNamespace(
            _is_user_authorized=lambda source: True,
            _adapter_for_source=lambda source: self.adapter,
            _transcribe_and_echo_pending_voice=AsyncMock(return_value=('"고원아, 복귀해 줘."', ["고원아, 복귀해 줘."])),
        )

    def event(self, message_id="voice-11"):
        event = RelayTests().event("")
        event.message_id = message_id
        event.message_type = SimpleNamespace(value="voice")
        event.media_urls = ["fixture-voice.ogg"]
        event.media_types = ["audio/ogg"]
        return event

    async def finish(self):
        if relay._VOICE_TASKS:
            await asyncio.gather(*list(relay._VOICE_TASKS))
        await asyncio.sleep(0)

    async def asyncTearDown(self):
        await self.finish()

    async def test_voice_authentication_precedes_transcription(self):
        self.gateway._is_user_authorized = lambda source: False
        self.assertIsNone(relay.forward_command(self.event(), self.gateway))
        self.gateway._transcribe_and_echo_pending_voice.assert_not_awaited()
        self.assertFalse(relay._VOICE_TASKS)

    async def test_voice_transcript_maps_to_command_with_original_identity_once(self):
        event = self.event()
        with patch.object(relay, "bridge_request", side_effect=[{"service": "facility-ai-twin-agent-bridge", "capabilities": {"remoteCommands": True}, "token": "fixture-local-session"}, {"handled": True}]) as request:
            self.assertEqual(relay.forward_command(event, self.gateway)["action"], "skip")
            self.assertEqual(relay.forward_command(self.event(), self.gateway)["action"], "skip")
            await self.finish()
            self.assertEqual(request.call_count, 2)
            payload = request.call_args.args[1]
            self.assertEqual(payload["text"], "Go1 복귀해 줘.")
            self.assertEqual(payload["messageId"], "voice-11")
            self.assertEqual(payload["chatId"], event.source.chat_id)
            self.assertEqual(payload["userId"], event.source.user_id)
        self.gateway._transcribe_and_echo_pending_voice.assert_awaited_once()
        self.adapter.handle_message.assert_not_awaited()

    async def test_general_voice_returns_the_same_cached_event_to_hermes(self):
        event = self.event()
        async def transcribe(*args, **kwargs):
            event._gateway_pending_stt_text = '"오늘 일정 알려줘"'
            event._gateway_pending_stt_transcripts = ["오늘 일정 알려줘"]
            event._gateway_pending_stt_echoed = 1
            return event._gateway_pending_stt_text, event._gateway_pending_stt_transcripts
        self.gateway._transcribe_and_echo_pending_voice.side_effect = transcribe
        with patch.object(relay, "bridge_request") as request:
            relay.forward_command(event, self.gateway)
            await self.finish()
            request.assert_not_called()
        self.adapter.handle_message.assert_awaited_once_with(event)
        self.assertEqual(event.media_urls, ["fixture-voice.ogg"])
        self.assertEqual(event._gateway_pending_stt_echoed, 1)
        self.assertIsNone(relay.forward_command(event, self.gateway))

    async def test_failed_or_ambiguous_stt_never_guesses_or_forwards_commands(self):
        with patch.object(relay, "bridge_request") as request:
            self.gateway._transcribe_and_echo_pending_voice.return_value = ("", [])
            relay.forward_command(self.event("failed"), self.gateway)
            await self.finish()
            self.assertIn("지시를 실행하지 않았습니다", self.adapter.send.call_args.args[1])
            self.gateway._transcribe_and_echo_pending_voice.return_value = ("", ["고원아 점검해줘", "고원아 복귀해줘"])
            relay.forward_command(self.event("ambiguous"), self.gateway)
            await self.finish()
            self.assertIn("지시 하나", self.adapter.send.call_args.args[1])
            request.assert_not_called()
        self.adapter.handle_message.assert_not_awaited()

    async def test_voice_bridge_failure_replies_on_the_gateway_loop(self):
        with patch.object(relay, "bridge_request", side_effect=OSError("offline")):
            relay.forward_command(self.event(), self.gateway)
            await self.finish()
            await asyncio.sleep(0)
        self.assertIn("로컬 점검 브리지", self.adapter.send.call_args.args[1])
        self.adapter.handle_message.assert_not_awaited()

    async def test_voice_commands_keep_arrival_order_and_recheck_auth_after_stt(self):
        started = []
        async def transcribe(event, *args, **kwargs):
            started.append(event.message_id)
            await asyncio.sleep(.01)
            if event.message_id == "revoked":
                self.gateway._is_user_authorized = lambda source: False
            return "", ["고원아, 정지해줘"]
        self.gateway._transcribe_and_echo_pending_voice.side_effect = transcribe
        with patch.object(relay, "_forward_text", return_value={"action": "skip"}) as forward:
            relay.forward_command(self.event("first"), self.gateway)
            relay.forward_command(self.event("second"), self.gateway)
            await self.finish()
            self.assertEqual(started, ["first", "second"])
            self.assertEqual([call.args[0].message_id for call in forward.call_args_list], started)
            relay.forward_command(self.event("revoked"), self.gateway)
            await self.finish()
            self.assertEqual(forward.call_count, 2)

if __name__ == "__main__":
    unittest.main()
