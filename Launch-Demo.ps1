param([switch]$WithoutAgent)
$ErrorActionPreference = 'Stop'
$demoRoot = $PSScriptRoot
$nodeCommand = Get-Command node -ErrorAction Stop
$nodeBinary = $nodeCommand.Source
if (-not (Test-Path -LiteralPath (Join-Path $demoRoot 'node_modules/vite/bin/vite.js'))) {
    throw "Dependencies are missing. Run npm ci in $demoRoot first."
}
$runtimePath = Join-Path $demoRoot '.runtime'
New-Item -ItemType Directory -Path $runtimePath -Force | Out-Null
$pidFile = Join-Path $runtimePath 'launcher-processes.json'
$started = @()
if (Test-Path -LiteralPath $pidFile) {
    try { $started = @(Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json) } catch { $started = @() }
}
function Test-DemoPort([int]$Port) {
    $tcp = New-Object System.Net.Sockets.TcpClient
    try { $connection = $tcp.ConnectAsync('127.0.0.1', $Port); return ($connection.Wait(300) -and $tcp.Connected) }
    catch { return $false }
    finally { $tcp.Dispose() }
}
if (-not (Test-DemoPort 5180)) {
    $webChild = Start-Process -FilePath $nodeBinary -ArgumentList @('node_modules/vite/bin/vite.js', '--host', '0.0.0.0', '--port', '5180') -WorkingDirectory $demoRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimePath 'web.log') -RedirectStandardError (Join-Path $runtimePath 'web-error.log') -PassThru
    $started += @{ Pid = $webChild.Id; Started = $webChild.StartTime.ToUniversalTime().ToString('o'); Argument = 'node_modules/vite/bin/vite.js' }
}
if (-not $WithoutAgent -and -not (Test-DemoPort 5181)) {
    $agentChild = Start-Process -FilePath $nodeBinary -ArgumentList @('bridge/server.js') -WorkingDirectory $demoRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimePath 'bridge.log') -RedirectStandardError (Join-Path $runtimePath 'bridge-error.log') -PassThru
    $started += @{ Pid = $agentChild.Id; Started = $agentChild.StartTime.ToUniversalTime().ToString('o'); Argument = 'bridge/server.js' }
}
ConvertTo-Json -InputObject @($started) | Set-Content -LiteralPath $pidFile -Encoding UTF8
for ($attempt = 0; $attempt -lt 20; $attempt++) {
    if (Test-DemoPort 5180) { break }
    Start-Sleep -Milliseconds 300
}
if (-not (Test-DemoPort 5180)) { throw 'Web server did not start. See .runtime/web-error.log.' }
Start-Process 'http://localhost:5180/'
Write-Host 'Facility AI Twin is running at http://localhost:5180/'
