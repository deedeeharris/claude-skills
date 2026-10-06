# Delivery Router Spec

## Work item A: Email channel adapter

Owns: `email-adapter.ts`, `delivery-router.ts`.

Implements the email sending path and registers it with the delivery router.

Done when: `npm test -- email-adapter.spec.ts` passes and every test asserts a sent
message or a reported failure, not just that the function returns.

This item can be built in parallel with work item B; neither depends on the other's
output during development.

## Work item B: In-app channel adapter

Owns: `in-app-adapter.ts`, `delivery-router.ts`.

Implements the in-app notification path and registers it with the delivery router.

Done when: `npm test -- in-app-adapter.spec.ts` passes and every test asserts a stored
notification row, not just that the function returns.

This item can be built in parallel with work item A; neither depends on the other's
output during development.

## Work item C: Delivery outcome logging

Owns: `delivery-log.ts`.

Records the timestamp, channel, and outcome for every send attempt made by either
adapter, retained for 90 days per PRD R4.

Done when: `npm test -- delivery-log.spec.ts` passes and confirms a row is written for
both a successful and a failed delivery attempt.

## Cut list

1. In-app read receipts.
2. Delivery retries beyond the first attempt.
