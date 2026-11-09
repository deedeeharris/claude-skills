# Billing

## Acceptance
- AUTH-001-AC1: a login works. Proof: `node --test test/auth.test.js`
- BILL-002-AC1: an invoice totals its lines. Proof: `node --test test/bill.test.js`
- AUTH-001: a login is audited. Proof: `node --test test/audit.test.js`
- MIG-001-AC1: the invoice format is documented in src/invoice.js.
- legacy-check: the old export still runs. Proof: `node --test test/legacy.test.js`
- AUTH-001-AC2: a logout works. Proof: `node --test test/logout.test.js`
