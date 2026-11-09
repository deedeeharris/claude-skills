# Login lockout

## Problem
An attacker can guess passwords without limit.

## Users
Account holders.

## Goals
Lock an account after five failed logins.

## Non-goals
No CAPTCHA.

## Constraints
No new dependency.

## Risks
One user can lock out another user.

## Success criteria
Five failed logins lock the account.
