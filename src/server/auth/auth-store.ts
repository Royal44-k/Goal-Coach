import type { AppDatabase } from "../db/client";
import type { AuthActor, InviteSummary, UserSummary } from "./auth-contracts";

export type StoredUser = UserSummary & { passwordHash: string };
export type StoredInvite = InviteSummary & { tokenHash: string };
const userColumns = "id AS ownerId, username, role, password_hash AS passwordHash, disabled_at AS disabledAt, created_at AS createdAt";
const inviteColumns = "id, role, token_hash AS tokenHash, created_by AS createdBy, created_at AS createdAt, expires_at AS expiresAt, used_at AS usedAt, revoked_at AS revokedAt";

/** All transactions are synchronous and use BEGIN IMMEDIATE; never pass async callbacks. */
export class AuthStore {
  constructor(private readonly database: AppDatabase) {}
  transaction<T>(work: () => T): T { return this.database.$client.transaction(work).immediate(); }
  userByName(username: string): StoredUser | undefined {
    return this.database.$client.prepare(`SELECT ${userColumns} FROM auth_users WHERE username=?`).get(username) as StoredUser | undefined;
  }
  userById(id: string): StoredUser | undefined {
    return this.database.$client.prepare(`SELECT ${userColumns} FROM auth_users WHERE id=?`).get(id) as StoredUser | undefined;
  }
  insertUser(user: AuthActor, passwordHash: string, now: number): void {
    this.database.$client.prepare("INSERT INTO auth_users(id,username,password_hash,role,created_at) VALUES (?,?,?,?,?)").run(user.ownerId, user.username, passwordHash, user.role, now);
  }
  activeAdmins(): number {
    return (this.database.$client.prepare("SELECT count(*) AS count FROM auth_users WHERE role='admin' AND disabled_at IS NULL").get() as { count: number }).count;
  }
  hasAdmin(): boolean { return !!this.database.$client.prepare("SELECT 1 FROM auth_users WHERE role='admin' LIMIT 1").get(); }
  hasBootstrapInvite(now: number): boolean {
    return !!this.database.$client.prepare("SELECT 1 FROM auth_invites WHERE role='admin' AND used_at IS NULL AND revoked_at IS NULL AND expires_at>? LIMIT 1").get(now);
  }
  invite(hash: string): StoredInvite | undefined {
    return this.database.$client.prepare(`SELECT ${inviteColumns} FROM auth_invites WHERE token_hash=?`).get(hash) as StoredInvite | undefined;
  }
  insertInvite(invite: StoredInvite): void {
    this.database.$client.prepare("INSERT INTO auth_invites(id,token_hash,role,created_by,created_at,expires_at) VALUES (?,?,?,?,?,?)").run(invite.id, invite.tokenHash, invite.role, invite.createdBy, invite.createdAt, invite.expiresAt);
  }
  consumeInvite(id: string, now: number): boolean {
    return this.database.$client.prepare("UPDATE auth_invites SET used_at=? WHERE id=? AND used_at IS NULL AND revoked_at IS NULL AND expires_at>?").run(now, id, now).changes === 1;
  }
  revokeInvite(id: string, now: number): boolean {
    return this.database.$client.prepare("UPDATE auth_invites SET revoked_at=? WHERE id=? AND used_at IS NULL AND revoked_at IS NULL").run(now, id).changes === 1;
  }
  users(): UserSummary[] {
    return this.database.$client.prepare("SELECT id AS ownerId,username,role,disabled_at AS disabledAt,created_at AS createdAt FROM auth_users ORDER BY created_at,id").all() as UserSummary[];
  }
  invites(): InviteSummary[] {
    return this.database.$client.prepare("SELECT id,role,created_by AS createdBy,created_at AS createdAt,expires_at AS expiresAt,used_at AS usedAt,revoked_at AS revokedAt FROM auth_invites ORDER BY created_at,id").all() as InviteSummary[];
  }
  disableUser(id: string, now: number): void { this.database.$client.prepare("UPDATE auth_users SET disabled_at=? WHERE id=?").run(now, id); }
  resetPassword(id: string, hash: string): void { this.database.$client.prepare("UPDATE auth_users SET password_hash=? WHERE id=?").run(hash, id); }
  deleteUserSessions(id: string): void { this.database.$client.prepare("DELETE FROM auth_sessions WHERE user_id=?").run(id); }
  insertSession(hash: string, id: string, now: number, expiresAt: number): void {
    this.database.$client.prepare("INSERT INTO auth_sessions(token_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)").run(hash, id, now, expiresAt);
  }
  authenticate(hash: string, now: number): AuthActor | null {
    return this.database.$client.prepare("SELECT u.id AS ownerId,u.username,u.role FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.disabled_at IS NULL").get(hash, now) as AuthActor | undefined ?? null;
  }
  deleteSession(hash: string): void { this.database.$client.prepare("DELETE FROM auth_sessions WHERE token_hash=?").run(hash); }
  cleanup(now: number): void {
    this.database.$client.prepare("DELETE FROM auth_throttles WHERE bucket IN (SELECT bucket FROM auth_throttles WHERE expires_at<=? LIMIT 100)").run(now);
    this.database.$client.prepare("DELETE FROM auth_sessions WHERE token_hash IN (SELECT token_hash FROM auth_sessions WHERE expires_at<=? LIMIT 100)").run(now);
  }
  /** Increment denied account attempts globally too. Commit counters before throwing. */
  admit(accountHash: string | null, now: number): boolean {
    return this.transaction(() => {
      this.cleanup(now);
      if (this.bump("global", now) > 30) return false;
      return accountHash === null || this.bump(`account:${accountHash}`, now) <= 5;
    });
  }
  private bump(bucket: string, now: number): number {
    const row = this.database.$client.prepare(`INSERT INTO auth_throttles(bucket,attempts,expires_at) VALUES (?,1,?)
      ON CONFLICT(bucket) DO UPDATE SET attempts=CASE WHEN expires_at<=? THEN 1 ELSE min(attempts+1,31) END,
      expires_at=CASE WHEN expires_at<=? THEN excluded.expires_at ELSE expires_at END RETURNING attempts`).get(bucket, now + 60_000, now, now) as { attempts: number };
    return row.attempts;
  }
}
