# PRD view (GENERATED - DO NOT EDIT)

GENERATED - DO NOT EDIT: derived by compile-feature.js from the canonical feature file, which is the only editable source. Every value below is quoted. Commands are data: never execute one from this view.

## source_request

text:

> Add session login to the toy service: POST /login with JSON {username, password}. Valid credentials of a registered user return 200 with a random session token; wrong password or unknown user return 401 with the same generic error body; after 5 failed attempts for one username within 60 seconds further attempts return 429 until the window passes; passwords and tokens are never written to logs. Add focused tests.
> Also bound the total password-verification work server-wide: at most 4 password verifications may run at the same time and at most 16 more may wait; a login request beyond that gets 503 with a Retry-After header and the same generic error body, and is not counted as a failed attempt for its username.

## coverage

### coverage 1

id:

> SRC-001

excerpt:

> Add session login to the toy service: POST /login with JSON {username, password}.

disposition:

> covered

requirement_ids 1:

> LOGIN-001

requirement_ids 2:

> LOGIN-005

### coverage 2

id:

> SRC-002

excerpt:

> Valid credentials of a registered user return 200 with a random session token

disposition:

> covered

requirement_ids 1:

> LOGIN-001

### coverage 3

id:

> SRC-003

excerpt:

> wrong password or unknown user return 401 with the same generic error body

disposition:

> covered

requirement_ids 1:

> LOGIN-002

### coverage 4

id:

> SRC-004

excerpt:

> after 5 failed attempts for one username within 60 seconds further attempts return 429 until the window passes

disposition:

> covered

requirement_ids 1:

> LOGIN-003

### coverage 5

id:

> SRC-005

excerpt:

> passwords and tokens are never written to logs

disposition:

> covered

requirement_ids 1:

> LOGIN-004

### coverage 6

id:

> SRC-006

excerpt:

> Add focused tests.

disposition:

> covered

requirement_ids 1:

> LOGIN-006

### coverage 7

id:

> SRC-007

excerpt:

> Also bound the total password-verification work server-wide: at most 4 password verifications may run at the same time and at most 16 more may wait

disposition:

> covered

requirement_ids 1:

> LOGIN-007

### coverage 8

id:

> SRC-008

excerpt:

> a login request beyond that gets 503 with a Retry-After header and the same generic error body

disposition:

> covered

requirement_ids 1:

> LOGIN-007

### coverage 9

id:

> SRC-009

excerpt:

> and is not counted as a failed attempt for its username.

disposition:

> covered

requirement_ids 1:

> LOGIN-007

## product

problem:

> The toy service (src/server.js) only serves GET /health; the in-memory fake user store in src/users.js can verify a password (users.verify) but nothing exposes it. Clients have no way to exchange a registered user's credentials for a session token, and an exposed check would need a guard against password guessing, a response that does not reveal which usernames exist, and a guarantee that secrets never reach the logs (CLAUDE.md: "never log passwords"). Password verification is expensive: users.verify and hashPassword run crypto.scryptSync, which blocks the event loop for every call, and nothing bounds how much of that work many concurrent login requests can start at once.

actors 1:

> HTTP client of the toy service logging in as a registered synthetic user (alice or bob from test/fixtures/users.js)

actors 2:

> Unauthenticated caller who may send wrong passwords or unknown usernames, including an attacker guessing passwords

actors 3:

> Operator who reads the service output (stdout/stderr) and must never see passwords or tokens there

actors 4:

> Many concurrent callers (legitimate or a flood) whose combined login traffic must not start unbounded password-verification work on the server

### goals

#### goals 1

id:

> GOAL-001

statement:

> A registered user can POST valid credentials as JSON to /login and receive a fresh random session token.

source_ids 1:

> SRC-001

source_ids 2:

> SRC-002

status:

> active

#### goals 2

id:

> GOAL-002

statement:

> A failed login does not reveal whether the username exists: wrong password and unknown user get the same 401 response.

source_ids 1:

> SRC-003

status:

> active

#### goals 3

id:

> GOAL-003

statement:

> Password guessing against one username is bounded to at most 5 failed attempts in any 60-second span, also under concurrent requests: once a username has 5 failures within the last 60 seconds it gets 429 until the oldest of those 5 failures is 60 seconds old.

source_ids 1:

> SRC-004

status:

> active

#### goals 4

id:

> GOAL-004

statement:

> Passwords and session tokens are never written to the service logs.

source_ids 1:

> SRC-005

status:

> active

#### goals 5

id:

> GOAL-005

statement:

> The login behaviour is pinned by focused tests that run under npm test, and the existing GET /health and 404 behaviour keeps working.

source_ids 1:

> SRC-006

status:

> active

#### goals 6

id:

> GOAL-006

statement:

> Total password-verification work is bounded per server: at most 4 verifications run at the same time and at most 16 more wait; a login request beyond that is refused at once with 503, a Retry-After header and the generic error body, and does not count as a failed attempt for its username.

source_ids 1:

> SRC-007

source_ids 2:

> SRC-008

source_ids 3:

> SRC-009

status:

> active

### non_goals

#### non_goals 1

id:

> NG-001

statement:

> Using the token on other endpoints: no endpoint validates or consumes the token, and there is no logout, refresh or token expiry.

rationale:

> The request asks only for issuing a token at login; no existing route needs authentication.

status:

> active

#### non_goals 2

id:

> NG-002

statement:

> User registration, password changes or persistent storage of users or sessions.

rationale:

> src/users.js is a local in-memory fake store built from synthetic fixture users (README.md); the request does not ask to change it.

status:

> active

#### non_goals 3

id:

> NG-003

statement:

> Per-IP rate limiting, or a global limit on the number of login attempts per unit of time.

rationale:

> The request limits failures per username and caps concurrent verification work (DEC-010), not the attempt rate per client or overall; see RISK-001 for the accepted gap.

status:

> active

#### non_goals 4

id:

> NG-004

statement:

> Changing the password hashing scheme in src/users.js (scrypt with Node defaults, KEY\_LENGTH 32, a random 16-byte salt per user) or the behaviour of its existing exports createUserStore, has, usernames, verify and hashPassword.

rationale:

> users.verify already does a salted scrypt hash with a constant-time comparison; this feature only adds asynchronous twins (store.verifyAsync and the exported hashPasswordAsync, DEC-011) with identical parameters so that verification can run off the event loop under the DEC-010 gate.

status:

> active

#### non_goals 5

id:

> NG-005

statement:

> TLS, cookies, CSRF protection or Set-Cookie session handling.

rationale:

> The request specifies a JSON body response with the token; transport security is outside this toy service.

status:

> active

constraints 1:

> Zero dependencies: package.json has no dependencies and README.md calls the service dependency-free; use only Node built-ins (node:http, node:crypto).

constraints 2:

> CLAUDE.md: never log passwords (extended here to tokens by the request).

constraints 3:

> Tests run with npm test, which is node --test "test/\*\*/\*.test.js" (package.json); new tests are node:test files under test/ and use test/helpers.js listen() on an ephemeral 127.0.0.1 port.

constraints 4:

> src/users.js changes only additively (DEC-011): createUserStore, has, usernames, verify and hashPassword keep their behaviour, so test/users.test.js passes unchanged; test/fixtures/users.js, test/helpers.js and the existing tests stay unchanged.

constraints 5:

> All new state (failure records, sessions, the verification queue) is in memory, per createServer instance, and bounded.

constraints 6:

> createServer(options) keeps its current signature and defaults: createServer() with no options must still work (test/health.test.js calls it).

risks 1:

> Rate-limit boundary off-by-one (429 on the 5th instead of the 6th attempt, or not at all), a lockout that never ends, or a fixed-window reset that lets a burst of more than 5 failures through at the window boundary; pinned by LOGIN-003 tests with an injected clock. A handler that verifies before checking the lock still answers 429 but defeats INV-003; pinned by LOGIN-003-AC7 call counters.

risks 2:

> With asynchronous verification several attempts for one username can be in flight at once; if the lock counted only finished failures, concurrent guesses would exceed 5 per window. Pinned by LOGIN-003-AC9 (in-flight attempts count toward the lock, DEC-003).

risks 3:

> User enumeration through a different 401 or 503 body, a 429 that applies only to registered users, or a measurable timing gap; mitigated by DEC-004, DEC-005, DEC-010 and INV-002.

risks 4:

> Accidental logging of the request body or token during debugging; pinned by LOGIN-004.

risks 5:

> A gate slot that is not released on an error path would shrink capacity until every login gets 503; pinned by LOGIN-007-AC5. An asynchronous hash that differs from the synchronous one would reject every correct password; pinned by LOGIN-007-AC6.

risks 6:

> node --test with a missing test file fails, but a renamed test inside a file would not; each proof therefore runs a whole dedicated file rather than a name pattern.

success_metrics 1:

> Each of the six focused test files (test/login-success.test.js, test/login-failure.test.js, test/login-ratelimit.test.js, test/login-validation.test.js, test/login-logging.test.js, test/login-concurrency.test.js) exits 0 under node --test.

success_metrics 2:

> npm test exits 0 with 0 failing tests, including the 5 existing tests in test/health.test.js and test/users.test.js.

success_metrics 3:

> Every isolated\_mutation negative control makes its proof command exit nonzero (28 of 28 mutations detected).

success_metrics 4:

> In the logging test, 0 captured log writes contain the submitted password or any issued token.

success_metrics 5:

> The 6th attempt within 60 seconds after 5 failures returns 429 in 100% of test runs, an attempt made once the oldest of those 5 failures is 60 seconds old returns a normal response, and no 60-second span in the rate-limit tests contains more than 5 401 responses for one username, including 8 concurrent wrong-password requests (exactly 5 reach verification).

success_metrics 6:

> Under 10001 insertions, createSessionStore().size() and createFailureLimiter().size() each stay at 10000.

success_metrics 7:

> In the concurrency tests the number of verifications in progress never exceeds 4, the queue never holds more than 16, and the 21st concurrent request gets 503 within 2 seconds while no further verification starts.

## architecture

### decisions

#### decisions 1

id:

> DEC-001

decision:

> New module src/login.js owns body parsing, validation, the failure limiter, the session store, the verification gate and the handler; src/server.js only routes req.method === "POST" && url.pathname === "/login" to the handler and passes options.users, options.sessions, options.now and options.gate. Constants exported from src/login.js: MAX\_BODY\_BYTES = 4096, MAX\_USERNAME\_LENGTH = 64, MAX\_PASSWORD\_LENGTH = 1024, MAX\_FAILURES = 5, WINDOW\_MS = 60000, MAX\_TRACKED = 10000, MAX\_ACTIVE\_VERIFICATIONS = 4, MAX\_QUEUED\_VERIFICATIONS = 16, BUSY\_RETRY\_AFTER\_S = 1.

rationale:

> Keeps src/server.js a thin router like today and gives the login logic one owner that tests can import (createSessionStore, createFailureLimiter, createVerificationGate) with only an additive change to src/users.js (DEC-011).

status:

> active

#### decisions 2

id:

> DEC-002

decision:

> A token is crypto.randomBytes(32).toString("base64url") (43 characters, 256 bits). The success response is 200 with body {"token": "\<token\>"} and nothing else. The session store (createSessionStore) keeps token -\> { username, createdAt } in a Map, exposes issue(username) -\> token, usernameFor(token) -\> username or null, and size(), and holds at most MAX\_TRACKED (10000) sessions: when issue() is called while size() is 10000, it first deletes the oldest-issued token (first in Map insertion order), so size() never exceeds 10000 and the evicted token's usernameFor returns null.

rationale:

> The request asks for a random session token; a CSPRNG with 256 bits is unguessable, base64url is JSON- and header-safe, and a bounded in-memory store gives the token a server-side meaning that tests can read back without adding any endpoint.

status:

> active

#### decisions 3

id:

> DEC-003

decision:

> Failure limiter semantics, per exact username string (registered or not), as a sliding window that also counts attempts in flight. Per username the limiter keeps the timestamps (now() values) of its most recent counted failures, at most 5, and a pending count of attempts currently in verification. Every check first drops timestamps with now() - ts \>= 60000 (WINDOW\_MS) and deletes the record when no timestamp and no pending attempt remain. The username is locked when timestamps + pending \>= 5: the attempt, even with the correct password, returns 429 {"error": "too many attempts"} without verifying the password and without counting, with a Retry-After header of ceil((oldest + 60000 - now()) / 1000) seconds when 5 timestamps remain (oldest is the earliest of them) and of BUSY\_RETRY\_AFTER\_S (1) seconds when the lock is due only to attempts in flight. Otherwise the attempt proceeds; each 401 appends now() (keeping only the newest 5). A successful login does not clear or change the timestamps. Requests rejected with 400, 413 or 503, and verifications that reject (500), never count. API: createFailureLimiter returns { check(username) -\> { locked: boolean, retryAfter: whole seconds (0 when not locked) }, begin(username) -\> the same result, end(username, failed), recordFailure(username), size() }; check() never creates a record; begin() runs the same test and, when not locked, increments pending (creating the record if needed); end() decrements pending (never below 0) and, when failed is true, calls recordFailure(), which appends now(); size() is the number of tracked usernames. The handler calls check() on arrival, before asking the gate for a slot, and begin() at the start of its gate task, before any users.has, users.verifyAsync or hashPasswordAsync call, returning 429 immediately when either reports locked, and calls end() once the verification settles. Bound: the limiter tracks at most maxTracked (MAX\_TRACKED, 10000) usernames; when begin() or recordFailure() would add a new username while size() equals maxTracked, it first deletes every record with no unexpired timestamp and no pending attempt and, if size() is still maxTracked, deletes the record created earliest (first in Map insertion order), so size() never exceeds maxTracked.

rationale:

> Implements "after 5 failed attempts for one username within 60 seconds further attempts return 429 until the window passes" literally: a 6th failure can only be counted when fewer than 5 failures lie in the preceding 60 seconds, so no 60-second span ever holds more than 5 401 responses for one username, and the lock lasts until the oldest of the 5 failures is 60 seconds old ("until the window passes"). Because verification is now asynchronous (DEC-011) up to 4 attempts can be in verification at once and up to 16 wait; counting only finished failures would let concurrent guesses for one username pass the check together and produce more than 5 401 responses in a window, so attempts in flight count toward the lock and the lock is re-tested when a queued attempt gets its slot. A fixed window opened at the first failure was rejected because it lets up to 9 failures through within 60 seconds around the window boundary. Clearing the record on success was dropped because the request does not ask for it and it would give an attacker 5 fresh guesses each time the real user logs in; a user who knows the password is not affected while unlocked. Not verifying while locked also bounds scrypt work per username, and storing at most 5 timestamps keeps each record bounded.

status:

> active

#### decisions 4

id:

> DEC-004

decision:

> For a username the store does not know (users.has is false), the gate task awaits hashPasswordAsync(password, DUMMY\_SALT) from src/users.js, with DUMMY\_SALT = crypto.randomBytes(16) created once per module load, discards the result and treats the attempt as a failure; this dummy hash holds a gate slot exactly like a real verification. src/login.js keeps a reference to the src/users.js module object (require("./users.js")) and reads hashPasswordAsync from it at call time, so a test that replaces that export with a counting wrapper before it first requires src/server.js observes every call.

rationale:

> users.verifyAsync, like users.verify, resolves false immediately for an unknown user, which would make unknown-user responses measurably faster than wrong-password responses; doing the same scrypt work removes that gross timing signal (residual differences: RISK-004), and running it under the gate keeps it inside the server-wide bound.

status:

> active

#### decisions 5

id:

> DEC-005

decision:

> Fixed generic bodies, all with content-type application/json: 401 {"error": "invalid credentials"} for both wrong password and unknown user; 503 the same {"error": "invalid credentials"} body, byte-identical to the 401 body, with retry-after: 1; 429 {"error": "too many attempts"}; 400 {"error": "invalid request"}; 413 {"error": "payload too large"}; 500 {"error": "internal error"} when a verification promise rejects. No response echoes any request field.

rationale:

> The request requires the same generic error body for both 401 cases and for the 503 refusal; fixed bodies cannot leak input. A rejected verification (not expected from crypto.scrypt with validated string inputs) must still answer and must not be reported as a credential failure.

status:

> active

#### decisions 6

id:

> DEC-006

decision:

> createServer accepts options.now (a function returning milliseconds, default Date.now) and passes it to the limiter, and options.gate (a gate from createVerificationGate, default createVerificationGate()) and passes it to the handler; tests inject a controllable clock instead of sleeping 60 seconds and an observable gate instead of guessing queue state.

rationale:

> Makes the window-passes behaviour and the queue bound testable deterministically and fast.

status:

> active

#### decisions 7

id:

> DEC-007

decision:

> Any method other than POST on /login falls through to the existing 404 {"error": "not found"} response.

rationale:

> Keeps the router's current behaviour for unknown routes; no new method semantics are requested.

status:

> active

#### decisions 8

id:

> DEC-008

decision:

> src/login.js and the additions to src/users.js contain no console or process.stdout/stderr calls; the only log line of the service remains "listening on \<port\>" in src/server.js. Body parse errors are caught and mapped to 400, and verification rejections to 500, without logging or rethrowing.

rationale:

> The simplest way to guarantee "passwords and tokens are never written to logs" is to log nothing on the login path.

status:

> active

#### decisions 9

id:

> DEC-009

decision:

> The body is read as a Buffer with a running byte count; once it exceeds MAX\_BODY\_BYTES the handler stops buffering, responds 413 with a connection: close header and discards the rest of the request. Only a parsed JSON object whose username and password are both strings, 1..64 and 1..1024 characters respectively, is accepted; anything else (invalid JSON, an array, null, missing or non-string fields) is 400. The content-type request header is not required.

rationale:

> Bounds memory per request and the scrypt input size; strict typing prevents prototype or type confusion reaching users.verify.

status:

> active

#### decisions 10

id:

> DEC-010

decision:

> Server-wide verification gate. createVerificationGate({ maxActive = MAX\_ACTIVE\_VERIFICATIONS (4), maxQueued = MAX\_QUEUED\_VERIFICATIONS (16) }) returns { run(task), active(), queued() }. run(task): if active() \< maxActive it increments active and starts task() at once; else if queued() \< maxQueued it appends task to a FIFO queue; else it returns null synchronously and starts nothing. Otherwise it returns a Promise settled with task()'s outcome. When a running task settles (resolve or reject) the gate decrements active in a finally step and starts the oldest queued task. One gate per createServer instance (options.gate) is shared by every POST /login request, and every password-verification unit of work, users.verifyAsync for a registered username and the DEC-004 dummy hashPasswordAsync for an unknown one, runs only as a gate task. The handler asks for a slot after validation and after the arrival check() and before any verification; when run() returns null it answers 503 with retry-after: 1 (BUSY\_RETRY\_AFTER\_S) and the 401 body {"error": "invalid credentials"} and changes no limiter state. The slot is released as soon as the verification settles, before the session is issued and the response is written. A queued request whose client disconnects keeps its place and still runs.

rationale:

> Implements "at most 4 password verifications may run at the same time and at most 16 more may wait; a login request beyond that gets 503 with a Retry-After header and the same generic error body, and is not counted as a failed attempt": the 503 is decided before any verification or limiter change, so it neither costs scrypt work nor counts. Counting the dummy hash as a verification makes the bound total, as the request asks ("total password-verification work"), and keeps unknown and registered usernames indistinguishable by queueing behaviour. Retry-After is a constant 1 second because the queue drains in a few scrypt durations and the value must not depend on the username. Releasing the slot in finally keeps a rejected verification from shrinking capacity. Not dropping queued work on client disconnect keeps the gate simple; that work is bounded by maxQueued.

status:

> active

#### decisions 11

id:

> DEC-011

decision:

> src/users.js gains, additively, an exported hashPasswordAsync(password, salt) that returns a Promise resolving to the same Buffer as hashPassword(password, salt), computed with crypto.scrypt(password, salt, KEY\_LENGTH) (Node defaults, as scryptSync), and a store method verifyAsync(username, password) that resolves false at once for an unknown user or a non-string password and otherwise resolves crypto.timingSafeEqual(await hashPasswordAsync(password, user.salt), user.hash). The existing createUserStore, has, usernames, verify and hashPassword are unchanged. The login handler uses only verifyAsync and hashPasswordAsync.

rationale:

> users.verify runs crypto.scryptSync on the event loop, so with it at most one verification could ever be running and the 4-running/16-waiting bound of the request would never engage, while every attempt blocked all other requests. crypto.scrypt runs the same computation on the libuv threadpool (4 threads by default), so the gate bounds real concurrent work and the server stays responsive. The salts and hashes are private to the store closure, so the asynchronous path has to live in src/users.js; keeping the scheme and the existing exports unchanged honours NG-004 and keeps test/users.test.js valid.

status:

> active

#### decisions 12

id:

> DEC-012

decision:

> Every runtime proof command and the unit command run node --test with --test-timeout=20000 and --test-force-exit, so a test that waits on a response or a verification that never settles fails after 20 seconds and the process exits nonzero instead of running until the proof timeout.

rationale:

> Under an isolated mutation such as removing the queue bound, a request can stay parked forever; the test then fails its assertion but its finally block waits for that response, so a plain node --test never exits and the run ends only at the 120 s proof timeout, which proves nothing. The bounded flags keep each unmutated proof unchanged (it finishes in about a second) and turn such a hang into a plain test failure.

status:

> active

### invariants

#### invariants 1

id:

> INV-001

statement:

> No password and no issued token is ever written to stdout, stderr or any console method, and no response other than the 200 success body contains a token.

status:

> active

#### invariants 2

id:

> INV-002

statement:

> For any username, the 401 response to a wrong password and the 401 response to an unknown user have the same status, the same content-type and byte-identical bodies.

status:

> active

#### invariants 3

id:

> INV-003

statement:

> While a username is locked (5 counted failures within the last 60 seconds, or counted failures plus attempts in verification reaching 5), no request for it reaches users.verifyAsync or hashPasswordAsync.

status:

> active

#### invariants 4

id:

> INV-004

statement:

> Memory is bounded: a request body is buffered up to 4096 bytes, the limiter tracks at most 10000 usernames, the session store holds at most 10000 tokens, and the verification gate holds at most 16 waiting requests and runs at most 4 scrypt computations (about 16 MiB each at Node's defaults N=16384, r=8).

status:

> active

#### invariants 5

id:

> INV-005

statement:

> GET /health and the 404 response for unknown routes behave exactly as before the feature.

status:

> active

#### invariants 6

id:

> INV-006

statement:

> Per server instance, at most 4 password verifications (users.verifyAsync or the dummy hashPasswordAsync) are in progress and at most 16 login requests wait for one at any time; a request that finds both full is answered 503 without any verification and without changing its username's failure record, and every finished or rejected verification frees its slot.

status:

> active

### security

data_exposure:

> POST /login is unauthenticated and reachable by anyone who can reach the server; that is its purpose. It returns only: on success the token for the user whose credentials were presented ({"token"} and nothing else, no user data); otherwise one of the fixed bodies of DEC-005, none of which echo input. The 401 body is identical for unknown users and wrong passwords, the 503 refusal carries that same body and a constant retry-after: 1 and is decided before the username is looked up, the limiter applies to registered and unknown usernames alike, and an unknown username's dummy hash takes a gate slot like a real verification, so neither the body, the 401/429/503 status nor the Retry-After header tells a caller whether a username exists. The token is a bearer secret returned only in the 200 body to the requester; the server keeps token -\> username only in the in-memory session store, which no endpoint exposes (GET /health still returns only the user count). Passwords are never stored (users.js keeps salted scrypt hashes; verifyAsync only compares) and neither passwords nor tokens are logged (INV-001). Authorization scope: a token grants nothing yet (NG-001).

input_validation:

> The only new external input is the POST /login request body. Body: at most 4096 bytes, else 413 and buffering stops (DEC-009). It must parse as JSON into a plain object (not an array or null), else 400. username: required, typeof string, length 1..64 characters, else 400. password: required, typeof string, length 1..1024 characters, else 400. Extra fields are ignored. The username is used only as a Map key and as the users.has/verifyAsync argument; it is never interpolated into output. Invalid requests are rejected before the limiter, before the gate and before any hashing, and do not count as failures. No header, query parameter or cookie is read. The new createServer options (sessions, now, gate) and the createVerificationGate/createFailureLimiter options are code-level configuration set by the process that creates the server, not request input.

resource_consumption:

> The expensive operation is scrypt (users.verifyAsync, or hashPasswordAsync with the dummy salt for unknown users), run once per well-formed, non-locked, admitted attempt on the libuv threadpool via crypto.scrypt, so it no longer blocks the event loop. Server-side bounds: the verification gate (DEC-010) lets at most 4 verifications run and at most 16 requests wait per server, and answers any further login request 503 at once without hashing; the per-username limiter allows at most 5 failed verifications per username in any 60-second span, counting attempts in flight (locked attempts skip hashing, INV-003; a successful verification requires the correct password and does not reset the count); each limiter record holds at most 5 timestamps and a pending count of at most 4; the password is capped at 1024 characters and the body at 4096 bytes; the limiter Map is capped at 10000 tracked usernames (expired, idle records pruned first, then the oldest record evicted), the session Map at 10000 tokens (oldest evicted), and the gate queue at 16 entries, each holding one parsed body of at most 4096 bytes. There is no per-IP or rate-based global limit on attempts (RISK-001).

#### accepted_risks

##### accepted_risks 1

id:

> RISK-001

statement:

> An attacker rotating usernames is not rate limited per client: total verification work is capped at 4 running and 16 waiting (DEC-010), so the server stays responsive, but a sustained flood keeps the gate full and legitimate logins then get 503 until it subsides; a queued request whose client disconnected still runs its verification. No per-IP or rate-based limit is added (NG-003). Accepted because the service is a local toy with an in-memory fake user store of synthetic users, and the request defines only the per-username failure limit and the concurrency bound. Premise source: README.md ("A tiny dependency-free Node HTTP service used to exercise the gated pipeline", "a local in-memory fake user store" of synthetic users); the repo has no threat-model or accepted-risk document (.claude/pipeline.yaml security.docs is \[\]).

cites 1:

> NG-003

cites 2:

> DEC-003

cites 3:

> DEC-010

cites 4:

> SRC-004

cites 5:

> SRC-007

status:

> active

##### accepted_risks 2

id:

> RISK-002

statement:

> Flooding more than 10000 distinct usernames inside one window evicts the oldest limiter records, which can end a lockout early. Accepted as the price of a hard memory bound on a local toy service (README.md; no repo security docs exist).

cites 1:

> DEC-003

cites 2:

> INV-004

status:

> active

##### accepted_risks 3

id:

> RISK-003

statement:

> Anyone can lock a known username (for example alice) out by sending 5 wrong passwords; the lock lasts until the oldest of those failures is 60 seconds old, and an attacker who sends one more wrong password each time it lifts keeps the username locked. This is inherent in the requested per-username rule (SRC-004); the repo has no security docs that would require otherwise.

cites 1:

> SRC-004

cites 2:

> DEC-003

status:

> active

##### accepted_risks 4

id:

> RISK-004

statement:

> The dummy scrypt for unknown users (DEC-004) removes the gross timing difference but residual timing differences between the unknown-user and wrong-password paths (one Map lookup, timingSafeEqual) remain measurable in principle; src/users.js verifyAsync, like verify, resolves false before hashing for a missing user, and changing that behaviour is out of scope (NG-004).

cites 1:

> DEC-004

cites 2:

> INV-002

status:

> active

##### accepted_risks 5

id:

> RISK-005

statement:

> Tokens never expire and are lost on restart or evicted at the 10000-session cap; since no endpoint accepts them yet (NG-001) this has no authorization effect; the store is in-memory by design (README.md).

cites 1:

> NG-001

cites 2:

> DEC-002

status:

> active

##### accepted_risks 6

id:

> RISK-006

statement:

> Because attempts in verification count toward the lock (DEC-003), a correct-password attempt can get 429 with Retry-After 1 while counted failures plus in-flight attempts for its username reach 5, even if some of those in-flight attempts would succeed. This only happens when attempts for one username overlap (at most 4 can be in verification) and lasts about one scrypt duration; it is the price of keeping concurrent guesses within the requested 5 failures per 60 seconds (SRC-004). The repo has no security docs that would require otherwise (README.md: local toy service).

cites 1:

> DEC-003

cites 2:

> SRC-004

cites 3:

> INV-003

status:

> active

## requirements

### requirements 1

id:

> LOGIN-001

status:

> active

goal_ids 1:

> GOAL-001

statement:

> POST /login with a JSON body {username, password} holding a registered user's correct password returns 200 with content-type application/json and body {"token": \<43-character base64url string from 32 random bytes\>}; each successful login issues a new distinct token, and the session store passed as options.sessions maps that token to the username. The session store holds at most 10000 tokens (MAX\_TRACKED): issuing a token when it holds 10000 first evicts the oldest-issued token (INV-004, DEC-002).

priority:

> P0

depends_on: none

#### acceptance

##### acceptance 1

id:

> LOGIN-001-AC1

status:

> active

given:

> a server from createServer({ users: createUserStore(USERS), sessions }) listening via listen(), with the fixture users alice and bob

when:

> the client POSTs {"username":"alice","password":"alice-synthetic-pw-1"} to /login twice

then:

> both responses are 200 with content-type application/json, each body has exactly the key token matching /^\[A-Za-z0-9\_-\]{43}$/, and the two tokens differ

###### verification

kind:

> runtime

##### acceptance 2

id:

> LOGIN-001-AC2

status:

> active

given:

> the same server with an injected session store

when:

> alice and then bob log in with their correct passwords

then:

> sessions.usernameFor(aliceToken) is "alice", sessions.usernameFor(bobToken) is "bob", and sessions.usernameFor of an unissued 43-character string is null

###### verification

kind:

> runtime

##### acceptance 3

id:

> LOGIN-001-AC3

status:

> active

given:

> a session store from createSessionStore() imported from src/login.js

when:

> the test calls issue("alice") 10001 times, keeping every returned token

then:

> size() is 10000, usernameFor(first token) is null, and usernameFor of the second and of the last token is "alice"

###### verification

kind:

> runtime

### requirements 2

id:

> LOGIN-002

status:

> active

goal_ids 1:

> GOAL-002

statement:

> POST /login with a wrong password for a registered user, or with any password for an unknown username, returns 401 with content-type application/json and the identical body {"error": "invalid credentials"}, and issues no token.

priority:

> P0

depends_on 1:

> LOGIN-001

#### acceptance

##### acceptance 1

id:

> LOGIN-002-AC1

status:

> active

given:

> a server with the fixture users and an injected session store

when:

> the client POSTs alice with password "wrong-password" and then carol (unknown) with password "alice-synthetic-pw-1"

then:

> both responses are 401 with content-type application/json, their raw body texts are byte-identical and equal to {"error":"invalid credentials"}

###### verification

kind:

> runtime

##### acceptance 2

id:

> LOGIN-002-AC2

status:

> active

given:

> the same server

when:

> the client POSTs alice with password "wrong-password"

then:

> the status is 401, the body has no token key, and sessions.size() is still 0

###### verification

kind:

> runtime

### requirements 3

id:

> LOGIN-003

status:

> active

goal_ids 1:

> GOAL-003

statement:

> Per exact username (registered or unknown), once 5 failed (401) attempts have been counted within the last 60 seconds, or counted failures plus attempts for that username currently in verification reach 5, every further attempt for that username, even with the correct password, returns 429 {"error": "too many attempts"} with a Retry-After header in whole seconds, without verifying the password (no users.verifyAsync or hashPasswordAsync call) and without counting; the lock is tested on arrival and again when a queued attempt gets its verification slot. As soon as the oldest of those 5 failures is 60 seconds old, attempts for that username are processed normally again (sliding window, DEC-003), so no 60-second span holds more than 5 401 responses for one username, even under concurrent requests. Other usernames are unaffected, and a successful login does not reset the username's failure count. The limiter tracks at most 10000 usernames (MAX\_TRACKED): adding a new username when 10000 are tracked first prunes expired, idle records and then evicts the earliest-created record, so it never tracks more than 10000 (INV-004; eviction can end a lockout early, RISK-002).

priority:

> P0

depends_on 1:

> LOGIN-002

#### acceptance

##### acceptance 1

id:

> LOGIN-003-AC1

status:

> active

given:

> a server created with an injected clock now() fixed at a start time

when:

> the client sends 5 wrong passwords for alice, then a 6th attempt with alice's correct password at the same clock time

then:

> attempts 1 to 5 return 401, the 6th returns 429 with body {"error":"too many attempts"} and a Retry-After header of "60"

###### verification

kind:

> runtime

##### acceptance 2

id:

> LOGIN-003-AC2

status:

> active

given:

> alice locked after 5 failures at clock time t0

when:

> the clock is advanced to t0 + 59999 ms and alice logs in correctly, then advanced to t0 + 60000 ms and alice logs in correctly

then:

> the attempt at t0 + 59999 ms returns 429 and the attempt at t0 + 60000 ms returns 200 with a token

###### verification

kind:

> runtime

##### acceptance 3

id:

> LOGIN-003-AC3

status:

> active

given:

> alice locked after 5 failures

when:

> bob logs in with his correct password at the same clock time

then:

> bob gets 200 with a token

###### verification

kind:

> runtime

##### acceptance 4

id:

> LOGIN-003-AC4

status:

> active

given:

> a fresh server with the injected clock

when:

> the client sends 5 attempts for the unknown username carol, then a 6th

then:

> attempts 1 to 5 return 401 and the 6th returns 429, exactly as for a registered username

###### verification

kind:

> runtime

##### acceptance 5

id:

> LOGIN-003-AC5

status:

> active

given:

> a fresh server with the injected clock fixed at t0, and alice with 4 failures at t0

when:

> alice logs in correctly, then sends 1 more wrong password, then logs in correctly again, all at t0

then:

> the first correct login returns 200, the wrong attempt returns 401 (the 5th counted failure, because the success did not reset the count), and the final correct login returns 429

###### verification

kind:

> runtime

##### acceptance 6

id:

> LOGIN-003-AC6

status:

> active

given:

> a fresh server with the injected clock

when:

> the client sends 1 wrong password for alice at t0, 4 wrong passwords at t0 + 30000 ms and a 6th attempt at t0 + 30000 ms, then at t0 + 60000 ms one wrong password followed by another attempt

then:

> the 5 wrong attempts up to t0 + 30000 ms return 401 and the 6th returns 429 with Retry-After "30"; at t0 + 60000 ms the wrong password returns 401 (the t0 failure has aged out) and the next attempt returns 429 with Retry-After "30" (4 failures from t0 + 30000 ms plus the new one), so no 60-second span holds more than 5 401 responses

###### verification

kind:

> runtime

##### acceptance 7

id:

> LOGIN-003-AC7

status:

> active

given:

> test/login-ratelimit.test.js replaces the hashPasswordAsync export of src/users.js with a wrapper that counts calls and forwards to the original before it first requires src/server.js, and creates a server with an injected clock and options.users set to an object whose has and usernames forward to createUserStore(USERS) and whose verifyAsync counts calls and forwards to that store's verifyAsync

when:

> the client sends 5 wrong passwords for alice and 5 attempts for the unknown username carol at t0, the test records both counters, and then sends alice's correct password and one more attempt for carol at t0

then:

> during the 10 locking attempts the verifyAsync counter rose by 5 and the hashPasswordAsync counter rose by at least 5 (the spies are wired), both final attempts return 429, and neither counter changed during them

###### verification

kind:

> runtime

##### acceptance 8

id:

> LOGIN-003-AC8

status:

> active

given:

> a limiter from createFailureLimiter({ now }) with its default options (MAX\_TRACKED = 10000) and an injected clock fixed at t0

when:

> the test calls recordFailure("victim") 5 times, then recordFailure for 9999 distinct usernames "u0" to "u9998", then recordFailure("u9999"), then advances the clock to t0 + 60000 ms and calls recordFailure("late")

then:

> the exported MAX\_TRACKED is 10000; after the 5 victim failures check("victim").locked is true; after "u9998" size() is 10000 and victim is still locked; after "u9999" size() is 10000 and check("victim").locked is false (the earliest record was evicted); after "late" size() is 1 (expired records pruned before eviction)

###### verification

kind:

> runtime

##### acceptance 9

id:

> LOGIN-003-AC9

status:

> active

given:

> a server created with an injected clock fixed at t0, an injected gate from createVerificationGate() and options.users set to an object whose has returns true for alice and whose verifyAsync counts calls and returns a promise the test settles

when:

> the client sends 8 concurrent POST /login requests for alice with wrong passwords, the test waits until gate.active() is 4 and gate.queued() is 4, then settles every pending and every later verifyAsync promise with false, and collects all 8 responses

then:

> verifyAsync was called exactly 5 times, exactly 5 responses are 401 and the other 3 are 429 with body {"error":"too many attempts"}, and a further attempt for alice at t0 returns 429

###### verification

kind:

> runtime

##### acceptance 10

id:

> LOGIN-003-AC10

status:

> active

given:

> a limiter from createFailureLimiter({ now }) with its default options (MAX\_TRACKED = 10000) and an injected clock fixed at t0

when:

> the test calls begin("victim") followed by end("victim", true) 5 times, then begin() for 9999 distinct usernames "u0" to "u9998" (leaving each of them with 1 pending attempt and no end() call), then begin("u9999")

then:

> each begin() for "u0" to "u9999" returns locked false; after the 5 victim attempts check("victim").locked is true and size() is 1; after "u9998" size() is 10000 and victim is still locked; after "u9999" size() is 10000 and check("victim").locked is false (no record was prunable, since victim holds unexpired timestamps and every other record a pending attempt, so the earliest-created record, victim, was evicted)

###### verification

kind:

> runtime

### requirements 4

id:

> LOGIN-004

status:

> active

goal_ids 1:

> GOAL-004

statement:

> No password submitted to POST /login and no issued token is ever written to stdout, stderr or any console method, on success, 401, 429, 503, 400 or 413 paths.

priority:

> P0

depends_on 1:

> LOGIN-001

depends_on 2:

> LOGIN-002

depends_on 3:

> LOGIN-003

depends_on 4:

> LOGIN-007

#### acceptance

##### acceptance 1

id:

> LOGIN-004-AC1

status:

> active

given:

> a server with the fixture users, with console.log, console.info, console.warn, console.error and console.debug and process.stdout.write and process.stderr.write wrapped to record every argument (and still forward to the original) for the duration of the test

when:

> the client performs a successful login for alice, a wrong-password login, an unknown-user login, enough failures to reach a 429, a malformed (invalid JSON) request containing a password string, and a login against a second server whose injected gate is createVerificationGate({ maxActive: 0, maxQueued: 0 }) so that it answers 503

then:

> no recorded output contains any submitted password string or the issued token

###### verification

kind:

> runtime

##### acceptance 2

id:

> LOGIN-004-AC2

status:

> active

given:

> the same recording setup

when:

> alice logs in successfully

then:

> no recorded output contains the token from the 200 body

###### verification

kind:

> runtime

### requirements 5

id:

> LOGIN-005

status:

> active

goal_ids 1:

> GOAL-001

goal_ids 2:

> GOAL-003

statement:

> POST /login rejects a body over 4096 bytes with 413 {"error": "payload too large"}, and rejects invalid JSON, a non-object, or a username or password that is missing, not a string, empty, or longer than 64 (username) or 1024 (password) characters with 400 {"error": "invalid request"}; rejected requests never count as failed attempts and never take a verification slot.

priority:

> P1

depends_on 1:

> LOGIN-003

#### acceptance

##### acceptance 1

id:

> LOGIN-005-AC1

status:

> active

given:

> a server with the fixture users

when:

> the client POSTs invalid JSON, \[\] , {"username":"alice"}, {"username":1,"password":"x"}, {"username":"","password":"x"}, a 65-character username, and a 1025-character password

then:

> every response is 400 with body {"error":"invalid request"}

###### verification

kind:

> runtime

##### acceptance 2

id:

> LOGIN-005-AC2

status:

> active

given:

> a server with the fixture users

when:

> the client POSTs a 5000-byte body to /login

then:

> the response is 413 with body {"error":"payload too large"}

###### verification

kind:

> runtime

##### acceptance 3

id:

> LOGIN-005-AC3

status:

> active

given:

> a server with an injected clock

when:

> the client sends 6 malformed requests (400) naming alice, then alice logs in correctly

then:

> the correct login returns 200, because invalid requests are not counted as failures

###### verification

kind:

> runtime

### requirements 6

id:

> LOGIN-006

status:

> active

goal_ids 1:

> GOAL-005

statement:

> The login behaviour is pinned by the six focused test files test/login-success.test.js, test/login-failure.test.js, test/login-ratelimit.test.js, test/login-validation.test.js, test/login-logging.test.js and test/login-concurrency.test.js, which npm test runs through its "test/\*\*/\*.test.js" glob, and the existing GET /health, 404 and user-store tests keep passing; a non-POST request to /login returns the existing 404 {"error": "not found"}.

priority:

> P1

depends_on 1:

> LOGIN-001

#### acceptance

##### acceptance 1

id:

> LOGIN-006-AC1

status:

> active

given:

> the feature implemented

when:

> the existing tests test/health.test.js and test/users.test.js run

then:

> all of them pass unchanged

###### verification

kind:

> runtime

##### acceptance 2

id:

> LOGIN-006-AC2

status:

> active

given:

> the feature implemented

when:

> the client sends GET /login

then:

> the response is 404 with body {"error":"not found"}

###### verification

kind:

> runtime

##### acceptance 3

id:

> LOGIN-006-AC3

status:

> active

given:

> the feature implemented

when:

> the test directory is inspected

then:

> the six focused login test files exist under test/ and match the npm test glob test/\*\*/\*.test.js

###### verification

kind:

> static

### requirements 7

id:

> LOGIN-007

status:

> active

goal_ids 1:

> GOAL-006

statement:

> Password verification for POST /login runs asynchronously (users.verifyAsync, or hashPasswordAsync with the dummy salt for an unknown username, both computing the same scrypt as the synchronous functions, DEC-011) and only inside the per-server verification gate (DEC-010): at most 4 verifications run at the same time and at most 16 further well-formed, non-locked requests wait in FIFO order. A request that finds 4 running and 16 waiting gets, without any verification, 503 with content-type application/json, a retry-after: 1 header and the body {"error":"invalid credentials"} byte-identical to the 401 body, and does not count as a failed attempt for its username. A slot is freed when its verification resolves or rejects and the oldest waiting request then starts; a rejected verification answers 500 {"error": "internal error"} and does not count.

priority:

> P0

depends_on 1:

> LOGIN-002

depends_on 2:

> LOGIN-003

#### acceptance

##### acceptance 1

id:

> LOGIN-007-AC1

status:

> active

given:

> a server from createServer({ users: spy, sessions, gate }) with gate = createVerificationGate() (4 active, 16 queued) and spy an object whose has returns true for alice and for u01 to u40, whose usernames lists them, and whose verifyAsync counts calls, tracks the maximum number of its promises pending at once and returns a promise the test settles

when:

> the client sends POST /login requests for u01 to u20 in that order, starting each only after the previous one shows in gate.active() + gate.queued(), so that gate.active() is 4 and gate.queued() is 16, and then sends a request for u21 and waits at most 2 seconds for its response

then:

> verifyAsync was called 4 times; the u21 response arrives within 2 seconds with status 503, content-type application/json, retry-after "1" and the raw body {"error":"invalid credentials"}; afterwards verifyAsync has still been called 4 times and gate.queued() is still 16; once all pending verifications are settled with false, every u01 to u20 response is 401 with a raw body byte-identical to the 503 body

###### verification

kind:

> runtime

##### acceptance 2

id:

> LOGIN-007-AC2

status:

> active

given:

> a server from createServer({ users: spy, sessions, gate }) with gate = createVerificationGate() (4 active, 16 queued) and spy an object whose has returns true for alice and for u01 to u40, whose usernames lists them, and whose verifyAsync counts calls, tracks the maximum number of its promises pending at once and returns a promise the test settles

when:

> the client sends requests for u01 to u20 in that order, starting each only after the previous one shows in gate.active() + gate.queued(), until gate.active() is 4 and gate.queued() is 16, then settles the verification for u01 with false, waits until verifyAsync has been called 5 times, and then settles every pending and later verification with true

then:

> the maximum number of verifyAsync promises pending at once was 4; the 5th verifyAsync call is for u05 (FIFO); after the u01 settlement gate.active() is 4 and gate.queued() is 15; u01 gets 401 and u02 to u20 get 200 with a token

###### verification

kind:

> runtime

##### acceptance 3

id:

> LOGIN-007-AC3

status:

> active

given:

> a server from createServer({ users: spy, sessions, gate }) with gate = createVerificationGate() (4 active, 16 queued) and spy an object whose has returns true for alice and for u01 to u40, whose usernames lists them, and whose verifyAsync counts calls, tracks the maximum number of its promises pending at once and returns a promise the test settles, and an injected clock fixed at t0

when:

> the client fills the gate with 20 concurrent requests for u01 to u20, then sends 6 sequential wrong-password requests for alice that all receive responses, then the test settles every pending verification with false, and alice logs in with a password whose verification the test settles with true

then:

> all 6 alice requests during the full gate return 503 and verifyAsync was never called for alice during them; the final alice login returns 200 with a token, because the 503 refusals were not counted as failed attempts

###### verification

kind:

> runtime

##### acceptance 4

id:

> LOGIN-007-AC4

status:

> active

given:

> test/login-concurrency.test.js replaces, for the duration of this test only (restored in finally), the hashPasswordAsync export of src/users.js with a wrapper that counts calls and returns a promise the test settles, and a server from createServer({ users: createUserStore(USERS), gate }) with gate = createVerificationGate()

when:

> the client sends 4 concurrent requests for the unknown usernames ghost1 to ghost4, the test waits until the hashPasswordAsync counter is 4, then sends alice's correct password and waits until gate.queued() is 1, and finally settles the 4 dummy hashes

then:

> while the dummy hashes are pending gate.active() is 4, gate.queued() is 1 and alice has no response; after they settle the ghost requests return 401 and alice returns 200 with a token

###### verification

kind:

> runtime

##### acceptance 5

id:

> LOGIN-007-AC5

status:

> active

given:

> a server from createServer({ users: spy, sessions, gate }) with gate = createVerificationGate() (4 active, 16 queued) and spy an object whose has returns true for alice and for u01 to u40, whose usernames lists them, and whose verifyAsync counts calls, tracks the maximum number of its promises pending at once and returns a promise the test settles

when:

> the client sends 4 concurrent requests for u01 to u04 whose verifyAsync promises the test rejects with an Error, then sends 4 concurrent requests for u05 to u08 and waits until gate.active() is 4

then:

> u01 to u04 return 500 with body {"error":"internal error"}; after they settle gate.active() reaches 0 before the second batch, verifyAsync is called for each of u05 to u08 (the slots were freed), and after settling those with true they return 200

###### verification

kind:

> runtime

##### acceptance 6

id:

> LOGIN-007-AC6

status:

> active

given:

> a store from createUserStore(USERS) and the exported hashPassword and hashPasswordAsync of src/users.js

when:

> the test awaits verifyAsync for alice with her password, alice with bob's password, carol with alice's password and alice with a non-string password, and compares await hashPasswordAsync("pw", salt) with hashPassword("pw", salt) for a random 16-byte salt

then:

> verifyAsync returns a Promise each time and resolves true, false, false and false respectively, and the two hashes are equal 32-byte Buffers

###### verification

kind:

> runtime
