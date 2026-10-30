import { Client } from "pg";
import { verifiedPostgresConnectionString } from "../../app/family/server/db";

let passed = 0;
function check(ok: unknown, label: string) {
  if (!ok) throw new Error(`FAIL ${label}`);
  passed++;
  console.log(`PASS ${label}`);
}
for (const suffix of [
  "?sslmode=require&uselibpqcompat=true",
  "?sslmode=no-verify",
  "?channel_binding=require",
  "",
]) {
  const normalized = verifiedPostgresConnectionString(
    `postgresql://fixture:fixture@database.test.invalid/fixture${suffix}`,
  );
  const parsed = new URL(normalized);
  check(
    parsed.searchParams.get("sslmode") === "verify-full" &&
      !parsed.searchParams.has("uselibpqcompat"),
    "database configuration pins verify-full and removes compatibility downgrade",
  );
  const client = new Client({ connectionString: normalized });
  const ssl = (
    client as unknown as {
      connectionParameters: {
        ssl:
          | false
          | { rejectUnauthorized?: boolean; checkServerIdentity?: unknown };
      };
    }
  ).connectionParameters.ssl;
  check(
    ssl !== false &&
      ssl.rejectUnauthorized !== false &&
      ssl.checkServerIdentity === undefined,
    "pg keeps certificate verification and standard hostname identity checks",
  );
  // Constructing Client parses configuration only. No connect() or network request.
}
let rejected = false;
try {
  verifiedPostgresConnectionString("https://fixture.test.invalid/");
} catch {
  rejected = true;
}
check(rejected, "non-PostgreSQL destination is rejected");
console.log(
  `Family TLS configuration: ${passed} synthetic checks passed. No real environment or connection read.`,
);
