# PM-spawned CC runner — Windows wrapper for the global bash runner.
# See SKILL.md § 4.6.1 for the full contract.
#
# This is a GLOBAL script. It lives in the skill at:
#   %USERPROFILE%\.claude\skills\mm\templates\run.ps1
# It does NOT get copied into tasks. Invoke it by absolute path.
#
# It locates the sibling `run.sh` (the actual streaming + watcher logic) and
# launches it under WSL or Git Bash, optionally inside a Windows Terminal tab.
#
# Usage:
#   .\run.ps1 <prompt-path> [<project-root>] [<task-dir>]              # spawn a new Windows Terminal tab
#   .\run.ps1 <prompt-path> [<project-root>] [<task-dir>] -Inline      # run blocking in current console
#
# Args:
#   <prompt-path>    REQUIRED. Absolute path to the babysitter prompt .md.
#                    On Windows you can pass either a Windows path or a WSL path.
#   <project-root>   Optional. Repo root the agent should cd into. Defaults to git toplevel.
#   <task-dir>       Optional. PM task folder where HANDOFF.md / inbox/ / runs/ live.
#                    Defaults to grand-parent of the prompt.
#
# Flags:
#   -Inline          Run in the current console (blocking) instead of spawning a new tab.
#   -Backend <name>  Force "wsl" or "gitbash" (default: auto-detect).
#
# Requirements:
#   - WSL with bash + jq + claude installed inside, OR Git Bash for Windows + jq.exe on PATH.
#   - Windows Terminal (`wt.exe`) for the spawned-tab variant (preinstalled on Win 11).

param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$PromptPath,

  [Parameter(Position = 1)]
  [string]$ProjectRoot = "",

  [Parameter(Position = 2)]
  [string]$TaskDir = "",

  [switch]$Inline,

  [string]$Backend = "auto"
)

$ErrorActionPreference = "Stop"

# --- Locate sibling run.sh (in the same templates/ directory) ----------------

$ScriptDir = Split-Path -Parent $PSCommandPath
$RunSh = Join-Path $ScriptDir "run.sh"
if (-not (Test-Path $RunSh)) {
  Write-Error "Sibling run.sh not found at $RunSh — the skill installation looks broken."
  exit 2
}

# --- Detect backend ----------------------------------------------------------

function Test-Wsl { (Get-Command wsl.exe -ErrorAction SilentlyContinue) -ne $null }
function Find-GitBash {
  $candidates = @(
    "C:\Program Files\Git\bin\bash.exe",
    "C:\Program Files (x86)\Git\bin\bash.exe",
    "$env:LOCALAPPDATA\Programs\Git\bin\bash.exe"
  )
  foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
  return $null
}

if ($Backend -eq "auto") {
  if (Test-Wsl) {
    $Backend = "wsl"
  } elseif (Find-GitBash) {
    $Backend = "gitbash"
  } else {
    Write-Error @"
No bash backend found.
Install one of:
  - WSL (recommended):  https://aka.ms/wsl
  - Git for Windows:    https://git-scm.com/download/win
Then re-run this script.
"@
    exit 127
  }
}

# --- Translate paths to the chosen backend's view ----------------------------

function Reject-Unsupported([string]$p, [string]$context) {
  if ([string]::IsNullOrEmpty($p)) { return }
  # UNC \\server\share or //server/share — both backends mishandle these.
  if ($p -match '^[\\/]{2}[^\\/]+[\\/]') {
    Write-Error "$context UNC/network paths are not supported: $p`nMap the share to a drive letter first."
    exit 2
  }
}

function Convert-Path-Wsl([string]$p) {
  if ([string]::IsNullOrEmpty($p)) { return "" }
  if ($p -match '^/') { return $p }            # already a WSL/POSIX path
  Reject-Unsupported $p "wsl:"
  $out = & wsl.exe wslpath -a "$p" 2>$null
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrEmpty($out)) {
    Write-Error "wslpath failed to translate '$p' (exit=$LASTEXITCODE)."
    exit 2
  }
  return $out.Trim()
}

function Convert-Path-GitBash([string]$p) {
  if ([string]::IsNullOrEmpty($p)) { return "" }
  if ($p -match '^/') { return $p }
  Reject-Unsupported $p "gitbash:"
  # Require a drive-letter prefix like C:\ or C:/ before substring slicing.
  if ($p -notmatch '^[A-Za-z]:[\\/]') {
    Write-Error "gitbash: cannot translate path '$p' — expected drive-letter syntax (e.g. C:\foo\bar)."
    exit 2
  }
  return ("/" + $p.Substring(0, 1).ToLower() + $p.Substring(2).Replace("\", "/"))
}

if ($Backend -eq "wsl") {
  $RunShPosix = Convert-Path-Wsl $RunSh
  $PromptPosix = Convert-Path-Wsl $PromptPath
  $ProjectRootPosix = Convert-Path-Wsl $ProjectRoot
  $TaskDirPosix = Convert-Path-Wsl $TaskDir
} else {
  $GitBash = Find-GitBash
  $RunShPosix = Convert-Path-GitBash $RunSh
  $PromptPosix = Convert-Path-GitBash $PromptPath
  $ProjectRootPosix = Convert-Path-GitBash $ProjectRoot
  $TaskDirPosix = Convert-Path-GitBash $TaskDir
}

# --- Build the bash command line ---------------------------------------------

# Bash-quote a string: wrap in single quotes, escape embedded single quotes as '\''
function Quote-Bash([string]$s) {
  if ($null -eq $s) { return "''" }
  return "'" + ($s -replace "'", "'\''") + "'"
}

# Always pass placeholders for missing optional args so positional indexing stays correct:
#   bash run.sh <prompt> '' <task-dir>     # if only TaskDir is set, ProjectRoot is empty string.
$BashArgs = @(
  (Quote-Bash $RunShPosix),
  (Quote-Bash $PromptPosix)
)
if ($TaskDirPosix -or $ProjectRootPosix) {
  $BashArgs += (Quote-Bash $ProjectRootPosix)
}
if ($TaskDirPosix) {
  $BashArgs += (Quote-Bash $TaskDirPosix)
}
$InnerCmd = "bash " + ($BashArgs -join " ")

if ($Backend -eq "wsl") {
  $LauncherExe  = "wsl.exe"
  $LauncherArgs = @("-e", "bash", "-lc", $InnerCmd)
} else {
  $LauncherExe  = $GitBash
  $LauncherArgs = @("-lc", $InnerCmd)
}

Write-Host "============================================================"
Write-Host "🚀 PM auto-launcher — mm/run.ps1 (global)"
Write-Host "============================================================"
Write-Host "  Backend     : $Backend"
Write-Host "  run.sh      : $RunSh"
Write-Host "  Prompt      : $PromptPath"
if ($ProjectRoot) { Write-Host "  ProjectRoot : $ProjectRoot" }
if ($TaskDir)     { Write-Host "  TaskDir     : $TaskDir" }
Write-Host "  Mode        : $(if ($Inline) {'inline (blocking)'} else {'spawned (Windows Terminal tab)'})"
Write-Host "============================================================"

if ($Inline) {
  & $LauncherExe @LauncherArgs
  exit $LASTEXITCODE
}

# Spawn a Windows Terminal tab so the user can see the live stream.
$Wt = Get-Command wt.exe -ErrorAction SilentlyContinue
$WindowTitle = "mm: " + (Split-Path -Leaf $PromptPath)
if ($Wt) {
  $WtArgs = @("new-tab", "--title", $WindowTitle, $LauncherExe) + $LauncherArgs
  Start-Process wt.exe -ArgumentList $WtArgs
} else {
  Write-Warning "Windows Terminal (wt.exe) not found — falling back to a plain console window."
  $CmdArgs = @("/c", "start", "`"$WindowTitle`"", $LauncherExe) + $LauncherArgs
  Start-Process cmd.exe -ArgumentList $CmdArgs
}

Write-Host "✅ Spawned. Watch the new terminal window for live progress."
Write-Host "   When the agent finishes, the window auto-closes after 5s."
