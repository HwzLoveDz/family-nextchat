# Family deployment

This fork serves the family app in production. Production cannot fall back to the
legacy shared access code, provider proxy, remote sync, artifact or MCP routes.
The public page shows a login form; private chat and administrator APIs require an
approved account. A single-use invitation creates a pending account, which an
administrator must approve before it can log in.

The registration and account screens disclose that administrators can inspect
accounts, prompts, replies, reported token usage and estimated foreground active
time. This is account isolation between family members, with administrator access.
Archiving hides a conversation from its member while retaining it for the admin.

## Server configuration

Use Vercel's sensitive environment variables for secrets. Never commit an env file.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Neon PostgreSQL connection, server only; certificate and hostname verification are enforced |
| `BETTER_AUTH_SECRET` | Random authentication secret, at least 32 characters |
| `BETTER_AUTH_URL` | Exact HTTPS production origin; leave unset for Preview so it uses the deployment's `VERCEL_URL` |
| `FAMILY_BOOTSTRAP_TOKEN` | Random, owner-only initialization token, at least 32 characters |
| `OPENAI_API_KEY` | Server-only model key; a missing key fails closed without creating messages |
| `FAMILY_OPENAI_MODEL` | Optional model name, subject to account availability |
| `FAMILY_MODE` | `1` for local development; production is always family mode |

Keep the database and functions in the same region. This project selects Singapore.
Use a separate Neon branch for Preview and verify that branch before fixture setup.
An origin check is not database isolation. Never run fixture initialization on the
production database, even if it has not yet been initialized.

## Owner initialization

Open the production HTTPS origin. Initialization requires the owner-only bootstrap
token and an explicit administrator name, email and password. The owner should
enter the password privately. Setup runs the official Better Auth migrations and
the family schema, then permanently rejects further bootstrap attempts.

After signing in, create an invitation in the admin page, send it privately to the
intended family member, then approve the pending account. Each invitation can be
used once. Disable a member to revoke its sessions immediately. Passwords and
provider keys are never returned by administrative account APIs.

Login cookies are host-only, Secure, HttpOnly and SameSite=Lax in production. The
30-day session rolls forward on use. Private API responses and pages disable
caching; the family UI does not persist conversations in browser storage or use
the legacy service worker cache.

## Verification

Offline checks:

```text
node node_modules/typescript/bin/tsc --noEmit
node --no-warnings --experimental-vm-modules node_modules/jest/bin/jest.js --ci --runInBand
node --conditions=react-server --import tsx scripts/family/stream-test.ts
node --conditions=react-server --import tsx scripts/family/tls-test.ts
```

The isolated PostgreSQL runner requires `FAMILY_TEST_DATABASE_URL` and a dedicated
test database. It creates a random, validated `family_test_` schema and drops only
that schema in its finally block. Do not supply the production database.

`scripts/family/http-integration.mjs` requires an explicitly confirmed empty
Preview database, the unique deployment URL, and a bootstrap token supplied via
environment variables. It refuses production markers and unexpected destinations.
It creates test-only fixture accounts and verifies invitation races, approval,
authorization, cross-account access denial, session revocation and archiving.
Its missing-key checks require that no model key be supplied to that Preview.

Offline tests do not prove real database transactions, mobile browser behavior,
provider billing or mainland connectivity. Confirm those separately against the
actual deployment, and record failed and unresponsive monitor nodes separately.
