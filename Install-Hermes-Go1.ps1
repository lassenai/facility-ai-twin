param([string]$HermesHome = $env:HERMES_HOME, [switch]$Voice, [ValidateSet('base', 'small')][string]$WhisperModel = 'base')
$ErrorActionPreference = 'Stop'
if (-not $HermesHome) { $HermesHome = Join-Path $env:LOCALAPPDATA 'hermes' }
$sourcePath = Join-Path $PSScriptRoot 'integrations\hermes\facility-go1'
$destinationPath = Join-Path $HermesHome 'plugins\facility-go1'
$hermesBinary = Join-Path $HermesHome 'hermes-agent\bin\hermes.exe'
if (-not (Test-Path -LiteralPath $hermesBinary)) { throw 'Hermes 실행기를 찾지 못했습니다. 설치된 Hermes 홈을 -HermesHome으로 지정하세요.' }
if ($Voice) {
    $hermesPython = Join-Path $HermesHome 'hermes-agent\venv\Scripts\python.exe'
    $uvBinary = Join-Path $HermesHome 'bin\uv.exe'
    if (-not (Test-Path -LiteralPath $hermesPython)) { throw 'Hermes Python 가상환경을 찾지 못했습니다.' }
    if (-not (Test-Path -LiteralPath $uvBinary)) { $uvBinary = (Get-Command uv -ErrorAction Stop).Source }
    & $uvBinary pip install --python $hermesPython 'faster-whisper>=1.2.1,<2' 'ruamel.yaml>=0.18,<1'
    if ($LASTEXITCODE -ne 0) { throw '한국어 로컬 STT 의존성 설치가 실패했습니다.' }
    & $hermesPython (Join-Path $PSScriptRoot 'integrations\hermes\configure_voice.py') --home $HermesHome --model $WhisperModel
    if ($LASTEXITCODE -ne 0) { throw 'Hermes 한국어 STT 설정이 실패했습니다.' }
}
if (Test-Path -LiteralPath $destinationPath) {
    $backupPath = Join-Path $PSScriptRoot ('.runtime\hermes-plugin-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    New-Item -ItemType Directory -Path $backupPath -Force | Out-Null
    Copy-Item -LiteralPath $destinationPath -Destination $backupPath -Recurse
}
New-Item -ItemType Directory -Path $destinationPath -Force | Out-Null
foreach ($name in @('plugin.yaml', '__init__.py')) {
    Copy-Item -LiteralPath (Join-Path $sourcePath $name) -Destination (Join-Path $destinationPath $name) -Force
}
$previousHermesHome = [Environment]::GetEnvironmentVariable('HERMES_HOME', 'Process')
try {
    $env:HERMES_HOME = $HermesHome
    & $hermesBinary plugins enable facility-go1 --no-allow-tool-override
    if ($LASTEXITCODE -ne 0) { throw 'Hermes Go1 플러그인 활성화가 실패했습니다.' }
} finally {
    [Environment]::SetEnvironmentVariable('HERMES_HOME', $previousHermesHome, 'Process')
}
Write-Host 'Go1 명령 연결을 설치했습니다. 기존 Hermes gateway를 재시작하면 적용됩니다.'
if ($Voice) { Write-Host '기존 봇의 마이크로 고원아, 공조 유닛 점검해줘 라고 말하세요. 첫 음성 인식 시 Whisper 모델을 다운로드합니다.' }
