/** Run explicitly with DATABASE_URL / BETTER_AUTH_* already supplied via the environment. */
import { ensureFamilySchema } from "../../app/family/server/schema";
import { closeFamilyDatabase } from "../../app/family/server/db";

async function main() {
  await ensureFamilySchema();
  console.log("Family database schema is ready. No account was created.");
}
main()
  .catch(() => {
    console.error(
      "Family migration failed. Check database access and required environment configuration.",
    );
    process.exitCode = 1;
  })
  .finally(closeFamilyDatabase);
