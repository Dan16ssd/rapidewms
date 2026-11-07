# Registers a daily Windows task that runs the backup.
#
# A backup you have to remember to take is not a backup. This also keeps the
# Supabase project awake: free projects pause after about a week with no
# activity, and a paused project is a shop that cannot sell.
#
#   powershell -ExecutionPolicy Bypass -File scripts\schedule-backup.ps1
#   ... -At 21:30 -Dir E:\rapidewms-backups
#   ... -WhatIf          show what would be scheduled, change nothing
#   ... -Remove          delete the task again
#
# Runs as the current user, so no administrator rights are needed. If the
# machine is off at the appointed time, StartWhenAvailable runs it as soon as
# the machine is next on.
param(
  [string]$At = "21:00",
  [string]$Dir = "",
  [string]$Name = "RAPIDEWMS backup",
  [switch]$Remove,
  [switch]$WhatIf
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot

if ($Remove) {
  Unregister-ScheduledTask -TaskName $Name -Confirm:$false
  "Removed the scheduled task '$Name'."
  exit 0
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "node is not on PATH; install Node.js first." }

# Where the backups and the log go. Default matches backup.mjs: a sibling of the
# repository, never inside it, because this repository is public.
$outDir = if ($Dir) { $Dir } else { Join-Path $repo "..\rapidewms-backups" }
# -WhatIf must not change anything, so only create the folder for a real run.
if (-not $WhatIf -and -not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }
$outDir = if (Test-Path $outDir) { (Resolve-Path $outDir).Path } else { [IO.Path]::GetFullPath($outDir) }
$log = Join-Path $outDir "backup.log"

# Absolute paths throughout: a scheduled task inherits neither your PATH nor
# your current directory.
$parts = @("`"$node`"", "`"$repo\scripts\backup.mjs`"")
if ($Dir) { $parts += @("--dir", "`"$outDir`"") }
# cmd.exe only so that stdout and stderr land in a log worth reading later.
$inner = ($parts -join " ") + " >> `"$log`" 2>&1"
$argument = "/c `"$inner`""

if ($WhatIf) {
  ""
  "Would register '$Name', daily at $At."
  "  cmd.exe $argument"
  "  workdir $repo"
  ""
  exit 0
}

$trigger = New-ScheduledTaskTrigger -Daily -At $At
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument $argument -WorkingDirectory $repo
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
  -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Hours 1)

Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger `
  -Settings $settings -Description "Daily logical backup of the RAPIDEWMS Supabase database." -Force | Out-Null

""
"Scheduled '$Name' daily at $At."
"  backups   $outDir"
"  log       $log"
"  run now   Start-ScheduledTask -TaskName '$Name'"
"  check     Get-ScheduledTaskInfo -TaskName '$Name'"
"  remove    powershell -File scripts\schedule-backup.ps1 -Remove"
""
"Check a backup really restores from time to time:  npm run backup:verify"
""
