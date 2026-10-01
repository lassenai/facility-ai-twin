$ErrorActionPreference = 'Stop'
$pidFile = Join-Path $PSScriptRoot '.runtime/launcher-processes.json'
if (-not (Test-Path -LiteralPath $pidFile)) { Write-Host 'No launcher-owned processes are recorded.'; exit }
$records = @(Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json)
foreach ($record in $records) {
    $owned = Get-Process -Id $record.Pid -ErrorAction SilentlyContinue
    if (-not $owned) { continue }
    $command = Get-CimInstance Win32_Process -Filter "ProcessId = $($record.Pid)"
    if ($owned.StartTime.ToUniversalTime().ToString('o') -eq $record.Started -and $command.CommandLine.Contains($record.Argument)) {
        Stop-Process -Id $record.Pid
    }
}
Set-Content -LiteralPath $pidFile -Value '[]' -Encoding UTF8
Write-Host 'Launcher-owned demo servers stopped. Servers started in other terminals are left running.'
