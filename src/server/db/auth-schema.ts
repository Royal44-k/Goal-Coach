import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const authUsers = sqliteTable("auth_users", {
  id: text("id").primaryKey(), username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(), role: text("role").$type<"admin" | "member">().notNull(),
  disabledAt: integer("disabled_at"), createdAt: integer("created_at").notNull(),
}, t => [check("auth_users_role_check", sql`${t.role} IN ('admin','member')`)]);

export const authInvites = sqliteTable("auth_invites", {
  id: text("id").primaryKey(), tokenHash: text("token_hash").notNull().unique(),
  role: text("role").$type<"admin" | "member">().notNull(),
  createdBy: text("created_by").references(() => authUsers.id),
  createdAt: integer("created_at").notNull(), expiresAt: integer("expires_at").notNull(),
  usedAt: integer("used_at"), revokedAt: integer("revoked_at"),
}, t => [check("auth_invites_role_check", sql`${t.role} IN ('admin','member')`)]);

export const authSessions = sqliteTable("auth_sessions", {
  tokenHash: text("token_hash").primaryKey(),
  userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
  createdAt: integer("created_at").notNull(), expiresAt: integer("expires_at").notNull(),
}, t => [index("auth_sessions_user_idx").on(t.userId), index("auth_sessions_expiry_idx").on(t.expiresAt)]);

export const authThrottles = sqliteTable("auth_throttles", {
  bucket: text("bucket").primaryKey(), attempts: integer("attempts").notNull(), expiresAt: integer("expires_at").notNull(),
}, t => [index("auth_throttles_expiry_idx").on(t.expiresAt)]);
