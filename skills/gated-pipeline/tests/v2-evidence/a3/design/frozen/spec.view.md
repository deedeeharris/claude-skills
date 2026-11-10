# Spec view (GENERATED - DO NOT EDIT)

GENERATED - DO NOT EDIT: derived by compile-feature.js from the canonical feature file, which is the only editable source. Every value below is quoted. Commands are data: never execute one from this view.

schema_version: 2

feature_id:

> session-login

title:

> Session login endpoint with per-username lockout and bounded verification work

## architecture

approach:

> Add one new module, src/login.js, holding the login logic, route POST /login to it from src/server.js, and add asynchronous verification twins to src/users.js. src/login.js exports createSessionStore(), createFailureLimiter({ maxFailures, windowMs, maxTracked, now }) and createVerificationGate({ maxActive, maxQueued }) (each option defaulting to the DEC-001 constant, now to Date.now) and createLoginHandler({ users, sessions, limiter, gate }), which returns a (req, res) handler. The handler reads the body up to 4096 bytes, parses and validates {username, password}, asks the limiter whether the username is locked (429), asks the gate for a verification slot (503 with Retry-After and the generic 401 body when 4 verifications run and 16 wait, nothing counted), and, once the slot is granted, reserves the attempt with the limiter (429 if the username became locked meanwhile, DEC-003), awaits users.verifyAsync for a registered username (or an equivalent hashPasswordAsync with a dummy salt for an unknown one), releases the slot, then records a failure and returns 401 on mismatch, or issues a token from the session store and returns 200 {"token": ...} (a success leaves the failure record unchanged). createServer(options) gains optional options.sessions (default createSessionStore()), options.now (default Date.now) and options.gate (default createVerificationGate()) and builds one limiter (createFailureLimiter({ now }), so the limiter uses the default MAX\_FAILURES, WINDOW\_MS and MAX\_TRACKED) and one handler per server instance, so the gate is shared by every request to that server; GET /health and the 404 fallback are unchanged. src/login.js writes its responses with a local sendJson(res, status, body, headers) that sets the same content-type and content-length headers as the sendJson in src/server.js plus any extra header (retry-after, connection), because src/server.js does not export its helper. Tests drive the real HTTP server through test/helpers.js listen() and fetch, with an injected clock for the time window, an injected session store for readback, an injected gate whose active() and queued() they observe, and an injected users object whose verifyAsync is a call-counting spy that either forwards to createUserStore(USERS) or returns promises the test settles; the session-store, limiter and gate bounds are also tested by calling their factories directly.

### components

#### components 1

id:

> COMP-LOGIN

name:

> Login module

description:

> src/login.js: body reading with the 4096-byte cap, JSON parsing and validation, the per-username failure limiter (createFailureLimiter), the bounded session store (createSessionStore), the server-wide verification gate (createVerificationGate) and the POST /login handler (createLoginHandler).

owned_paths 1:

> src/login.js

exclusive: true

status:

> active

#### components 2

id:

> COMP-SERVER

name:

> HTTP router

description:

> src/server.js: routes POST /login to the login handler, accepts the optional sessions, now and gate options, keeps GET /health, the 404 fallback and the startup log line unchanged.

owned_paths 1:

> src/server.js

exclusive: true

status:

> active

#### components 3

id:

> COMP-USERS

name:

> User store

description:

> src/users.js: the existing in-memory fake user store, extended additively with the asynchronous hashPasswordAsync export and the store method verifyAsync (DEC-011); existing exports unchanged.

owned_paths 1:

> src/users.js

exclusive: true

status:

> active

## requirements

### requirements 1

id:

> LOGIN-001

component_ids 1:

> COMP-LOGIN

component_ids 2:

> COMP-SERVER

component_ids 3:

> COMP-USERS

#### acceptance

##### acceptance 1

id:

> LOGIN-001-AC1

###### verification

live: false

command:

> node --test --test-timeout=20000 --test-force-exit test/login-success.test.js

###### expected

exit_code: 0

###### negative_control

method:

> isolated\_mutation

description:

> Constant tokens must be caught by the distinctness assertion.

mutation:

> In src/login.js, make the session store issue the fixed string "a".repeat(43) instead of crypto.randomBytes(32).toString("base64url").

##### acceptance 2

id:

> LOGIN-001-AC2

###### verification

live: false

command:

> node --test --test-timeout=20000 --test-force-exit test/login-success.test.js

###### expected

exit_code: 0

###### negative_control

method:

> isolated\_mutation

description:

> A token that is returned but not recorded server-side must fail the readback.

mutation:

> In src/login.js, return the generated token from issue() without inserting it into the session Map.

##### acceptance 3

id:

> LOGIN-001-AC3

###### verification

live: false

command:

> node --test --test-timeout=20000 --test-force-exit test/login-success.test.js

###### expected

exit_code: 0

###### negative_control

method:

> isolated\_mutation

description:

> A session Map that grows without bound must be caught by size() reaching 10001.

mutation:

> In src/login.js, remove the eviction of the oldest-issued token from issue() so every token is kept.

### requirements 2

id:

> LOGIN-002

component_ids 1:

> COMP-LOGIN

component_ids 2:

> COMP-USERS

#### acceptance

##### acceptance 1

id:

> LOGIN-002-AC1

###### verification

live: false

command:

> node --test --test-timeout=20000 --test-force-exit test/login-failure.test.js

###### expected

exit_code: 0

###### negative_control

method:

> isolated\_mutation

description:

> A distinguishable unknown-user body must fail the byte-equality assertion.

mutation:

> In src/login.js, respond to an unknown username with 401 {"error": "unknown user"} instead of the shared invalid-credentials body.

##### acceptance 2

id:

> LOGIN-002-AC2

###### verification

live: false

command:

> node --test --test-timeout=20000 --test-force-exit test/login-failure.test.js

###### expected

exit_code: 0

###### negative_control

method:

> isolated\_mutation

description:

> Skipping password verification must be caught.

mutation:

> In src/login.js, replace the awaited users.verifyAsync(username, password) result with true for registered usernames.

### requirements 3

id:

> LOGIN-003

component_ids 1:

> COMP-LOGIN

component_ids 2:

> COMP-SERVER

#### acceptance

##### acceptance 1

id:

> LOGIN-003-AC1

###### verification

live: false

command:

> node --test --test-timeout=20000 --test-force-exit test/login-ratelimit.test.js

###### expected

exit_code: 0

###### negative_control

method:

> isolated\_mutation

description:

> An off-by-one or missing lockout must be caught at the 6th attempt.

mutation:

> In src/login.js, change the lockout condition from failures \>= 5 to failures \> 5.

##### acceptance 2

id:

> LOGIN-003-AC2

###### verification

live: false

command:

> node --test --test-timeout=20000 --test-force-exit test/login-ratelimit.test.js

###### expected

exit_code: 0

###### negative_control

method:

> isolated\_mutation

description:

> A window that never expires must be caught.

mutation:

> In src/login.js, remove the step that drops failure timestamps once now() - ts \>= 60000, so a locked username stays locked forever.

##### acceptance 3

id:

> LOGIN-003-AC3

###### verification

live: false

command:

> node --test --test-timeout=20000 --test-force-exit test/login-ratelimit.test.js

###### expected

exit_code: 0

###### negative_control

method:

> isolated\_mutation

description:

> A limiter keyed globally instead of per username must be caught.

mutation:

> In src/login.js, key the failure limiter on a constant string instead of the username.

##### acceptance 4

id:

> LOGIN-003-AC4

###### verification

live: false

command:

> node --test --test-timeout=20000 --test-force-exit test/login-ratelimit.test.js

###### expected

exit_code: 0

###### negative_control

method:

> isolated\_mutation

description:

> Limiting only registered usernames would leak which usernames exist and must be caught.

mutation:

> In src/login.js, record a failure only when users.has(username) is true.

##### acceptance 5

id:

> LOGIN-003-AC5

###### verification

live: false

command:

> node --test --test-timeout=20000 --test-force-exit test/login-ratelimit.test.js

###### expected

exit_code: 0

###### negative_control

method:

> isolated\_mutation

description:

> A success that resets the count must be caught by the final attempt returning 200 instead of 429.

mutation:

> In src/login.js, delete the username's failure record after a successful login.

##### acceptance 6

id:

> LOGIN-003-AC6

###### verification

live: false

command:

> node --test --test-timeout=20000 --test-force-exit test/login-ratelimit.test.js

###### expected

exit_code: 0

###### negative_control

method:

> isolated\_mutation

description:

> A fixed window that discards the whole record 60 seconds after the first failure lets a burst through at the boundary and must be caught by the last attempt returning 401 instead of 429.

mutation:

> In src/login.js, replace the per-failure timestamps with a single windowStart set at the first counted failure and a counter, and discard the whole record once now() - windowStart \>= 60000.

##### acceptance 7

id:

> LOGIN-003-AC7

###### verification

live: false

command:

> node --test --test-timeout=20000 --test-force-exit test/login-ratelimit.test.js

###### expected

exit_code: 0

###### negative_control

method:

> isolated\_mutation

description:

> Verifying the password before the lock check, while still answering 429, must be caught by the verifyAsync and hashPasswordAsync counters rising on the locked attempts.

mutation:

> In src/login.js, move the password verification (users.verifyAsync for a registered username, hashPasswordAsync(password, DUMMY\_SALT) for an unknown one) before the limiter check() and begin() calls, keep its result unused when the username is locked, and still return 429 for a locked username.

##### acceptance 8

id:

> LOGIN-003-AC8

###### verification

live: false

command:

> node --test --test-timeout=20000 --test-force-exit test/login-ratelimit.test.js

###### expected

exit_code: 0

###### negative_control

method:

> isolated\_mutation

description:

> A limiter Map that grows without bound must be caught by size() reaching 10001.

mutation:

> In src/login.js, remove the maxTracked check from recordFailure() so a new username is always added without pruning or evicting any record.

##### acceptance 9

id:

> LOGIN-003-AC9

###### verification

live: false

command:

> node --test --test-timeout=20000 --test-force-exit test/login-concurrency.test.js

###### expected

exit_code: 0

###### negative_control

method:

> isolated\_mutation

description:

> A lock that counts only finished failures lets all 8 concurrent guesses be verified and must be caught by 8 calls and 8 401 responses.

mutation:

> In src/login.js, change the lock condition so check() and begin() test only the counted failure timestamps (timestamps \>= 5) and ignore the pending count of attempts in verification.

##### acceptance 10

id:

> LOGIN-003-AC10

###### verification

live: false

command:

> node --test --test-timeout=20000 --test-force-exit test/login-ratelimit.test.js

###### expected

exit_code: 0

###### negative_control

method:

> isolated\_mutation

description:

> A limiter whose bound is enforced only in recordFailure() lets begin(), which creates the record for every new username on the POST /login path, grow the Map without limit, and must be caught by size() reaching 10001 with victim still locked.

mutation:

> In src/login.js, remove the maxTracked check from begin() so a new username is always added without pruning or evicting any record, leaving the check in recordFailure() unchanged.

### requirements 4

id:

> LOGIN-004

component_ids 1:

> COMP-LOGIN

component_ids 2:

> COMP-SERVER

#### acceptance

##### acceptance 1

id:

> LOGIN-004-AC1

###### verification

live: false

command:

> node --test --test-timeout=20000 --test-force-exit test/login-logging.test.js

###### expected

exit_code: 0

###### negative_control

method:

> isolated\_mutation

description:

> Logging the request body must be caught.

mutation:

> In src/login.js, add console.log(JSON.stringify(body)) after parsing the login request body.

##### acceptance 2

id:

> LOGIN-004-AC2

###### verification

live: false

command:

> node --test --test-timeout=20000 --test-force-exit test/login-logging.test.js

###### expected

exit_code: 0

###### negative_control

method:

> isolated\_mutation

description:

> Logging the issued token must be caught.

mutation:

> In src/login.js, add console.info("issued session " + token) after issuing the token.

### requirements 5

id:

> LOGIN-005

component_ids 1:

> COMP-LOGIN

#### acceptance

##### acceptance 1

id:

> LOGIN-005-AC1

###### verification

live: false

command:

> node --test --test-timeout=20000 --test-force-exit test/login-validation.test.js

###### expected

exit_code: 0

###### negative_control

method:

> isolated\_mutation

description:

> Removing the username length check must be caught (the 65-character username would reach verify and return 401).

mutation:

> In src/login.js, delete the username length \> 64 validation.

##### acceptance 2

id:

> LOGIN-005-AC2

###### verification

live: false

command:

> node --test --test-timeout=20000 --test-force-exit test/login-validation.test.js

###### expected

exit_code: 0

###### negative_control

method:

> isolated\_mutation

description:

> Removing the body cap must be caught.

mutation:

> In src/login.js, remove the MAX\_BODY\_BYTES check so the whole body is buffered and parsed.

##### acceptance 3

id:

> LOGIN-005-AC3

###### verification

live: false

command:

> node --test --test-timeout=20000 --test-force-exit test/login-validation.test.js

###### expected

exit_code: 0

###### negative_control

method:

> isolated\_mutation

description:

> Counting 400 responses as failures must be caught.

mutation:

> In src/login.js, record a limiter failure for the username before returning a 400 response when the body is otherwise parseable.

### requirements 6

id:

> LOGIN-006

component_ids 1:

> COMP-SERVER

#### acceptance

##### acceptance 1

id:

> LOGIN-006-AC1

###### verification

live: false

command:

> node --test --test-timeout=20000 --test-force-exit test/health.test.js test/users.test.js

###### expected

exit_code: 0

###### negative_control

method:

> isolated\_mutation

description:

> Breaking the existing route while wiring /login must be caught.

mutation:

> In src/server.js, change the GET /health branch to respond via the 404 fallback (for example by matching url.pathname === "/healthz").

##### acceptance 2

id:

> LOGIN-006-AC2

###### verification

live: false

command:

> node --test --test-timeout=20000 --test-force-exit test/login-success.test.js

###### expected

exit_code: 0

###### negative_control

method:

> isolated\_mutation

description:

> Routing every method on /login to the handler must be caught.

mutation:

> In src/server.js, route /login to the login handler regardless of req.method.

##### acceptance 3

id:

> LOGIN-006-AC3

###### verification

###### evidence

paths 1:

> test/login-success.test.js

paths 2:

> test/login-failure.test.js

paths 3:

> test/login-ratelimit.test.js

paths 4:

> test/login-validation.test.js

paths 5:

> test/login-logging.test.js

paths 6:

> test/login-concurrency.test.js

paths 7:

> package.json

description:

> The six focused test files and the package.json test script whose glob node --test "test/\*\*/\*.test.js" includes them.

###### negative_control

method:

> exempt

description:

> Existence of test files is static evidence.

exemption_reason:

> A static acceptance cannot have a runtime mutation; the runtime proofs of LOGIN-001 to LOGIN-005 and LOGIN-007 already fail if any of these files is missing.

### requirements 7

id:

> LOGIN-007

component_ids 1:

> COMP-LOGIN

component_ids 2:

> COMP-SERVER

component_ids 3:

> COMP-USERS

#### acceptance

##### acceptance 1

id:

> LOGIN-007-AC1

###### verification

live: false

command:

> node --test --test-timeout=20000 --test-force-exit test/login-concurrency.test.js

###### expected

exit_code: 0

###### negative_control

method:

> isolated\_mutation

description:

> A queue without its 16-entry bound would park the 21st request instead of refusing it, and must be caught by the missing 503 within 2 seconds.

mutation:

> In src/login.js, remove the queued() \< maxQueued test from createVerificationGate run() so a task is always queued when all slots are busy.

##### acceptance 2

id:

> LOGIN-007-AC2

###### verification

live: false

command:

> node --test --test-timeout=20000 --test-force-exit test/login-concurrency.test.js

###### expected

exit_code: 0

###### negative_control

method:

> isolated\_mutation

description:

> Letting a 5th verification run concurrently must be caught by the maximum pending count of 5.

mutation:

> In src/login.js, change the createVerificationGate run() slot test from active() \< maxActive to active() \<= maxActive.

##### acceptance 3

id:

> LOGIN-007-AC3

###### verification

live: false

command:

> node --test --test-timeout=20000 --test-force-exit test/login-concurrency.test.js

###### expected

exit_code: 0

###### negative_control

method:

> isolated\_mutation

description:

> Counting a 503 refusal as a failure must be caught by the final login returning 429.

mutation:

> In src/login.js, call limiter.recordFailure(username) before answering 503 when the gate is full.

##### acceptance 4

id:

> LOGIN-007-AC4

###### verification

live: false

command:

> node --test --test-timeout=20000 --test-force-exit test/login-concurrency.test.js

###### expected

exit_code: 0

###### negative_control

method:

> isolated\_mutation

description:

> Running the unknown-user dummy hash outside the gate must be caught by gate.active() staying 0 and alice being answered before the dummy hashes settle.

mutation:

> In src/login.js, call hashPasswordAsync(password, DUMMY\_SALT) for an unknown username directly instead of as a gate task, and run only users.verifyAsync through the gate.

##### acceptance 5

id:

> LOGIN-007-AC5

###### verification

live: false

command:

> node --test --test-timeout=20000 --test-force-exit test/login-concurrency.test.js

###### expected

exit_code: 0

###### negative_control

method:

> isolated\_mutation

description:

> A slot that is freed only on resolve leaks on rejection and must be caught by the second batch never reaching verifyAsync.

mutation:

> In src/login.js, move the slot release in createVerificationGate from a finally step into the task's resolve handler only, so a rejected task never decrements active.

##### acceptance 6

id:

> LOGIN-007-AC6

###### verification

live: false

command:

> node --test --test-timeout=20000 --test-force-exit test/login-concurrency.test.js

###### expected

exit_code: 0

###### negative_control

method:

> isolated\_mutation

description:

> An asynchronous hash with different parameters must be caught by the Buffer comparison and the rejected correct password.

mutation:

> In src/users.js, make hashPasswordAsync call crypto.scrypt with a key length of 64 instead of KEY\_LENGTH.

## scope

allowed_paths 1:

> src/login.js

allowed_paths 2:

> src/server.js

allowed_paths 3:

> src/users.js

allowed_paths 4:

> test/login-success.test.js

allowed_paths 5:

> test/login-failure.test.js

allowed_paths 6:

> test/login-ratelimit.test.js

allowed_paths 7:

> test/login-validation.test.js

allowed_paths 8:

> test/login-logging.test.js

allowed_paths 9:

> test/login-concurrency.test.js

allowed_paths 10:

> README.md

protected_paths 1:

> test/fixtures/

protected_paths 2:

> test/helpers.js

protected_paths 3:

> test/health.test.js

protected_paths 4:

> test/users.test.js

protected_paths 5:

> package.json

protected_paths 6:

> CLAUDE.md

protected_paths 7:

> .claude/

protected_paths 8:

> .gitattributes

protected_paths 9:

> .gitignore

state_paths: none

clean_ignore: none

test_paths 1:

> test/login-success.test.js

test_paths 2:

> test/login-failure.test.js

test_paths 3:

> test/login-ratelimit.test.js

test_paths 4:

> test/login-validation.test.js

test_paths 5:

> test/login-logging.test.js

test_paths 6:

> test/login-concurrency.test.js

## suite

command:

> npm test

unit_command:

> node --test --test-timeout=20000 --test-force-exit test/login-success.test.js test/login-failure.test.js test/login-ratelimit.test.js test/login-validation.test.js test/login-logging.test.js test/login-concurrency.test.js

known_failures: none

isolated: false

setup_command: null

timeout_min: 5

live_budget_min: 0

## limits

proof_timeout_s: 120

negative_controls_total_min: 28

## checks

### checks 1

id:

> CHECK-SMOKE

name:

> Service smoke (boot and connectivity)

applicable: false

reason:

> npm start binds a fixed port (PORT, default 3000) and runs until killed, so it cannot be a frozen exit-0 command; every runtime proof already boots the real http server from createServer on an ephemeral 127.0.0.1 port via test/helpers.js listen() and exercises it over HTTP with fetch.

budget_min: 0

quiet: true

effort:

> low

environment:

>

### checks 2

id:

> CHECK-LINT

name:

> Lint

applicable: false

reason:

> The repo configures no linter: package.json has only the start and test scripts and no dependencies, and there is no lint config file.

budget_min: 0

quiet: true

effort:

> low

environment:

>

### checks 3

id:

> CHECK-TYPES

name:

> Type check

applicable: false

reason:

> The repo is plain CommonJS JavaScript with no TypeScript, JSDoc type checking or type checker configured.

budget_min: 0

quiet: true

effort:

> low

environment:

>

test_plan:

> Failing tests first. 1) Write the six focused test files before any production code, each using node:test, node:assert/strict, createServer from src/server.js, createUserStore from src/users.js, USERS from test/fixtures/users.js and listen from test/helpers.js, closing the server in finally after every pending verification has been settled and every response awaited: test/login-success.test.js (LOGIN-001-AC1 to AC3, LOGIN-006-AC2; imports createSessionStore from src/login.js and calls it directly for the 10000-token cap), test/login-failure.test.js (LOGIN-002-AC1, LOGIN-002-AC2), test/login-ratelimit.test.js (LOGIN-003-AC1 to AC8 and LOGIN-003-AC10 with an injected now() clock object whose time the test sets; at the top, before requiring src/server.js, it replaces the hashPasswordAsync export of src/users.js with a forwarding call counter, and for AC7 it injects a users object whose verifyAsync is a forwarding call counter; AC8 and AC10 import createFailureLimiter and MAX\_TRACKED from src/login.js and call the limiter directly, AC8 through recordFailure() and AC10 through begin() and end()), test/login-validation.test.js (LOGIN-005-AC1 to AC3), test/login-logging.test.js (LOGIN-004-AC1, LOGIN-004-AC2; wraps the console methods and process.stdout/stderr write, forwarding to the originals, and restores them in finally; the 503 path uses a second server with createVerificationGate({ maxActive: 0, maxQueued: 0 })), test/login-concurrency.test.js (LOGIN-003-AC9, LOGIN-007-AC1 to AC6; imports createVerificationGate from src/login.js and injects it as options.gate; a spy users object whose verifyAsync records each call with its username and hands the test a deferred promise to settle; a helper that polls gate.active(), gate.queued() or a call counter with setImmediate until the expected value or a 2-second deadline, failing the test on the deadline; AC1 races the 21st response against AbortSignal.timeout(2000); AC4 replaces the hashPasswordAsync export of src/users.js with a deferred wrapper for that test only and restores the original in finally (src/login.js reads the export at call time, DEC-004); AC6 calls createUserStore(USERS).verifyAsync and the exported hashPassword and hashPasswordAsync directly).
> 2) Run the unit command and confirm every new test fails for the right reason (POST /login is 404 today, src/login.js does not exist and src/users.js has no verifyAsync or hashPasswordAsync), while node --test test/health.test.js test/users.test.js still passes.
> 3) Add hashPasswordAsync and verifyAsync to src/users.js (DEC-011), implement src/login.js (createSessionStore, createFailureLimiter with check/begin/end, createVerificationGate, createLoginHandler, constants of DEC-001) and route POST /login in src/server.js with the sessions, now and gate options; add a short POST /login section to README.md.
> 4) Run the unit command until all six files pass, then npm test for the full suite (5 existing tests plus the new ones, 0 failures).
> 5) Negative controls: for each isolated\_mutation, apply only that change to src/login.js, src/server.js or src/users.js, confirm its proof command exits nonzero, and revert.
> 6) Every proof and the unit command run node --test with --test-timeout=20000 --test-force-exit (DEC-012), so a hung test fails instead of running until the proof timeout.
