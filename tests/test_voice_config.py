import contextlib
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
from ruamel.yaml import YAML

spec = importlib.util.spec_from_file_location("voice_config", Path(__file__).resolve().parents[1] / "integrations/hermes/configure_voice.py")
voice_config = importlib.util.module_from_spec(spec)
spec.loader.exec_module(voice_config)

class VoiceConfigTests(unittest.TestCase):
    def test_setup_preserves_other_settings_and_private_backup_without_printing_credentials(self):
        original = '# keep my configuration\nmodel:\n  provider: fixture\ncredential: "fixture-private-value"\nprofiles: [blog, cardnews]\nstt:\n  local:\n    idle_unload_seconds: 120\n  openai:\n    model: fixture-transcriber\n'
        yaml = YAML()
        before = yaml.load(original)
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "config.yaml"
            path.write_text(original, encoding="utf-8")
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                voice_config.configure(folder)
            after = yaml.load(path.read_text(encoding="utf-8"))
            self.assertEqual({k:v for k,v in before.items() if k != 'stt'}, {k:v for k,v in after.items() if k != 'stt'})
            self.assertEqual(after['stt']['openai'], before['stt']['openai'])
            self.assertEqual(after['stt']['local']['idle_unload_seconds'], 120)
            self.assertEqual(after['stt']['provider'], 'local')
            self.assertEqual(after['stt']['local']['language'], 'ko')
            backups = list(Path(folder).glob('config.before-go1-voice-*.yaml'))
            self.assertEqual(len(backups), 1)
            self.assertEqual(backups[0].read_text(encoding='utf-8'), original)
            self.assertIn('# keep my configuration', path.read_text(encoding='utf-8'))
            self.assertNotIn('fixture-private-value', output.getvalue())

if __name__ == '__main__':
    unittest.main()
