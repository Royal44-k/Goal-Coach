import { setupIsolatedApp } from "../e2e/global-setup";
import { AuthService } from "../src/server/auth/auth-service";
import { randomUUID } from "node:crypto";

export default async function globalSetup() {
  return setupIsolatedApp({
    mode: "invite",
    initialize(database) {
      // Only the guarded temporary database created by setupIsolatedApp is passed here.
      // Keep the one-use synthetic bootstrap token in memory, never screenshots/logs.
      process.env.GOAL_COACH_E2E_ADMIN_INVITE = new AuthService({ database }).bootstrapAdminInvite().token;
      process.env.GOAL_COACH_E2E_ADMIN_PASSWORD = `Synthetic-${randomUUID()}`;
    },
  });
}
