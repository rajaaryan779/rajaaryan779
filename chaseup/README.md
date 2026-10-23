# ChaseUp

Invoice tracking and payment-reminder drafting for freelancers and small businesses.
Answers one question: **who owes me money, and what do I say to them today?**

## What the MVP does

- Sign up / sign in (scrypt password hashing, HttpOnly session cookie, login throttling)
- Clients and invoices (amounts stored as integer minor units)
- Dashboard: outstanding, overdue, collected this month, and a "chase these first" list
- Reminder drafts whose tone escalates with days overdue (friendly → firm → final)
- Optional AI polish: set `ANTHROPIC_API_KEY` and drafts are rewritten by Claude; any failure falls back to the template
- Reminders are opened in the user's own email app (`mailto:`) and logged; ChaseUp does not send email itself
- Strict per-user data isolation (covered by tests)

## Run it

Requires Node >= 22.13 (uses the built-in `node:sqlite`; no npm dependencies).

```
npm start          # http://localhost:3000
npm test
```

Env vars: `PORT`, `DB_PATH` (default `chaseup.db`), `ANTHROPIC_API_KEY` (optional), `CHASEUP_MODEL` (optional), `NODE_ENV=production` (adds the `Secure` cookie flag; serve behind HTTPS).

## Known gaps before real customers

- No payments, no automatic sending, no email verification or password reset
- `node:sqlite` is still flagged experimental in Node 22; single-process only
- Login throttling is in-memory per IP; no CSRF token (relies on SameSite=Lax + JSON-only writes)
- No invoice editing, no multi-currency per invoice, no audit log
