import { createHash, randomBytes, randomUUID } from "node:crypto";
import { AppError } from "../../core/errors/app-error";
import type { AppDatabase } from "../db/client";
import type { AuthActor, AuthSession, CreatedInvite, InviteSummary, LoginInput, RegisterInput, UserSummary } from "./auth-contracts";
import { AuthStore, type StoredInvite, type StoredUser } from "./auth-store";
import { DUMMY_PASSWORD_HASH, hashPassword, validPassword, verifyPassword, withPasswordJob, type PasswordHasher } from "./password";

export type AuthServiceOptions = { database: AppDatabase; now?: () => number; passwordHasher?: PasswordHasher };
const digest = (token: string) => createHash("sha256").update(token).digest("hex");
const validToken = (token: unknown): token is string => typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
function normalizeUsername(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{3,32}$/.test(value) ? value.toLowerCase() : null;
}
const invalidCredentials = () => new AppError("AUTH_INVALID_CREDENTIALS", 401, "Invalid credentials");
const invalidInvite = () => new AppError("INVITE_INVALID", 400, "Invalid invitation");
const actorOf = (user: StoredUser): AuthActor => ({ ownerId: user.ownerId, username: user.username, role: user.role });

export class AuthService {
  private readonly store: AuthStore;
  private readonly now: () => number;
  private readonly passwords: PasswordHasher;
  constructor(options: AuthServiceOptions) {
    this.store = new AuthStore(options.database);
    this.now = options.now ?? Date.now;
    this.passwords = options.passwordHasher ?? { hash: hashPassword, verify: verifyPassword };
  }
  private admit(rawUsername: unknown): string | null {
    const username = normalizeUsername(rawUsername);
    if (!this.store.admit(username ? digest(username) : null, this.now())) {
      throw new AppError("AUTH_RATE_LIMITED", 429, "Authentication admission limit");
    }
    return username;
  }
  private usableInvite(token: string, now: number): StoredInvite {
    const invite = validToken(token) ? this.store.invite(digest(token)) : undefined;
    if (!invite || invite.usedAt !== null || invite.revokedAt !== null || invite.expiresAt <= now) throw invalidInvite();
    return invite;
  }
  async register(input: RegisterInput): Promise<AuthSession> {
    const username = this.admit(input.username);
    if (!username || !validPassword(input.password)) throw new AppError("VALIDATION_ERROR", 400, "Invalid registration credentials");
    this.usableInvite(input.inviteToken, this.now());
    const passwordHash = await withPasswordJob(() => this.passwords.hash(input.password));
    return this.store.transaction(() => {
      const now = this.now();
      const invite = this.usableInvite(input.inviteToken, now);
      if (this.store.userByName(username)) throw new AppError("AUTH_REGISTRATION_FAILED", 409, "Registration unavailable");
      const actor: AuthActor = { ownerId: randomUUID(), username, role: invite.role };
      if (!this.store.consumeInvite(invite.id, now)) throw invalidInvite();
      this.store.insertUser(actor, passwordHash, now);
      return this.session(actor, now);
    });
  }
  async login(input: LoginInput): Promise<AuthSession> {
    const username = this.admit(input.username);
    if (!username || !validPassword(input.password)) throw invalidCredentials();
    const before = this.store.userByName(username);
    const verified = await withPasswordJob(() => this.passwords.verify(input.password, before?.passwordHash ?? DUMMY_PASSWORD_HASH));
    return this.store.transaction(() => {
      const after = this.store.userByName(username);
      if (!verified || !before || !after || after.disabledAt !== null || after.passwordHash !== before.passwordHash) throw invalidCredentials();
      return this.session(actorOf(after), this.now());
    });
  }
  private session(actor: AuthActor, now: number): AuthSession {
    const token = randomBytes(32).toString("base64url"), expiresAt = now + 7 * 24 * 60 * 60 * 1000;
    this.store.insertSession(digest(token), actor.ownerId, now, expiresAt);
    return { actor, token, expiresAt };
  }
  authenticate(token: string): AuthActor | null {
    return validToken(token) ? this.store.authenticate(digest(token), this.now()) : null;
  }
  logout(token: string): void { if (validToken(token)) this.store.deleteSession(digest(token)); }
  /** CLI only. Never expose bootstrap or resetPassword as unauthenticated HTTP methods. */
  bootstrapAdminInvite(): CreatedInvite {
    return this.store.transaction(() => {
      if (this.store.hasAdmin() || this.store.hasBootstrapInvite(this.now())) throw new AppError("AUTH_FORBIDDEN", 403, "Administrator already bootstrapped");
      return this.invite("admin", null);
    });
  }
  private requireAdmin(actor: AuthActor): void {
    const user = this.store.userById(actor.ownerId);
    if (!user || user.disabledAt !== null || user.role !== "admin") throw new AppError("AUTH_FORBIDDEN", 403, "Administrator required");
  }
  private invite(role: AuthActor["role"], createdBy: string | null): CreatedInvite {
    const token = randomBytes(32).toString("base64url"), now = this.now();
    const result = { id: randomUUID(), token, expiresAt: now + 72 * 60 * 60 * 1000 };
    this.store.insertInvite({ id: result.id, tokenHash: digest(token), role, createdBy, createdAt: now, expiresAt: result.expiresAt, usedAt: null, revokedAt: null });
    return result;
  }
  createInvite(actor: AuthActor): CreatedInvite {
    return this.store.transaction(() => { this.requireAdmin(actor); return this.invite("member", actor.ownerId); });
  }
  revokeInvite(actor: AuthActor, id: string): void {
    this.store.transaction(() => {
      this.requireAdmin(actor);
      if (!this.store.revokeInvite(id, this.now())) throw new AppError("NOT_FOUND", 404, "Unused invite not found");
    });
  }
  listUsers(actor: AuthActor): UserSummary[] {
    return this.store.transaction(() => { this.requireAdmin(actor); return this.store.users(); });
  }
  listInvites(actor: AuthActor): InviteSummary[] {
    return this.store.transaction(() => { this.requireAdmin(actor); return this.store.invites(); });
  }
  disableUser(actor: AuthActor, id: string): void {
    this.store.transaction(() => {
      this.requireAdmin(actor);
      const user = this.store.userById(id);
      if (!user) throw new AppError("NOT_FOUND", 404, "User not found");
      if (user.role === "admin" && user.disabledAt === null && this.store.activeAdmins() <= 1) throw new AppError("AUTH_FORBIDDEN", 403, "Cannot disable final administrator");
      this.store.disableUser(id, this.now());
      this.store.deleteUserSessions(id);
    });
  }
  async resetPassword(rawUsername: string, password: string): Promise<void> {
    const username = normalizeUsername(rawUsername);
    if (!username || !validPassword(password)) throw new AppError("VALIDATION_ERROR", 400, "Invalid reset credentials");
    const hash = await withPasswordJob(() => this.passwords.hash(password));
    this.store.transaction(() => {
      const user = this.store.userByName(username);
      if (!user) throw new AppError("NOT_FOUND", 404, "User not found");
      this.store.resetPassword(user.ownerId, hash);
      this.store.deleteUserSessions(user.ownerId);
    });
  }
}
