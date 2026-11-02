<#
.SYNOPSIS
  Day 0 GitHub bootstrap: repo, settings, rulesets, environments, variables, security switches. Idempotent.

.DESCRIPTION
  DRY-RUN BY DEFAULT. Without -Apply the script performs NO network call at all: it prints every gh command and
  JSON payload it would run. With -Apply it executes. Re-running -Apply is safe
  (PATCH/PUT are idempotent; rulesets are matched by name and updated; MainOnly deployment policies are reconciled to
  exactly the default branch, every other branch or tag policy is deleted; variables are set per Environment).

  PLAN: set `Plan` (free | pro | team | enterprise) in the config. `gh api user` returns NO plan for personal
  accounts, so the script never assumes one: with Plan empty, a dry run stops, and -Apply tries to detect it
  (organizations only) and stops if detection is empty. Before any write, a config the plan cannot support
  (rulesets on a private Free repo, required reviewers on a private non-Enterprise repo) is
  REFUSED with exit code 2.

  DEGRADED MODE (opt-in): `AcceptDegraded = $true` in the config. Instead of refusing, the script applies everything the
  plan x visibility allows, SKIPS every feature GitHub rejects there (rulesets, Environment reviewers, secret scanning,
  CodeQL, auto-merge) and prints a loud NOT ENFORCED summary: what is no longer protected and the two ways out (GitHub Pro,
  or a public repo). Default is $false = refuse. Availability table: references/repo-bootstrap.md section 0 (measured live).

  Windows PowerShell 5.1 and PowerShell 7 compatible. Requires gh >= 2.40, authenticated (`gh auth status`) with
  repo + admin rights on the target. Secrets are never read or written; variables hold IDs only.

.EXAMPLE
  .\bootstrap-repo.ps1 -ConfigPath .\bootstrap.config.psd1            # dry run, prints the plan
  .\bootstrap-repo.ps1 -ConfigPath .\bootstrap.config.psd1 -Apply     # execute
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ConfigPath,
    [switch]$Apply
)

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'

$cfg = Import-PowerShellDataFile -Path $ConfigPath
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$slug = "$($cfg.Owner)/$($cfg.Repo)"
$mode = if ($Apply) { 'APPLY' } else { 'DRY-RUN' }
$results = New-Object System.Collections.Generic.List[object]

function Write-Plan([string]$Text) { Write-Host $Text -ForegroundColor Cyan }
function Write-Warn([string]$Text) { Write-Host "WARN  $Text" -ForegroundColor Yellow }

function ConvertTo-Payload($Object) { ConvertTo-Json -InputObject $Object -Depth 20 }

# Every gh call goes through Invoke-Gh. Windows PowerShell 5.1 turns native-command stderr into an ErrorRecord, and under
# $ErrorActionPreference = 'Stop' into a TERMINATING NativeCommandError (with 2>$null and 2>&1 too), so a normal gh failure
# such as a 404 would kill the script before its exit code could be read, and redirected stderr arrives wrapped in
# PowerShell error text. So gh is started as a plain .NET process: stdout, stderr and the exit code come back untouched
# and the caller decides what is an error.
function ConvertTo-ProcessArg([string]$Arg) {
    if ($Arg.Length -gt 0 -and $Arg -notmatch '[\s"]') { return $Arg }
    # Windows rules: a backslash run before a quote is doubled and the quote escaped; a trailing run before the closing quote is doubled.
    '"' + (($Arg -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"'
}

function Invoke-Gh {
    param([string[]]$GhArgs, [string]$Stdin)
    # A request body goes through a temp file (--input <file>), not stdin: with a UTF-8 console code page .NET writes a BOM on the
    # redirected stdin pipe, which is not valid JSON for gh.
    $tmp = $null
    if ($PSBoundParameters.ContainsKey('Stdin')) {
        $tmp = [System.IO.Path]::GetTempFileName()
        [System.IO.File]::WriteAllText($tmp, $Stdin, (New-Object System.Text.UTF8Encoding($false)))
        $GhArgs = @($GhArgs | ForEach-Object { if ($_ -eq '-') { $tmp } else { $_ } })
    }
    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = (Get-Command gh -CommandType Application | Select-Object -First 1).Source
        $psi.Arguments = (@($GhArgs | ForEach-Object { ConvertTo-ProcessArg $_ }) -join ' ')
        $psi.UseShellExecute = $false
        $psi.RedirectStandardInput = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
        $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
        $proc = [System.Diagnostics.Process]::Start($psi)
        $outTask = $proc.StandardOutput.ReadToEndAsync()
        $errTask = $proc.StandardError.ReadToEndAsync()
        $proc.StandardInput.Close()
        $proc.WaitForExit()
        [pscustomobject]@{ ExitCode = $proc.ExitCode; Out = $outTask.Result.Trim(); Err = $errTask.Result.Trim() }
    } finally {
        if ($tmp) { [System.IO.File]::Delete($tmp) }
    }
}
# A real "does not exist": gh prints "Not Found (HTTP 404)". Auth (401/403), rate limit and network errors are NOT this.
function Test-GhNotFound($Result) { ($Result.ExitCode -ne 0) -and ((($Result.Err + ' ' + $Result.Out) -match 'HTTP 404')) }

function Get-GhFailure($Result) { "exit $($Result.ExitCode): $((($Result.Err + ' ' + $Result.Out)).Trim())" }

# Write call through gh api. Prints always; executes only with -Apply.
function Invoke-GhWrite {
    param([string]$Method, [string]$Endpoint, $Body)
    $line = "gh api -X $Method $Endpoint"
    if ($null -ne $Body) {
        $json = ConvertTo-Payload $Body
        Write-Plan "[$mode] $line --input -"
        Write-Host $json
    } else {
        Write-Plan "[$mode] $line"
    }
    if (-not $Apply) { return $null }
    if ($null -ne $Body) { $r = Invoke-Gh -GhArgs @('api', '-X', $Method, $Endpoint, '--input', '-') -Stdin $json }
    else { $r = Invoke-Gh -GhArgs @('api', '-X', $Method, $Endpoint) }
    if ($r.ExitCode -ne 0) { throw "gh api $Method $Endpoint failed: $(Get-GhFailure $r)" }
    if ($r.Out) { return $r.Out | ConvertFrom-Json }
    return $null
}

# Read call. Only runs with -Apply (dry run must stay offline).
function Invoke-GhRead {
    param([string]$Endpoint)
    $r = Invoke-Gh -GhArgs @('api', $Endpoint)
    if ($r.ExitCode -ne 0) { throw "gh api $Endpoint failed: $(Get-GhFailure $r)" }
    return $r.Out | ConvertFrom-Json
}

# Paginated list read: EVERY page, one item per output line (gh --paginate + --jq). A single page holds 30 items by
# default, so matching by name on page 1 alone would POST a duplicate instead of updating the existing item.
function Invoke-GhReadAll {
    param([string]$Endpoint, [string]$ItemsJq)
    $r = Invoke-Gh -GhArgs @('api', '--paginate', $Endpoint, '--jq', "$ItemsJq | tojson")
    if ($r.ExitCode -ne 0) { throw "gh api --paginate $Endpoint failed: $(Get-GhFailure $r)" }
    return @(($r.Out -split "`n") | Where-Object { $_.Trim() } | ForEach-Object { $_ | ConvertFrom-Json })
}

# gh variable set, repo-wide or scoped to one Environment. Empty or REPLACE-* values are skipped (not filled in yet).
function Set-GhVariable {
    param([string]$Name, [string]$Value, [string]$EnvName)
    $scope = if ($EnvName) { "--env $EnvName " } else { '' }
    $where = if ($EnvName) { "environment $EnvName" } else { 'repository' }
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value.StartsWith('REPLACE')) {
        Write-Warn "variable $Name ($where) is empty or a placeholder in config, skipped (fill after the Terraform bootstrap)"
        return
    }
    Write-Plan "[$mode] gh variable set $Name ${scope}--repo $slug --body `"$Value`"   ($where)"
    if ($Apply) {
        $ghArgs = @('variable', 'set', $Name, '--repo', $slug, '--body', $Value)
        if ($EnvName) { $ghArgs += @('--env', $EnvName) }
        $r = Invoke-Gh -GhArgs $ghArgs
        if ($r.ExitCode -ne 0) { throw "gh variable set $Name ($where) failed: $(Get-GhFailure $r)" }
    }
}

function Step {
    param([string]$Name, [scriptblock]$Body)
    Write-Host ""
    Write-Host "== $Name" -ForegroundColor Green
    try {
        & $Body
        $results.Add([pscustomobject]@{ Step = $Name; Status = 'ok'; Detail = '' })
    } catch {
        if ($_.Exception.Message -like 'SKIP:*') {
            $why = $_.Exception.Message.Substring(5).Trim()
            Write-Warn "$Name SKIPPED ($why)"
            $results.Add([pscustomobject]@{ Step = $Name; Status = 'SKIPPED'; Detail = $why })
        } else {
            Write-Warn "$Name failed: $($_.Exception.Message)"
            $results.Add([pscustomobject]@{ Step = $Name; Status = 'FAILED'; Detail = $_.Exception.Message })
        }
    }
}
# Degraded mode only: record what is NOT enforced (feature, plain consequence, GitHub's own words) and skip the current step.
$notEnforced = New-Object System.Collections.Generic.List[object]
function Skip-Step([string]$Feature, [string]$Consequence, [string]$Why) {
    $notEnforced.Add([pscustomobject]@{ Feature = $Feature; Consequence = $Consequence; Why = $Why })
    throw "SKIP: $Why"
}

Write-Host "bootstrap-repo.ps1  mode=$mode  target=$slug" -ForegroundColor Green
if (-not $Apply) { Write-Host "No network calls and no writes. Re-run with -Apply to execute." }

# ---- 0. Plan + feature availability (decided BEFORE any write) ----------------------------------------
function Stop-Refuse([string[]]$Reasons) {
    Write-Host ''
    Write-Host 'REFUSED: nothing was written.' -ForegroundColor Red
    foreach ($r in $Reasons) { Write-Host "  - $r" -ForegroundColor Red }
    exit 2
}

function Stop-Fatal([string]$Text) {
    Write-Host ''
    Write-Host "FATAL: $Text" -ForegroundColor Red
    exit 1
}

$private = ($cfg.Visibility -eq 'private')
if (-not $private -and $cfg.Visibility -ne 'public') { Stop-Refuse @("Visibility must be 'private' or 'public', got '$($cfg.Visibility)'.") }
$plan = $cfg.Plan
$exists = $false
if ($Apply) {
    $probe = Invoke-Gh -GhArgs @('api', "repos/$slug")
    if ($probe.ExitCode -eq 0) {
        $exists = $true
        # An existing repo keeps its visibility (nothing below changes it), so a mismatch with the config must stop BEFORE any write.
        try { $existingPrivate = [bool]($probe.Out | ConvertFrom-Json).private }
        catch { Stop-Fatal "cannot read the visibility of existing repo $slug from the API response: $($_.Exception.Message)" }
        if ($existingPrivate -ne $private) {
            $have = if ($existingPrivate) { 'private' } else { 'public' }
            Stop-Refuse @("$slug already exists and is $have, but the config says Visibility = '$($cfg.Visibility)'. This script never changes visibility of an existing repo.",
                "Change the repo's visibility yourself (GitHub > Settings > Danger Zone) or fix Visibility in the config, then run again.")
        }
    }
    elseif (Test-GhNotFound $probe) { $exists = $false }   # a private repo your token cannot see also answers 404
    else { Stop-Fatal "cannot tell whether $slug exists (auth, permission or network problem, NOT a 404): $(Get-GhFailure $probe)" }
    if (-not $plan) {
        # `gh api user` returns NO plan field for personal accounts (verified), so only organizations can be detected.
        $acct = Invoke-GhRead "users/$($cfg.Owner)"
        if ($acct.type -eq 'Organization') {
            try {
                $org = Invoke-GhRead "orgs/$($cfg.Owner)"
                if ($org.PSObject.Properties['plan'] -and $org.plan -and $org.plan.PSObject.Properties['name']) { $plan = $org.plan.name }
            } catch { $plan = $null }
        } else {
            $me = Invoke-GhRead 'user'
            if ($me.login -eq $cfg.Owner -and $me.PSObject.Properties['plan'] -and $me.plan -and $me.plan.PSObject.Properties['name']) { $plan = $me.plan.name }
        }
    }
} else {
    if (-not $plan) { Write-Plan "[DRY-RUN] Plan is empty. -Apply would try: gh api users/$($cfg.Owner) ; gh api orgs/$($cfg.Owner) (.plan.name). Personal accounts return no plan." }
}
if (-not $plan) {
    Stop-Refuse @('Plan is empty and cannot be detected (personal accounts return no plan from the API, and a dry run is offline).',
        "Set Plan = 'free' | 'pro' | 'team' | 'enterprise' in the config (check github.com > Settings > Billing and plans), then run again.")
}
$plan = ([string]$plan).ToLower()
if (@('free', 'pro', 'team', 'enterprise') -notcontains $plan) { Stop-Refuse @("Plan '$plan' is not one of free | pro | team | enterprise.") }

# Availability per feature x plan x visibility. MEASURED live on a private Free repo 2026-10-15 (references/repo-bootstrap.md
# section 0 has the table and the exact GitHub error text); the Pro/Team/Enterprise columns are from GitHub Docs, not measured.
#   rulesets (and legacy branch protection)   public: all plans   private: pro, team, enterprise  (Free: 403 "Upgrade to GitHub Pro or make this repository public")
#   Environments, variables, branch policies  public + private: ALL plans (Free private: measured OK)
#   Environment reviewers / wait timer        public: all plans   private: ENTERPRISE only        (Free private: 422 "billing plan supports the required reviewers protection rule")
#   secret scanning, push protection          public: all plans   private: paid add-on           (Free private: 422 "Secret scanning is not available for this repository.")
#   CodeQL default setup                      public: all plans   private: paid add-on           (Free private: 403 "Code scanning is not enabled for this repository.")
#   allow_auto_merge                          needs rulesets or branch protection (Free private: PATCH returns 200 but the value stays false)
$degraded      = $cfg.ContainsKey('AcceptDegraded') -and [bool]$cfg.AcceptDegraded
$paidPlan      = @('pro', 'team', 'enterprise') -contains $plan
$rulesetsOk    = (-not $private) -or $paidPlan
$reviewersOk   = (-not $private) -or ($plan -eq 'enterprise')
$scanningOk    = (-not $private) -or $paidPlan       # private paid still needs the add-on: a rejection is SKIPPED in degraded mode
$needReviewers = @($cfg.Environments.Keys | Where-Object { $cfg.Environments[$_].Reviewers }).Count -gt 0

$refusals = @()
if (-not $rulesetsOk) { $refusals += "Rulesets are not available on a private repo with plan '$plan': nothing could require a PR or green checks before merge, or block a direct push to $($cfg.DefaultBranch)." }
if ($needReviewers -and -not $reviewersOk) {
    $refusals += "Environments with Reviewers = `$true need a public repo or GitHub Enterprise; plan '$plan' on a private repo cannot require approvals, so the human gate on apply and prod deploy would not exist."
}
$planRefusals = $refusals.Count
# The workflow templates hardcode `branches: [main]` (ci, release-please, terraform-apply). Another default branch would
# get Environment policies for a branch no workflow deploys or releases from.
if ($cfg.DefaultBranch -ne 'main') { $refusals += "DefaultBranch is '$($cfg.DefaultBranch)'. This skill is trunk-based on 'main' and its workflow templates trigger on main only. Use 'main'." }
if ($needReviewers -and $reviewersOk -and @($cfg.Reviewers).Count -eq 0) { $refusals += 'Environments require reviewers but Reviewers is empty.' }
# One GCP project per environment: the Terraform identities hold project-level roles, so a shared project would let the
# dev applier reach prod resources. Allowed only with an explicit AllowSharedProject = $true (and no isolation claim).
function Get-EnvVar([string]$EnvName, [string]$VarName) {
    if (-not $cfg.Environments.ContainsKey($EnvName)) { return $null }
    $ev = $cfg.Environments[$EnvName]
    if (-not $ev.ContainsKey('Variables') -or -not $ev.Variables.ContainsKey($VarName)) { return $null }
    $v = [string]$ev.Variables[$VarName]
    if ([string]::IsNullOrWhiteSpace($v) -or $v.StartsWith('REPLACE')) { return $null }
    return $v
}
$projDev = Get-EnvVar 'tf-dev' 'GCP_PROJECT_ID'
$projProd = Get-EnvVar 'tf-prod' 'GCP_PROJECT_ID'
$allowShared = $cfg.ContainsKey('AllowSharedProject') -and [bool]$cfg.AllowSharedProject
if ($projDev -and $projProd -and ($projDev -eq $projProd) -and -not $allowShared) {
    $refusals += "tf-dev and tf-prod use the same GCP_PROJECT_ID ($projDev). Use one project per environment, or set AllowSharedProject = `$true and record in docs/stack.md that dev and prod are NOT isolated."
}
# Degraded mode turns the plan refusals (rulesets, reviewers) into the recorded NOT ENFORCED list. A shared GCP project still refuses.
if ($degraded) {
    $refusals = @($refusals | Select-Object -Skip $planRefusals)
}
if ($refusals.Count -gt 0) {
    if ($planRefusals -gt 0 -and -not $degraded) {
        $refusals += "Options: make the repo public (only if nothing sensitive is in it), move to an Enterprise plan, set Reviewers = `$false on those Environments (then there is NO approval gate: record that decision in docs/stack.md), set AcceptDegraded = `$true to apply what this plan allows and have the rest reported as NOT ENFORCED, or stop."
    }
    Stop-Refuse $refusals
}
Write-Host "visibility=$($cfg.Visibility) plan=$plan rulesets=$rulesetsOk environments=True env-branch-policies=True env-reviewers=$reviewersOk secret-scanning/codeql=$scanningOk accept-degraded=$degraded"
if (-not $needReviewers) { Write-Warn 'No Environment requires reviewers: apply and prod deploy will run WITHOUT a human approval gate.' }
elseif ($cfg.Environments.ContainsKey('tf-prod') -and -not $cfg.Environments['tf-prod'].Reviewers) { Write-Warn 'tf-prod has no reviewers: the prod apply runs WITHOUT a human approval gate.' }

# Degraded mode: the NOT ENFORCED report. Printed at the start (so the dry run shows it) and again at the end.
function Write-NotEnforced {
    if (-not $degraded) { return }
    $bar = '#' * 100
    Write-Host ''
    Write-Host $bar -ForegroundColor Red
    Write-Host "#  DEGRADED MODE: NOT ENFORCED on $slug (plan=$plan, visibility=$($cfg.Visibility))" -ForegroundColor Red
    Write-Host $bar -ForegroundColor Red
    $rows = @()
    if (-not $rulesetsOk) {
        $rows += [pscustomobject]@{ Feature = "Rulesets ($($cfg.DefaultBranch) protection, v* tag protection)"; Consequence = "Nothing stops a direct push, a force-push or a delete of $($cfg.DefaultBranch). No PR is required. CI still RUNS on PRs but a red or missing check does NOT block the merge. Tags v* can be moved or deleted."; Why = 'GET/POST /rulesets and PUT /branches/<b>/protection: 403 "Upgrade to GitHub Pro or make this repository public to enable this feature." (measured on private Free)' }
        $rows += [pscustomobject]@{ Feature = 'Auto-merge (allow_auto_merge)'; Consequence = 'GitHub ignores the setting without rulesets or branch protection, so gh pr merge --auto does not work.'; Why = 'PATCH returns 200 but allow_auto_merge stays false (measured on private Free)' }
    }
    if ($needReviewers -and -not $reviewersOk) {
        $rows += [pscustomobject]@{ Feature = 'Environment required reviewers (and wait timer)'; Consequence = 'No human approval gate: a job that targets tf-prod (or any Environment configured with Reviewers) runs without anyone approving it. main is unprotected too, so anyone with push access can reach it. Environments still exist, hold their own variables and OIDC subject, and (where MainOnly) accept only the default branch.'; Why = 'PUT /environments/<n> with reviewers or wait_timer: 422 "Please ensure the billing plan supports the required reviewers protection rule." (measured on private Free)' }
    }
    foreach ($n in $notEnforced) { $rows += $n }
    foreach ($r in $rows) {
        Write-Host "  NOT ENFORCED: $($r.Feature)" -ForegroundColor Red
        Write-Host "      Meaning: $($r.Consequence)" -ForegroundColor Red
        if ($r.Why) { Write-Host "      GitHub:  $($r.Why)" -ForegroundColor DarkYellow }
    }
    Write-Host ''
    Write-Host '  Two ways out:' -ForegroundColor Yellow
    Write-Host '    1. GitHub Pro for the account (github.com > Settings > Billing and plans): rulesets and auto-merge on private repos. On a private repo Environment required' -ForegroundColor Yellow
    Write-Host '       reviewers still need GitHub Enterprise, so the approval gate stays missing on Pro/Team; secret scanning and CodeQL are paid add-ons (Pro/Team/Enterprise columns: GitHub Docs, not measured).' -ForegroundColor Yellow
    Write-Host '    2. Make the repo PUBLIC (only if nothing sensitive is in it): every feature above is available on public repos on every plan. Set Visibility = ''public'' and re-run -Apply.' -ForegroundColor Yellow
    Write-Host '  Until then: review your own pushes by hand, do not treat green CI as a merge gate, and record this acceptance with the date in docs/stack.md.' -ForegroundColor Yellow
    Write-Host $bar -ForegroundColor Red
    Write-Host ''
}
Write-NotEnforced

# Reusable: print the summary table and exit non-zero if a step failed.
function Write-Summary {
    Write-Host ""
    Write-Host "== Summary ($mode)" -ForegroundColor Green
    $results | Format-Table -AutoSize | Out-String | Write-Host
    $failed = @($results | Where-Object { $_.Status -eq 'FAILED' }).Count
    $skipped = @($results | Where-Object { $_.Status -eq 'SKIPPED' }).Count
    if ($skipped -gt 0) { Write-Host "$skipped step(s) SKIPPED: not available on this plan (see NOT ENFORCED)." -ForegroundColor Yellow }
    Write-NotEnforced
    if ($failed -gt 0) { Write-Host "$failed step(s) failed." -ForegroundColor Red; exit 1 }
}

# ---- 1. Create repo ----------------------------------------------------------------------------------
Step 'Create repository (if missing)' {
    if ($exists) { Write-Host "repo $slug already exists, skipping create"; return }
    $vis = if ($private) { '--private' } else { '--public' }
    Write-Plan "[$mode] gh repo create $slug $vis --add-readme --description `"$($cfg.Description)`""
    if ($Apply) {
        $r = Invoke-Gh -GhArgs @('repo', 'create', $slug, $vis, '--add-readme', '--description', [string]$cfg.Description)
        if ($r.ExitCode -ne 0) { throw "gh repo create failed: $(Get-GhFailure $r)" }
        if ($r.Out) { Write-Host $r.Out }
    }
}

# ---- 1b. Default branch: gh repo create uses the OWNER's initial-branch setting (often master) -------------
Step 'Default branch (rename to the configured name)' {
    $current = '<current-default-branch>'
    if ($Apply) {
        $current = (Invoke-GhRead "repos/$slug").default_branch
        if ($current -eq $cfg.DefaultBranch) { Write-Host "default branch is already '$current'"; return }
    } else {
        Write-Plan "[DRY-RUN] gh api repos/$slug --jq .default_branch   (only if it differs from '$($cfg.DefaultBranch)': rename it)"
    }
    Invoke-GhWrite 'POST' "repos/$slug/branches/$current/rename" ([ordered]@{ new_name = $cfg.DefaultBranch }) | Out-Null
}
# Everything after this assumes the configured branch exists: stop here if it could not be set up.
if (@($results | Where-Object { $_.Status -eq 'FAILED' }).Count -gt 0) { Write-Summary }

# ---- 2. Repo settings --------------------------------------------------------------------------------
Step 'Repository settings (merge policy, features)' {
    $body = [ordered]@{
        allow_squash_merge     = $true
        allow_merge_commit     = $false
        allow_rebase_merge     = $false
        squash_merge_commit_title   = 'PR_TITLE'
        squash_merge_commit_message = 'PR_BODY'
        delete_branch_on_merge = $true
        allow_update_branch    = $true
        allow_auto_merge       = $true
        has_wiki               = $false
        has_projects           = $false
    }
    # allow_auto_merge needs rulesets or branch protection: on private Free GitHub answers 200 and keeps it false (measured), so it is only sent where it can work.
    if (-not $rulesetsOk) { $body.Remove('allow_auto_merge') }
    Invoke-GhWrite 'PATCH' "repos/$slug" $body | Out-Null
}

# ---- 3. Actions workflow permissions -----------------------------------------------------------------
Step 'Actions: default token read-only, allow Actions to open PRs (release-please)' {
    $body = [ordered]@{ default_workflow_permissions = 'read'; can_approve_pull_request_reviews = $true }
    Invoke-GhWrite 'PUT' "repos/$slug/actions/permissions/workflow" $body | Out-Null
}

# ---- 4. Security switches ----------------------------------------------------------------------------
Step 'Security: secret scanning + push protection' {
    if (-not $scanningOk) { Skip-Step 'Secret scanning + push protection' 'Committed secrets are not detected by GitHub and a push containing one is not blocked. The CI job secret-scan (gitleaks) still runs on PRs.' 'PATCH security_and_analysis: 422 "Secret scanning is not available for this repository." (measured on private Free; not called)' }
    $body = [ordered]@{ security_and_analysis = [ordered]@{
            secret_scanning                 = @{ status = 'enabled' }
            secret_scanning_push_protection = @{ status = 'enabled' } } }
    try { Invoke-GhWrite 'PATCH' "repos/$slug" $body | Out-Null }
    catch { if ($degraded) { Skip-Step 'Secret scanning + push protection' 'Committed secrets are not detected by GitHub and a push containing one is not blocked. The CI job secret-scan (gitleaks) still runs on PRs.' $_.Exception.Message } else { throw } }
}
Step 'Security: Dependabot alerts' { Invoke-GhWrite 'PUT' "repos/$slug/vulnerability-alerts" $null | Out-Null }
Step 'Security: Dependabot security updates' { Invoke-GhWrite 'PUT' "repos/$slug/automated-security-fixes" $null | Out-Null }
Step 'Security: private vulnerability reporting (public repos only)' {
    if ($private) { Write-Host 'not applicable: private vulnerability reporting exists only for public repositories'; return }
    Invoke-GhWrite 'PUT' "repos/$slug/private-vulnerability-reporting" $null | Out-Null
}
Step 'Security: CodeQL default setup' {
    if (-not $scanningOk) { Skip-Step 'CodeQL default setup' 'GitHub does not run code scanning (SAST) on this repo.' 'PATCH code-scanning/default-setup: 403 "Code scanning is not enabled for this repository." (measured on private Free; not called)' }
    $body = [ordered]@{ state = 'configured'; query_suite = 'default'; languages = @($cfg.CodeQLLanguages) }
    try { Invoke-GhWrite 'PATCH' "repos/$slug/code-scanning/default-setup" $body | Out-Null }
    catch { if ($degraded) { Skip-Step 'CodeQL default setup' 'GitHub does not run code scanning (SAST) on this repo.' $_.Exception.Message } else { throw } }
}

# ---- 5. Rulesets -------------------------------------------------------------------------------------
function Set-Ruleset {
    param($Ruleset)
    $name = $Ruleset.name
    if ($Apply) {
        # All pages (per_page=100 + --paginate). includes_parents=false + source_type=Repository: an inherited
        # org/enterprise ruleset with the same name is not ours to PUT.
        $existing = @(Invoke-GhReadAll "repos/$slug/rulesets?includes_parents=false&per_page=100" '.[]') | Where-Object { $_.name -eq $name -and $_.source_type -eq 'Repository' } | Select-Object -First 1
        if ($existing) { Invoke-GhWrite 'PUT' "repos/$slug/rulesets/$($existing.id)" $Ruleset | Out-Null; return }
        Invoke-GhWrite 'POST' "repos/$slug/rulesets" $Ruleset | Out-Null
    } else {
        Write-Plan "[DRY-RUN] (with -Apply: gh api --paginate repos/$slug/rulesets?includes_parents=false&per_page=100 (every page), match repo-owned name '$name'; PUT .../rulesets/<id> if found, else POST)"
        Invoke-GhWrite 'POST' "repos/$slug/rulesets" $Ruleset | Out-Null
    }
}

Step 'Ruleset: default branch (PR + checks, linear history, no force-push/delete)' {
    if (-not $rulesetsOk) { throw 'SKIP: rulesets unavailable on this plan (403 "Upgrade to GitHub Pro or make this repository public"); listed under NOT ENFORCED' }
    $rs = Get-Content -Raw -Encoding UTF8 -Path (Join-Path $here $cfg.MainRulesetFile) | ConvertFrom-Json
    $pr = $rs.rules | Where-Object { $_.type -eq 'pull_request' }
    if ($cfg.Solo) {
        $pr.parameters.required_approving_review_count = 0
        Write-Warn 'Solo = true: 0 required approvals. PR and all required checks are still enforced; there is no second human reviewer.'
    }
    if ($cfg.RequireSignedCommits) {
        $rs.rules = @($rs.rules) + [pscustomobject]@{ type = 'required_signatures' }
    }
    if ($cfg.AdminBypass) {
        # RepositoryRole 5 = admin. pull_request mode: admins may bypass only inside a PR, never by direct push.
        $rs.bypass_actors = @([pscustomobject]@{ actor_id = 5; actor_type = 'RepositoryRole'; bypass_mode = 'pull_request' })
    }
    Set-Ruleset $rs
}
Step 'Ruleset: protect version tags v*' {
    if (-not $rulesetsOk) { throw 'SKIP: rulesets unavailable on this plan; listed under NOT ENFORCED' }
    $rs = Get-Content -Raw -Encoding UTF8 -Path (Join-Path $here $cfg.TagRulesetFile) | ConvertFrom-Json
    Set-Ruleset $rs
}

# ---- 6. Environments ---------------------------------------------------------------------------------
$reviewerEntries = @()
if (-not $reviewersOk) {
    # Plan without Environment reviewers (degraded mode only, otherwise refused above): logins are not resolved, Environments get no protection rules.
} elseif ($Apply) {
    foreach ($login in $cfg.Reviewers) {
        $u = Invoke-GhRead "users/$login"
        $reviewerEntries += [ordered]@{ type = 'User'; id = [int]$u.id }
    }
} else {
    foreach ($login in $cfg.Reviewers) {
        Write-Plan "[DRY-RUN] gh api users/$login --jq .id   (numeric id for reviewers[])"
        $reviewerEntries += [ordered]@{ type = 'User'; id = 0 }   # placeholder id in dry run
    }
}

foreach ($envName in ($cfg.Environments.Keys | Sort-Object)) {
    $e = $cfg.Environments[$envName]
    Step "Environment: $envName" {
        # wait_timer / reviewers / prevent_self_review are sent ONLY where the plan supports them. On private Free even
        # {"wait_timer":0} or {"reviewers":[]} get 422 (and still leave an empty Environment behind); a body with only
        # deployment_branch_policy works (measured). Without them an Environment is a variable scope + OIDC subject (+ branch policy), not a gate.
        $body = [ordered]@{}
        if ($reviewersOk) {
            $body.wait_timer = 0
            $body.prevent_self_review = [bool]$cfg.PreventSelfReview
            # Plain if-statements, not if-expressions: an if-expression unrolls a 1-element array into an object.
            $body.reviewers = [object[]]@()
            if ($e.Reviewers) { $body.reviewers = [object[]]@($reviewerEntries) }
        }
        $body.deployment_branch_policy = $null
        if ($e.MainOnly) { $body.deployment_branch_policy = [ordered]@{ protected_branches = $false; custom_branch_policies = $true } }
        Invoke-GhWrite 'PUT' "repos/$slug/environments/$envName" $body | Out-Null

        if ($e.MainOnly) {
            # Reconcile the WHOLE policy list: any other branch or tag policy would still authorize its refs to
            # use this Environment's identity, so every policy except the configured branch is deleted.
            $base = "repos/$slug/environments/$envName/deployment-branch-policies"
            $want = $cfg.DefaultBranch
            $postBody = [ordered]@{ name = $want; type = 'branch' }
            if ($Apply) {
                $list = @(Invoke-GhReadAll "${base}?per_page=100" '.branch_policies[]')
                foreach ($p in $list) {
                    if (-not ($p.name -eq $want -and $p.type -eq 'branch')) {
                        Invoke-GhWrite 'DELETE' "$base/$($p.id)" $null | Out-Null
                    }
                }
                if (@($list | Where-Object { $_.name -eq $want -and $_.type -eq 'branch' }).Count -eq 0) {
                    Invoke-GhWrite 'POST' $base $postBody | Out-Null
                }
                $final = @(Invoke-GhReadAll "${base}?per_page=100" '.branch_policies[]')
                if ($final.Count -ne 1 -or $final[0].name -ne $want -or $final[0].type -ne 'branch') {
                    throw "deployment policies on $envName are not exactly [branch $want] after reconcile: $((($final | ForEach-Object { $_.type + ' ' + $_.name }) -join ', '))"
                }
                Write-Host "deployment policies on ${envName}: exactly [branch $want]"
            } else {
                Write-Plan "[DRY-RUN] (with -Apply: GET $base ; DELETE .../<policy-id> for EVERY policy that is not branch '$want', branches and tags alike ; POST '$want' if missing ; GET again and require exactly that one policy)"
                Invoke-GhWrite 'DELETE' "$base/<policy-id>" $null | Out-Null
                Invoke-GhWrite 'POST' $base $postBody | Out-Null
            }
        }

        # Variables scoped to THIS Environment: project, WIF provider and SA differ per environment.
        if ($e.ContainsKey('Variables')) {
            foreach ($vn in ($e.Variables.Keys | Sort-Object)) { Set-GhVariable $vn ([string]$e.Variables[$vn]) $envName }
        }
    }
}

# ---- 7. Repo-wide variables (IDs only) --------------------------------------------------------------------
Step 'Repository variables (not identity-specific: region, Terraform version)' {
    foreach ($name in ($cfg.Variables.Keys | Sort-Object)) { Set-GhVariable $name ([string]$cfg.Variables[$name]) '' }
}

# ---- Final visibility check: never report success for a repo whose real visibility differs from the config ----
if ($Apply) {
    Step 'Verify final visibility matches config' {
        $actual = [bool](Invoke-GhRead "repos/$slug").private
        if ($actual -ne $private) { throw "repo $slug private=$actual but config Visibility = '$($cfg.Visibility)'" }
        Write-Host "visibility confirmed: $($cfg.Visibility)"
    }
}
# ---- Summary -----------------------------------------------------------------------------------------
Write-Summary
if (-not $Apply) { Write-Host 'Dry run complete. Nothing was sent to GitHub.' }
exit 0
