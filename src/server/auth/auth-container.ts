import { createDatabase } from "../db/client";
import { migrateDatabase } from "../db/migrate";
import { loadServerEnv } from "../config/env";
import { loadAuthConfig } from "./auth-config";
import { AuthService } from "./auth-service";

let service: AuthService | undefined;
export function getAuthService(): AuthService {
  if (!service) {
    loadAuthConfig();
    const db = createDatabase(loadServerEnv().databasePath);
    try { migrateDatabase(db); service = new AuthService({ database: db }); }
    catch (error) { db.$client.close(); throw error; }
  }
  return service;
}
