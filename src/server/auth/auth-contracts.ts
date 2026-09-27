export type AuthActor = { ownerId: string; username: string; role: "admin" | "member" };
export type LoginInput = { username: string; password: string };
export type RegisterInput = LoginInput & { inviteToken: string };
/** Internal adapter result. Send token in HttpOnly cookie, never in JSON. */
export type AuthSession = { actor: AuthActor; token: string; expiresAt: number };
export type CreatedInvite = { id: string; token: string; expiresAt: number };
export type UserSummary = AuthActor & { disabledAt: number | null; createdAt: number };
export type InviteSummary = {
  id: string; role: AuthActor["role"]; createdBy: string | null;
  createdAt: number; expiresAt: number; usedAt: number | null; revokedAt: number | null;
};
