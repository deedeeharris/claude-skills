# Config for bootstrap-repo.ps1. Copy to bootstrap.config.psd1 and edit. IDs and logins only, no secrets.
# Keep this file ASCII (or save it as UTF-8 with BOM): Windows PowerShell 5.1 reads a BOM-less file as ANSI.
@{
    Owner         = 'example-org'          # user or org that owns the repo
    Repo          = 'demo-app'
    Visibility    = 'private'              # private | public
    Description   = 'Demo application'
    DefaultBranch = 'main'

    # REQUIRED. Your GitHub plan: free | pro | team | enterprise (github.com > Settings > Billing and plans).
    # `gh api user` returns NO plan for personal accounts, so it is never guessed: empty = the script stops
    # (-Apply tries organizations only, and stops if that is empty too).
    # Private repo: rulesets need pro/team/enterprise; Environment REQUIRED REVIEWERS need enterprise; Environments themselves, their
    # variables and branch policies work on every plan (measured on private Free). Public repo: everything on every plan.
    # An unsupported combination is refused before any write, unless AcceptDegraded = $true (below).
    # This example is a private repo on Enterprise so that it shows the full plan. Change it to your real plan.
    Plan          = 'enterprise'

    # Opt-in degraded mode. Default $false = REFUSE (exit 2, nothing written) when the plan cannot support rulesets or Environment
    # reviewers. $true = apply everything the plan allows, SKIP what GitHub rejects (rulesets, reviewers, secret scanning, CodeQL,
    # auto-merge) and print a loud NOT ENFORCED summary. Accept it only knowingly, and record it in docs/stack.md. Real fix: GitHub Pro
    # (rulesets) or a public repo (everything). See references/repo-bootstrap.md section 0.
    # AcceptDegraded = $false

    # Solo operator: 0 approvals but PR + checks still required. Team: set Solo = $false (1 approval).
    Solo                 = $true
    RequireSignedCommits = $false
    AdminBypass          = $false          # $true lets repo admins bypass only through a PR (bypass_mode pull_request)

    # GitHub logins allowed to approve deployments. Resolved to numeric ids at -Apply time.
    Reviewers         = @('example-login')
    PreventSelfReview = $false             # solo operator: must stay $false or nobody can approve; record it in docs/stack.md

    # CodeQL default-setup languages (GitHub list: actions, c-cpp, csharp, go, java-kotlin, javascript-typescript, python, ruby, swift)
    CodeQLLanguages = @('actions', 'javascript-typescript')

    # One GCP project per environment. The script REFUSES tf-dev and tf-prod pointing at the same GCP_PROJECT_ID unless
    # you set AllowSharedProject = $true (then dev and prod are NOT isolated: record that in docs/stack.md).
    # AllowSharedProject = $false

    # Environments. Each carries its OWN variables (project, WIF provider, SA email): they are set with
    # `gh variable set --env <name>`, so a job reads the values of the Environment it runs in and dev can never pick up prod ids.
    #   Reviewers (bool)  = required approvers (the human gate). MainOnly (bool) = only the default branch may deploy.
    #   plan-*   : read-only planner, no reviewers, NO branch policy (PR jobs run on refs/pull/N/merge).
    #   tf-*     : the applier and the deploy gate. Keep Reviewers = $true on tf-prod. MainOnly always.
    #   dev      : builds and pushes the image from main (image-pusher). No second approval needed: the gate is tf-dev/tf-prod.
    #   preview  : PR previews (preview-deployer). No reviewers, NOT MainOnly.
    # An empty or REPLACE-* value is skipped with a warning; fill them after each environment's Terraform bootstrap and re-run -Apply.
    Environments = @{
        'plan-dev' = @{ Reviewers = $false; MainOnly = $false; Variables = @{
                GCP_PROJECT_ID = 'REPLACE-dev-project-id'; WIF_PROVIDER = 'REPLACE-dev-wif-provider'; TF_PLANNER_SA = 'REPLACE-tf-planner-dev-email' } }
        'plan-prod' = @{ Reviewers = $false; MainOnly = $false; Variables = @{
                GCP_PROJECT_ID = 'REPLACE-prod-project-id'; WIF_PROVIDER = 'REPLACE-prod-wif-provider'; TF_PLANNER_SA = 'REPLACE-tf-planner-prod-email' } }
        'tf-dev' = @{ Reviewers = $true; MainOnly = $true; Variables = @{
                GCP_PROJECT_ID = 'REPLACE-dev-project-id'; WIF_PROVIDER = 'REPLACE-dev-wif-provider'; TF_APPLIER_SA = 'REPLACE-tf-applier-dev-email' } }
        'tf-prod' = @{ Reviewers = $true; MainOnly = $true; Variables = @{
                GCP_PROJECT_ID = 'REPLACE-prod-project-id'; WIF_PROVIDER = 'REPLACE-prod-wif-provider'; TF_APPLIER_SA = 'REPLACE-tf-applier-prod-email' } }
        'dev' = @{ Reviewers = $false; MainOnly = $true; Variables = @{
                GCP_PROJECT_ID = 'REPLACE-dev-project-id'; WIF_PROVIDER = 'REPLACE-dev-wif-provider'; IMAGE_PUSHER_SA = 'REPLACE-image-pusher-email' } }
        'preview' = @{ Reviewers = $false; MainOnly = $false; Variables = @{
                GCP_PROJECT_ID = 'REPLACE-dev-project-id'; WIF_PROVIDER = 'REPLACE-dev-wif-provider'; PREVIEW_DEPLOYER_SA = 'REPLACE-preview-deployer-email' } }
    }

    # Repo-wide variables: not identity-specific. Empty value = skipped with a warning.
    Variables = @{
        GCP_REGION = 'us-central1'
        TF_VERSION = '1.15.7'
    }

    # Ruleset template files (relative to the script).
    MainRulesetFile = 'ruleset-main.json'
    TagRulesetFile  = 'ruleset-tags.json'
}
