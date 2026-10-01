"""Use the installed Hermes CLI with a process-local, empty toolset."""
import os
import sys
from pathlib import Path

agent_root = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(agent_root))
os.environ["PYTHONIOENCODING"] = "utf-8"
from toolsets import create_custom_toolset, resolve_toolset
create_custom_toolset("facility_plan_only", "Facility observation classification; no tools.", tools=[], includes=[])
if resolve_toolset("facility_plan_only"):
    raise RuntimeError("Facility plan toolset must be empty")
prompt = sys.stdin.read()
sys.argv = ["hermes", "--ignore-rules", "-t", "facility_plan_only", "-z", prompt]
from hermes_cli.main import main
main()
