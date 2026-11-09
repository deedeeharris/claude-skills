# Login lockout

## Approach
Count failed logins per account in memory.

## Acceptance
- AUTH-001-AC1: a valid login succeeds. Proof: `node --test test/login.test.js`
- AUTH-001-AC2: five failed logins lock the account. Proof: `node --test test/lockout.test.js`
- AUTH-002-AC1: the lockout limit is a named constant (static evidence in src/limits.js).

## Files to change
src/login.js, src/limits.js, test/login.test.js, test/lockout.test.js

## Invariants
A locked account never logs in.

## Test plan
Write the lockout test first and watch it fail.

## Security considerations
No new data leaves the service; the counter is bounded by the account count.
