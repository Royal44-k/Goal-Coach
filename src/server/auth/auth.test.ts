import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createDatabase } from "../db/client";
import { migrateDatabase } from "../db/migrate";
import { LOCAL_OWNER_ID } from "../security/local-owner";
import { AuthService } from "./auth-service";
import { loadAuthConfig } from "./auth-config";
import { hashPassword, verifyPassword, type PasswordHasher } from "./password";

const cleanup: Array<() => void> = [];
const password = "a long synthetic password";
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "coach-auth-"));
  const db = createDatabase(join(dir, "test.db"));
  migrateDatabase(db);
  let time = 1_800_000_000_000;
  const now = () => time;
  const service = new AuthService({ database: db, now });
  cleanup.push(() => { db.$client.close(); rmSync(dir, { recursive: true, force: true }); });
  return { db, service, now, advance: (ms: number) => { time += ms; } };
}
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
async function admin(f: ReturnType<typeof fixture>) {
  return f.service.register({ inviteToken: f.service.bootstrapAdminInvite().token, username: "Alice", password });
}

test("config restricts local host and requires HTTPS except invite loopback", () => {
  expect(loadAuthConfig({})).toEqual({ mode: "local", origin: "http://127.0.0.1:3000", secureCookies: false });
  expect(loadAuthConfig({ APP_MODE: "invite", APP_ORIGIN: "https://coach.example" }).secureCookies).toBe(true);
  expect(loadAuthConfig({ APP_MODE: "invite", APP_ORIGIN: "http://[::1]:3000" }).secureCookies).toBe(false);
  for (const input of [{ APP_MODE: "unknown" }, { APP_ORIGIN: "http://localhost:3000" }, { APP_MODE: "invite", APP_ORIGIN: "http://coach.example" }, { APP_ORIGIN: "http://127.0.0.1:3000/path" }]) expect(() => loadAuthConfig(input)).toThrow();
});

test("real scrypt verifies without trimming, uses independent salts, and rejects malformed hashes", async () => {
  const first = await hashPassword(password);
  expect(first).not.toEqual(await hashPassword(password));
  expect(await verifyPassword(password, first)).toBe(true);
  expect(await verifyPassword(password + " ", first)).toBe(false);
  expect(await verifyPassword(password, "malformed")).toBe(false);
});

test("register creates independent identity, consumes invite once and stores no raw secrets", async () => {
  const f = fixture();
  f.db.$client.prepare("INSERT INTO goals (id,owner_id,title,category,status,created_at,updated_at) VALUES ('legacy',?,'legacy','other','active',1,1)").run(LOCAL_OWNER_ID);
  const invite = f.service.bootstrapAdminInvite();
  const first = await f.service.register({ inviteToken: invite.token, username: "Alice", password });
  expect(first.actor).toMatchObject({ username: "alice", role: "admin" });
  expect(first.actor.ownerId).not.toBe(LOCAL_OWNER_ID);
  expect(f.service.authenticate(first.token)).toEqual(first.actor);
  await expect(f.service.register({ inviteToken: invite.token, username: "Bob", password })).rejects.toMatchObject({ code: "INVITE_INVALID" });
  const persisted = JSON.stringify([f.db.$client.prepare("SELECT * FROM auth_users").all(), f.db.$client.prepare("SELECT * FROM auth_invites").all(), f.db.$client.prepare("SELECT * FROM auth_sessions").all()]);
  for (const secret of [password, invite.token, first.token]) expect(persisted).not.toContain(secret);
  expect(f.db.$client.prepare("SELECT owner_id FROM goals WHERE id='legacy'").get()).toEqual({ owner_id: LOCAL_OWNER_ID });
  f.service.logout(first.token);
  expect(f.service.authenticate(first.token)).toBeNull();
});

test("parallel invite consumption has one winner and duplicate username leaves invite usable", async () => {
  const f = fixture(), first = await admin(f);
  const invite = f.service.createInvite(first.actor);
  await expect(f.service.register({ inviteToken: invite.token, username: "ALICE", password })).rejects.toMatchObject({ code: "AUTH_REGISTRATION_FAILED" });
  const outcomes = await Promise.allSettled(["bravo", "charlie"].map(username => f.service.register({ inviteToken: invite.token, username, password })));
  expect(outcomes.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(f.service.listUsers(first.actor)).toHaveLength(2);
});

test("expired and revoked bootstrap invites permit recovery; expiry boundaries are absolute", async () => {
  const f = fixture(), expired = f.service.bootstrapAdminInvite();
  expect(() => f.service.bootstrapAdminInvite()).toThrow();
  f.advance(72 * 60 * 60 * 1000);
  await expect(f.service.register({ inviteToken: expired.token, username: "alice", password })).rejects.toMatchObject({ code: "INVITE_INVALID" });
  const revoked = f.service.bootstrapAdminInvite();
  f.db.$client.prepare("UPDATE auth_invites SET revoked_at=? WHERE id=?").run(f.now(), revoked.id);
  const first = await admin(f);
  expect(() => f.service.bootstrapAdminInvite()).toThrow();
  f.advance(7 * 24 * 60 * 60 * 1000);
  expect(f.service.authenticate(first.token)).toBeNull();
});

test("admin management rechecks stored roles, protects last admin and revokes disabled sessions", async () => {
  const f = fixture(), first = await admin(f), invite = f.service.createInvite(first.actor);
  const member = await f.service.register({ inviteToken: invite.token, username: "member", password });
  for (const actor of [member.actor, { ...member.actor, role: "admin" as const }]) {
    expect(() => f.service.createInvite(actor)).toThrow();
    expect(() => f.service.listUsers(actor)).toThrow();
    expect(() => f.service.listInvites(actor)).toThrow();
    expect(() => f.service.disableUser(actor, first.actor.ownerId)).toThrow();
    expect(() => f.service.revokeInvite(actor, invite.id)).toThrow();
  }
  expect(() => f.service.disableUser(first.actor, first.actor.ownerId)).toThrow();
  const unused = f.service.createInvite(first.actor);
  f.service.revokeInvite(first.actor, unused.id);
  await expect(f.service.register({ inviteToken: unused.token, username: "revoked", password })).rejects.toMatchObject({ code: "INVITE_INVALID" });
  expect(JSON.stringify(f.service.listInvites(first.actor))).not.toContain(unused.token);
  expect(JSON.stringify(f.service.listUsers(first.actor))).not.toContain("scrypt");
  f.service.disableUser(first.actor, member.actor.ownerId);
  expect(f.service.authenticate(member.token)).toBeNull();
  await expect(f.service.login({ username: "member", password })).rejects.toMatchObject({ code: "AUTH_INVALID_CREDENTIALS" });
});

test("generic login errors and CLI reset invalidate all sessions and old password", async () => {
  const f = fixture(), first = await admin(f);
  const second = await f.service.login({ username: "ALICE", password });
  for (const username of ["alice", "missing"]) await expect(f.service.login({ username, password: "wrong synthetic password" })).rejects.toMatchObject({ code: "AUTH_INVALID_CREDENTIALS", status: 401 });
  await f.service.resetPassword("alice", "replacement synthetic password");
  expect(f.service.authenticate(first.token)).toBeNull();
  expect(f.service.authenticate(second.token)).toBeNull();
  f.advance(60_000);
  await expect(f.service.login({ username: "alice", password })).rejects.toMatchObject({ code: "AUTH_INVALID_CREDENTIALS" });
  expect((await f.service.login({ username: "alice", password: "replacement synthetic password" })).actor).toEqual(first.actor);
});

test("persistent global and account throttles run before credential validation and hashing", async () => {
  const f = fixture();
  for (let i = 0; i < 5; i++) await expect(f.service.login({ username: "alice", password: "short" })).rejects.toMatchObject({ code: "AUTH_INVALID_CREDENTIALS" });
  const other = new AuthService({ database: f.db, now: f.now });
  await expect(other.login({ username: "ALICE", password })).rejects.toMatchObject({ code: "AUTH_RATE_LIMITED" });
  for (let i = 0; i < 24; i++) await expect(other.login({ username: "!", password: "short" })).rejects.toMatchObject({ code: "AUTH_INVALID_CREDENTIALS" });
  await expect(other.register({ username: "newuser", password, inviteToken: "invalid" })).rejects.toMatchObject({ code: "AUTH_RATE_LIMITED" });
  f.advance(60_000);
  await expect(other.login({ username: "alice", password: "short" })).rejects.toMatchObject({ code: "AUTH_INVALID_CREDENTIALS" });
  expect(f.db.$client.prepare("SELECT count(*) AS count FROM auth_throttles WHERE expires_at<=?").get(f.now())).toEqual({ count: 0 });
});

test("registration rejects oversized credentials and invalid names without consuming invite", async () => {
  const f = fixture(), invite = f.service.bootstrapAdminInvite();
  for (const credentials of [{ username: "ab", password }, { username: "a".repeat(33), password }, { username: "alice", password: "x".repeat(129) }, { username: "alice", password: "short" }]) await expect(f.service.register({ inviteToken: invite.token, ...credentials })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect((await f.service.register({ inviteToken: invite.token, username: "alice", password })).actor.role).toBe("admin");
});

function blockedHasher(): { hasher: PasswordHasher; entered: Promise<void>; release: () => void } {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  return { entered: started, release, hasher: { hash: hashPassword, async verify() { entered(); await barrier; return true; } } };
}

test.each(["reset", "disable"])("login rechecks state after hashing when concurrent %s occurs", async action => {
  const f = fixture(), first = await admin(f), invite = f.service.createInvite(first.actor);
  const member = await f.service.register({ inviteToken: invite.token, username: "member", password });
  const blocker = blockedHasher();
  const delayed = new AuthService({ database: f.db, now: f.now, passwordHasher: blocker.hasher });
  const pending = delayed.login({ username: "member", password });
  await blocker.entered;
  if (action === "reset") await f.service.resetPassword("member", "replacement synthetic password");
  else f.service.disableUser(first.actor, member.actor.ownerId);
  blocker.release();
  await expect(pending).rejects.toMatchObject({ code: "AUTH_INVALID_CREDENTIALS" });
  expect(f.service.authenticate(member.token)).toBeNull();
  expect(f.db.$client.prepare("SELECT count(*) AS count FROM auth_sessions WHERE user_id=?").get(member.actor.ownerId)).toEqual({ count: 0 });
});

test("global password worker bound rejects third job across service instances and recovers", async () => {
  const f = fixture(), blocker = blockedHasher();
  const slow = new AuthService({ database: f.db, now: f.now, passwordHasher: blocker.hasher });
  const slow2 = new AuthService({ database: f.db, now: f.now, passwordHasher: blocker.hasher });
  const pending = [slow.login({ username: "missing1", password }), slow2.login({ username: "missing2", password })];
  // Install rejection handlers before releasing the deterministic password barrier.
  const done = Promise.allSettled(pending);
  await blocker.entered;
  await expect(f.service.login({ username: "missing3", password })).rejects.toMatchObject({ code: "AUTH_RATE_LIMITED" });
  blocker.release();
  expect((await done).every(result => result.status === "rejected")).toBe(true);
  await expect(f.service.login({ username: "missing4", password })).rejects.toMatchObject({ code: "AUTH_INVALID_CREDENTIALS" });
});

test("denied account and global admission never invoke password verification", async () => {
  const f = fixture();
  let verifications = 0;
  const checked = new AuthService({ database: f.db, now: f.now, passwordHasher: {
    hash: hashPassword,
    verify: (value, hash) => { verifications++; return verifyPassword(value, hash); },
  } });
  for (let i = 0; i < 5; i++) await expect(checked.login({ username: "missing", password })).rejects.toMatchObject({ code: "AUTH_INVALID_CREDENTIALS" });
  expect(verifications).toBe(5);
  await expect(checked.login({ username: "MISSING", password })).rejects.toMatchObject({ code: "AUTH_RATE_LIMITED" });
  expect(verifications).toBe(5);
  for (let i = 0; i < 24; i++) await expect(checked.login({ username: "!", password })).rejects.toMatchObject({ code: "AUTH_INVALID_CREDENTIALS" });
  await expect(checked.login({ username: "other", password })).rejects.toMatchObject({ code: "AUTH_RATE_LIMITED" });
  expect(verifications).toBe(5);
});

test("SQLite write failure rolls back invite consumption and partial account creation", async () => {
  const f = fixture(), invite = f.service.bootstrapAdminInvite();
  f.db.$client.exec("CREATE TRIGGER reject_session BEFORE INSERT ON auth_sessions BEGIN SELECT RAISE(ABORT, 'synthetic fixture failure'); END");
  await expect(f.service.register({ inviteToken: invite.token, username: "alice", password })).rejects.toThrow();
  expect(f.db.$client.prepare("SELECT used_at FROM auth_invites WHERE id=?").get(invite.id)).toEqual({ used_at: null });
  expect(f.db.$client.prepare("SELECT count(*) AS count FROM auth_users").get()).toEqual({ count: 0 });
  f.db.$client.exec("DROP TRIGGER reject_session");
  expect((await f.service.register({ inviteToken: invite.token, username: "alice", password })).actor.role).toBe("admin");
});

test("expired throttle cleanup is bounded per admission", async () => {
  const f = fixture();
  const insert = f.db.$client.prepare("INSERT INTO auth_throttles(bucket,attempts,expires_at) VALUES (?,1,?)");
  for (let i = 0; i < 250; i++) insert.run(`expired:${i}`, f.now() - 1);
  await expect(f.service.login({ username: "!", password })).rejects.toMatchObject({ code: "AUTH_INVALID_CREDENTIALS" });
  expect(f.db.$client.prepare("SELECT count(*) AS count FROM auth_throttles WHERE expires_at<=?").get(f.now())).toEqual({ count: 150 });
});

test("independent SQLite connections share atomic global admission counters", async () => {
  const f = fixture(), secondDb = createDatabase(f.db.$client.name);
  try {
    const second = new AuthService({ database: secondDb, now: f.now });
    const outcomes = await Promise.allSettled(Array.from({ length: 31 }, (_, i) =>
      (i % 2 ? second : f.service).login({ username: `account${i}`, password: "short" })));
    expect(outcomes.filter(r => r.status === "rejected" && r.reason.code === "AUTH_RATE_LIMITED")).toHaveLength(1);
    expect(outcomes.filter(r => r.status === "rejected" && r.reason.code === "AUTH_INVALID_CREDENTIALS")).toHaveLength(30);
  } finally { secondDb.$client.close(); }
});
