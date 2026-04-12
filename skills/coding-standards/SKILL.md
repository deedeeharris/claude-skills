---
name: coding-standards
description: Universal coding standards for any language or stack. Run BEFORE writing code (to set intent) and AFTER writing code (to verify quality). Covers naming, structure, security, tests, and commits.
---

# Coding Standards

Universal rules that apply to every language, stack, and project. Run this skill **before writing code** to anchor intent, and **after writing code** to verify quality.

---

## PHASE 1 — Before Writing Code

Answer these questions before touching a file:

1. **Do I understand the full requirement?** — including edge cases, error paths, and what "done" means
2. **Does similar code already exist?** — read the surrounding codebase; reuse before creating
3. **What is the correct abstraction level?** — function, class, module, or new file?
4. **What can go wrong?** — enumerate failure modes before writing happy-path code
5. **What are the security risks?** — identify any untrusted input, auth boundary, or sensitive data involved

If you can't answer all five, stop and investigate first.

---

## PHASE 2 — Writing Code

### Naming
- Names must explain **why** and **what** without comments — if a name needs a comment, rename it
- No abbreviations except universally understood ones (`id`, `url`, `db`, `api`, `i`/`j`/`k`, `x`/`y`/`z`)
- Be consistent: match the naming style already used in the file/module
- Boolean names start with `is`, `has`, `can`, `should`

### Structure
- **One responsibility per function/class** — if you need "and" to describe it, split it
- **~200 lines max per file** — a growing file is a signal to split into focused modules
- **No magic strings or numbers** — use named constants or enums
- **No deep nesting** — flatten with early returns; max 3 levels before refactoring
- **No duplicate logic** — extract to a shared function after the second occurrence
- **YAGNI** — build what is needed now, not what might be needed later

### Error Handling
- Handle errors at the right level — don't swallow exceptions silently
- Return meaningful errors; never expose stack traces or internal state to callers
- Validate all inputs at system boundaries (API endpoints, CLI args, file reads, WebSocket messages)
- Distinguish recoverable errors (return/raise) from unrecoverable ones (crash fast)

### Comments
- **No comments explaining what the code does** — that's the code's job
- Only add a comment when explaining **why** a non-obvious decision was made
- Never leave TODO/FIXME/HACK in committed code — fix it or open a tracked issue

---

## PHASE 3 — After Writing Code (Self-Review Checklist)

Go through this before considering work complete:

### Correctness
- [ ] All edge cases handled (empty input, null, zero, overflow, concurrent access)
- [ ] Error paths tested or at minimum manually traced
- [ ] No off-by-one errors, no missed async/await, no unclosed resources

### Cleanliness
- [ ] No dead code, no commented-out blocks, no debug prints/logs
- [ ] No unnecessary complexity — could a junior developer follow this?
- [ ] No premature abstraction — is every helper/utility actually used more than once?
- [ ] File is still under ~200 lines; if not, split it

### Security
- [ ] No hardcoded secrets, tokens, passwords, or API keys
- [ ] All external inputs validated and sanitized before use
- [ ] Authentication/authorization checked at every entry point
- [ ] Errors don't leak internal details (file paths, DB schema, stack traces)
- [ ] No direct string interpolation into queries, commands, or HTML (SQL injection, XSS, command injection)
- [ ] Tokens and credentials generated with a cryptographically secure source
- [ ] Sensitive data never written to logs

### Tests
- [ ] Happy path covered
- [ ] At least one edge case or failure mode covered
- [ ] Tests are independent (no shared mutable state between tests)
- [ ] Test names describe the scenario, not just the function name

### Boy Scout Rule
- [ ] The code I touched is cleaner than before I arrived

---

## PHASE 4 — Git Commits

- **Atomic commits** — one logical change per commit; don't bundle unrelated changes
- **Conventional commit format**: `type(scope): short description`
  - Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `perf`, `ci`
  - Subject line ≤ 72 characters, imperative mood ("add X" not "added X")
- **Body** explains *why*, not *what* — only add if the change is non-obvious
- **Never commit**: debug code, commented-out blocks, `.env` files, hardcoded secrets, temp files
- Reference issue numbers when applicable: `fix(auth): handle expired tokens (#42)`

---

## Quick Reference Card

| Before writing | After writing |
|---|---|
| Understand requirements fully | All edge cases handled |
| Find existing patterns to reuse | No dead/debug code |
| Identify failure modes | Security checklist passed |
| Identify security risks | Tests cover happy + failure paths |
| Know what "done" looks like | Boy Scout Rule applied |
