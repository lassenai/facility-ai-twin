"""Enable local Korean Hermes STT, preserving other settings and a private backup."""
import argparse
from datetime import datetime
import io
import os
from pathlib import Path
import shutil
import tempfile

from ruamel.yaml import YAML

def configure(home, model="base"):
    path = Path(home) / "config.yaml"
    if not path.is_file():
        raise RuntimeError("Hermes config.yaml was not found")
    yaml = YAML()
    yaml.preserve_quotes = True
    yaml.width = 4096
    config = yaml.load(path.read_text(encoding="utf-8"))
    if not isinstance(config, dict):
        raise RuntimeError("Hermes configuration must be a YAML mapping")
    if config.get("stt") is None:
        config["stt"] = {}
    stt = config["stt"]
    if not isinstance(stt, dict):
        raise RuntimeError("Hermes stt settings must be a YAML mapping")
    stt.update(enabled=True, provider="local", language="ko", echo_transcripts=True)
    if stt.get("local") is None:
        stt["local"] = {}
    local = stt["local"]
    if not isinstance(local, dict):
        raise RuntimeError("Hermes stt.local settings must be a YAML mapping")
    local.update(model=model, language="ko", device="cpu", compute_type="int8",
                 initial_prompt="고원. 고원아. 냉각 설비. 공조 유닛. 탱크. 펌프. 배전반. 점검해줘. 상태 알려줘. 정지해줘. 복귀해줘.")
    buffer = io.StringIO()
    yaml.dump(config, buffer)
    # Keep credentials and backups in the Hermes home, outside this repository.
    backup = path.with_name("config.before-go1-voice-" + datetime.now().strftime("%Y%m%d-%H%M%S-%f") + ".yaml")
    shutil.copy2(path, backup)
    descriptor, temp_name = tempfile.mkstemp(prefix=".go1-voice-", suffix=".yaml", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as output:
            output.write(buffer.getvalue())
        os.replace(temp_name, path)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)
    print(f"Hermes STT: local/{model}, Korean, CPU int8, transcript echo enabled; configuration backed up in Hermes home.")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--home", required=True)
    parser.add_argument("--model", choices=["base", "small"], default="base")
    args = parser.parse_args()
    configure(args.home, args.model)
