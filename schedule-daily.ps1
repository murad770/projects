# Registers (or updates) a Windows Scheduled Task that runs the news digest
# once a day and emails it.
#
# Usage (from the news-digest folder):
#   powershell -ExecutionPolicy Bypass -File .\schedule-daily.ps1
#   powershell -ExecutionPolicy Bypass -File .\schedule-daily.ps1 -Time "06:30"
#
# To remove it later:
#   Unregister-ScheduledTask -TaskName "KiroNewsDigest" -Confirm:$false

param(
    # Time of day to run, 24-hour "HH:mm".
    [string]$Time = "07:00",
    # Task name shown in Task Scheduler.
    [string]$TaskName = "KiroNewsDigest"
)

$ErrorActionPreference = "Stop"

# This script's own folder, so the task always points at the right place.
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$runner = Join-Path $scriptDir "run-digest.cmd"

if (-not (Test-Path $runner)) {
    throw "Could not find run-digest.cmd next to this script at: $runner"
}

# Warn (don't block) if .env is missing — the task can't email without it.
$envFile = Join-Path $scriptDir ".env"
if (-not (Test-Path $envFile)) {
    Write-Warning "No .env file found at $envFile."
    Write-Warning "Copy .env.example to .env and fill in your SMTP settings, or the daily send will fail."
}

# The action: run the wrapper .cmd in its own folder.
$action = New-ScheduledTaskAction -Execute $runner -WorkingDirectory $scriptDir

# The trigger: every day at the chosen time.
$trigger = New-ScheduledTaskTrigger -Daily -At $Time

# Run only when a user is logged on (so it can reach the network normally),
# and don't stop it on battery.
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -DontStopIfGoingOnBatteries `
    -AllowStartIfOnBatteries

# Replace any existing task with the same name so re-running is safe.
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed existing task '$TaskName' so it can be recreated."
}

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description "Fetches top international news (BBC, Reuters, NYT) and emails a daily digest." | Out-Null

Write-Host ""
Write-Host "Scheduled task '$TaskName' registered."
Write-Host "  Runs daily at $Time"
Write-Host "  Command:     $runner"
Write-Host ""
Write-Host "Test it right now with:"
Write-Host "  Start-ScheduledTask -TaskName $TaskName"
Write-Host "Then check digest.log in this folder for the result."
Write-Host ""
Write-Host "Remove it later with:"
Write-Host "  Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false"
