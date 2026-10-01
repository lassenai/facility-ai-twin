# Facility AI Twin

A browser-based MVP that connects **detection → agent reasoning → on-site inspection → intervention → verification → return to dock** in a simulated facility. Explore how an agent and a virtual inspection robot respond to equipment incidents, with Korean explanations and a traceable execution log.

**[Open the live demo](https://lassenai.github.io/facility-ai-twin/)** · [GitHub repository](https://github.com/lassenai/facility-ai-twin)

Runs on desktop and mobile browsers without Unity, Unreal Engine, or an app installation. On mobile, start with the default **rule-based agent and lightweight autonomous control**. The public demo stays available when your local computer is turned off.

![Facility AI Twin browser interface](docs/preview.png)

## Quick start

Requires **Node.js 22.12 or later**.

```sh
git clone https://github.com/lassenai/facility-ai-twin.git
cd facility-ai-twin
npm ci
npm run dev
```

Open **[http://localhost:5180/](http://localhost:5180/)** in your browser.

After installing dependencies, Windows users can start both the web server and local agent bridge with:

```powershell
powershell -ExecutionPolicy Bypass -File .\Launch-Demo.ps1
```

Stop the background processes started by this launcher with:

```powershell
powershell -ExecutionPolicy Bypass -File .\Stop-Demo.ps1
```

For servers started manually in a terminal, use `Ctrl+C` in that terminal.

The basic demo requires no API key or agent server. A phone on the same Wi-Fi network can connect using the **Network** URL printed by Vite, on port `5180`. Access depends on your firewall and network's device-to-device communication settings.

The application interface is currently in Korean. The labels below include their Korean text so you can find the controls.

## Demo features

### Facility incident response

Choose a scenario and start the simulation. The agent explains its decision, the robot travels to the inspection point, and the execution log records observations and actions.

| Situation | Agent decision | Robot or facility action |
|---|---|---|
| Equipment overheating | Cross-check the temperature sensor against an independent simulated thermal observation | Travel → inspect → set auxiliary ventilation to 85% → verify stabilization → return to dock |
| Sensor fault | Identify disagreement between the sensor and thermal observation | Inspect on site, retain ventilation settings, and record a sensor recalibration request |
| Communication loss | Wait for reconnection and recheck state | Set the drive command to zero; resume after the user restores the connection |
| Blocked corridor | Update the traversable area | Replan the A* route and navigate around the obstacle |
| Low battery | Hold the mission at 20% charge or below | Suspend dispatch or driving; resume after the battery state is restored |

The interface includes selectable equipment, orbit/top-down/robot-follow cameras, a simulated thermal view, 1×/2×/4× speed, pause/reset controls, temperature comparisons, mission reports, and JSON downloads. Mobile layouts include a start button at the bottom of the screen.

### Autonomous equipment inspection

In **Go1 Autonomous Inspection** (`Go1 자율 점검`), select equipment and an inspection condition, then click **Send for Inspection** (`점검 보내기`). You can also select equipment in the 3D scene and click **Send to Inspect This Equipment** (`이 장비 점검 보내기`).

After arriving, Go1 reports the sensor reading, thermal observation, their difference, and an inspection finding:

- **Normal:** automatically return to the docking point.
- **Suspected overheating, sensor mismatch, or unconfirmed:** remain on site for review. Click **Acknowledge Report · Return** (`보고 확인 · 복귀 지시`) to send the robot back.
- **Return before observation:** report that the on-site inspection was not completed.

Findings remain available after return. Inspection-only missions do not change ventilation settings. This workflow runs on the public demo without an API or local bridge.

### On-site photo reports

Facility response scenarios and autonomous inspections produce a **virtual on-site photo** after the robot observes equipment from its inspection position. The same image appears in the agent card under **On-site Photo Received** (`현장 사진 도착`) and in the **Field Report** (`현장 보고`). Click it to enlarge or download a JPEG.

Photos render the 3D simulation scene from a virtual camera at the robot's observed pose. Each image identifies the virtual camera and synthetic observations, equipment ID, readings, finding, and capture time. Readings remain fixed at capture time; the agent explanation and temperature chart show the current state after intervention.

Rule-based capture, viewing, and downloading work without an API or bridge. Codex and Hermes use the same photo workflow after returning their initial plan.

## Agent modes

| Mode | Execution | Availability |
|---|---|---|
| Rule-based agent (`Agent · 규칙 기반`) | Deterministic incident classification and execution logic in the browser | Public demo, localhost, and LAN |
| Codex (`Codex · 로컬 CLI`) | Initial decision from the installed Codex CLI, followed by validated simulation execution | Localhost with the bridge |
| Hermes (`Hermes · 로컬 CLI`) | Initial decision from the installed Hermes environment, followed by validated simulation execution | Localhost with the bridge |

To connect installed agents, start the bridge in a separate terminal:

```sh
npm run agent:bridge
```

If the bridge is already running, the command exits normally and tells you to use the existing instance. If another application occupies port `5181`, it displays a port-check message.

On the localhost page, select Codex or Hermes from the agent menu. These modes use installed software and existing authentication/model settings. The app does not store an API key. A local CLI may still use a hosted model, internet access, and account usage depending on its configuration.

The agent receives observation JSON and returns an initial inspection plan with a Korean explanation. Simulation time pauses while awaiting the response. The browser and bridge validate allowed targets/actions and sensor/battery constraints before execution. Invalid output or connection failure holds the mission and displays the reason; it does not silently switch to the rule-based agent.

The bridge binds to **`127.0.0.1:5181`** and uses Vite's `/agent` proxy, allowed localhost origins, and a session token. Public and LAN pages cannot invoke the local CLI. User input is not accepted as a shell command. Codex runs in a temporary read-only session; Hermes runs in a dedicated process with no tools. Results are stored in the Git-ignored `.runtime/` directory.

If automatic discovery fails, set the relevant paths in the terminal that starts the bridge:

```powershell
$env:CODEX_CLI_PATH = 'C:\...\codex.exe'
$env:HERMES_CLI_PATH = 'C:\...\hermes.exe'
$env:HERMES_AGENT_ROOT = 'C:\...\hermes-agent'
$env:HERMES_PYTHON_PATH = 'C:\...\hermes-agent\venv\Scripts\python.exe'
npm run agent:bridge
```

The Hermes decision adapter registers an empty tool set inside its own process without changing your Hermes configuration. Changes to Hermes's internal Python modules may require adapter updates.

## Telegram reports and smartphone commands

The local bridge reuses your existing Hermes bot token and default chat configuration. Refresh the localhost demo and click **Telegram** (`텔레그램`) to view the destination and message preview.

- **Send Current Status** (`현재 상태 보내기`): position, sensor/thermal readings, battery, connection, speed, and ventilation state.
- **Response Summary** (`대응 요약`): reasoning, verification/return results, travel distance, and policy inference count.
- **Automatic Mission Reports** (`임무 진행 자동 보고`): subsequent alerts, decisions, travel, inspection, intervention, stop/recovery, and return events.
- **Connection Test** (`연결 테스트`): send a confirmation message from virtual Go1 to the existing chat.

Automatic reporting is off by default. Messages identify **virtual Go1 R-01** and the **browser simulation**. Only Telegram-confirmed deliveries appear as sent. Requests with uncertain outcomes are not automatically resent.

### Text commands

Enable **Receive Smartphone Commands** (`스마트폰 명령 받기`) on the localhost page, then send commands to the existing Hermes chat:

| Example command | Meaning |
|---|---|
| `Go1 CH-02 점검해줘` | Inspect CH-02 |
| `Go1 공조 유닛 점검해줘` | Inspect the air-handling unit |
| `Go1 상태` | Report current status |
| `Go1 정지` | Stop the robot |
| `Go1 복귀` | Return to dock |

The command workflow supports travel, observation, findings, simulated equipment photos, reporting, and return for all five equipment items. Telegram return commands also work for inspections started in the browser. Returning before observation reports an incomplete inspection.

Choose overheating, sensor fault, normal, or current-model conditions in the inspection settings. Inspection commands do not change ventilation settings. Keep the localhost browser page open to execute missions.

### Voice commands: “고원” → Go1

The Korean voice name is **고원** (*Gowon*), normalized to **Go1**. Use the microphone in the existing Hermes Telegram chat to send a voice message:

| Voice command | Meaning |
|---|---|
| `고원아, 공조 유닛 점검해줘` | Gowon, inspect the air-handling unit |
| `고원아, 상태 알려줘` | Gowon, report your status |
| `고원아, 정지해줘` | Gowon, stop |
| `고원아, 복귀해줘` | Gowon, return to dock |

Hermes transcribes Korean locally with Whisper, displays the recognized sentence, and routes supported instructions to the twin. Ordinary voice conversations continue through Hermes. Go1 command parsing does not require an additional LLM call.

On Windows with Hermes installed, install the extension and configure Korean STT using:

```powershell
.\Install-Hermes-Go1.ps1 -Voice
```

Restart your existing `hermes gateway` afterward. The default Whisper model is `base`, running on CPU with int8 precision. The first transcription requires a model download; subsequent transcription runs locally. The installer backs up the target Hermes configuration and leaves other profiles unchanged. It uses the bot's existing message receiver.

Bot credentials are read only on the server and excluded from the browser, repository, and public build. Public and LAN pages provide message previews; actual Telegram sending and smartphone command reception require the localhost setup. See [Telegram setup and usage](docs/TELEGRAM.md).

## Robot control modes

**Lightweight Autonomous Control** (`경량 자율 제어`) is the default for mobile use and presentations. It uses A* planning and a kinematic model, with obstacle clearance and connection/battery constraints. It is not a learned control policy.

**Go1 Locomotion Policy · Precise** (`Go1 보행정책 · 정밀`) runs MuJoCo contact physics and a public ONNX joint-control policy in the browser. It renders simulated joint and rigid-body states while following an A* route from position observations. Facility decision and navigation policies were not newly trained with reinforcement learning for this project. Execution stops if the robot loses its supported posture.

Precise mode loads approximately **35 MB** of MuJoCo/ONNX WASM and Go1 assets on first selection. Performance varies by device. Lightweight mode does not preload these assets.

## GitHub Pages deployment

The published demo is **[https://lassenai.github.io/facility-ai-twin/](https://lassenai.github.io/facility-ai-twin/)**.

[`.github/workflows/pages.yml`](.github/workflows/pages.yml) tests, builds, and deploys changes pushed to `main`. GitHub Pages is configured with **Settings → Pages → Source → GitHub Actions**. Relative asset paths support project URLs such as `/facility-ai-twin/`.

To check a production build locally:

```sh
npm test
npm run build
npm run preview
```

The public site supports the rule-based agent, both robot modes, autonomous inspections, photo reports, and Telegram message previews. It runs without your notebook staying online. Local CLI execution, actual Telegram delivery, and smartphone command reception require the localhost bridge and browser page.

## Technology and documentation

- **Three.js:** a cutaway equipment room, equipment, pipes, robot, and state overlays.
- **Simulation:** time-based state transitions, synthetic sensor/thermal observations, thermal dynamics, interventions, and execution evidence.
- **MuJoCo + ONNX Runtime:** optional Go1 physics and locomotion policy execution.
- **Local CLI bridge:** initial decision requests, output validation, cancellation, timeouts, and concurrency limits.
- **Telegram bridge:** reuse of the Hermes chat, observation-based reports and photos, sequential delivery, and duplicate-request handling.
- **Tests:** response ordering, sensor faults, obstacles, connection/battery constraints, independent report snapshots, decision validation, HTTP access restrictions, and Telegram configuration/delivery behavior.

Supporting documents are primarily in Korean:

- [Demo walkthrough](docs/DEMO.md)
- [Local agents and school PC/Docker connection design](docs/LOCAL_AGENTS.md)
- [Telegram reports and commands](docs/TELEGRAM.md)
- [Design direction](docs/DESIGN.md)
- [Verification records](docs/VERIFICATION.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

Verification records describe automated tests and browser/CLI checks, including their conditions and limits.

## Current scope

The facility geometry and thermal dynamics are examples. Sensor and thermal values are synthetic observations; inspection photos are rendered simulation images. Ventilation changes and recalibration requests affect simulation state and execution records. Telegram delivery is real when configured. The project is not connected to ICTWAY's platform, a building management system, or a physical robot.

The “without intervention” temperature is a simple thermal-model comparison using the same initial conditions. It does not establish measured effects in a real facility.

Fruit-fly brain research is a future direction for comparing sensory integration and obstacle-avoidance policies in the same environment. This MVP does not embed a fly connectome or claim validated industrial safety or physical control performance.

## License

New project code is licensed under **Apache-2.0**. Public models, policies, libraries, and fonts retain their respective licenses. See [LICENSE](LICENSE), [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), and [LICENSES](LICENSES).
