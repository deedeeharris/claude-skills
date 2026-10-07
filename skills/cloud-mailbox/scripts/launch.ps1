param(
  [Parameter(Mandatory)][string]$PromptFile,
  [Parameter(Mandatory)][string]$Name,
  [string]$RepoDir = (Get-Location).Path,
  [ValidateSet('Hidden', 'Minimized', 'Normal')][string]$Window = 'Hidden',
  [string]$LogDir = (Join-Path $env:TEMP 'cloud-mailbox'),
  [switch]$Inner
)
# Windows. Start one Claude Code cloud session from $RepoDir's current, pushed branch, without leaving
# a console window open on the desktop.
# `claude --cloud` refuses to run without a terminal, so it cannot run straight from an agent's shell
# tool. This script re-launches itself in its own console (hidden by default), runs `claude --cloud`
# there, writes a log, and the console closes when claude returns.
# The cloud environment comes from `remote.defaultEnvironmentId` (repo .claude/settings.json wins over
# the user's /remote-env pick); this script does not choose one.
if ($Name -notmatch '^[A-Za-z0-9._-]+$') { throw "-Name must be letters, digits, . _ - only (got '$Name')" }
$PromptFile = (Resolve-Path $PromptFile).Path
$RepoDir = (Resolve-Path $RepoDir).Path
$LogDir = $LogDir.TrimEnd('\')
$log = Join-Path $LogDir "launch-$Name.log"

if (-not $Inner) {
  # The cloud clones the pushed branch, not this checkout: refuse when local commits are not pushed.
  Push-Location $RepoDir
  try {
    $branch = git rev-parse --abbrev-ref HEAD
    $upstream = git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>$null
    if (-not $upstream) { throw "branch '$branch' has no upstream; push it first (git push -u origin $branch)" }
    $ahead = [int](git rev-list --count '@{u}..HEAD')
    if ($ahead -gt 0) { throw "branch '$branch' is $ahead commit(s) ahead of $upstream; push first, the cloud clones the remote branch" }
  } finally { Pop-Location }
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  # Start-Process joins -ArgumentList with spaces and does not quote: quote every value ourselves.
  $q = { param($s) '"' + $s + '"' }
  $argv = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (& $q $PSCommandPath),
            '-Inner', '-PromptFile', (& $q $PromptFile), '-Name', $Name,
            '-RepoDir', (& $q $RepoDir), '-LogDir', (& $q $LogDir))
  $p = Start-Process powershell -ArgumentList $argv -WindowStyle $Window -PassThru
  Write-Output "LAUNCHED name=$Name pid=$($p.Id) window=$Window branch=$branch log=$log"
  exit 0
}

Start-Transcript -Path $log -Force | Out-Null
try {
  Set-Location $RepoDir
  Write-Host "cloud-mailbox launch '$Name' from $(git rev-parse --abbrev-ref HEAD) $(git rev-parse --short HEAD) at $((Get-Date).ToUniversalTime().ToString('s'))Z"
  # Windows PowerShell 5.1 passes native arguments without escaping embedded quotes, so the prompt
  # would be cut at its first double quote. Escape per the Windows argv rules: backslashes before a
  # quote are doubled and the quote becomes \", and trailing backslashes are doubled.
  # Read as UTF-8 explicitly: 5.1 otherwise decodes a BOM-less file with the ANSI code page.
  $prompt = (Get-Content -Raw -Encoding UTF8 $PromptFile) -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1'
  claude --cloud $prompt -n $Name
  Write-Host "===EXIT=== $LASTEXITCODE"
} finally {
  Stop-Transcript | Out-Null
}
