import { AppError } from "@/core/errors/app-error";
import { loadAuthConfig } from "../auth/auth-config";

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function assertLocalMutationOrigin(request: Request): void {
  if (!MUTATION_METHODS.has(request.method.toUpperCase())) return;
  if (request.headers.get("origin") !== loadAuthConfig().origin) {
    throw new AppError("ORIGIN_REJECTED", 403, "Rejected non-canonical mutation origin");
  }
}
