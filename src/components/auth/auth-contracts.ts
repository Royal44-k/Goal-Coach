import { z } from "zod";
export const ActorSchema = z.object({ ownerId: z.uuid(), username: z.string(), role: z.enum(["admin", "member"]) }).strict();
export const SessionSchema = z.object({ mode: z.enum(["local", "invite"]), actor: ActorSchema.nullable() }).strict();
export const LoginResultSchema = z.object({ actor: ActorSchema }).strict();
export type Session = z.infer<typeof SessionSchema>;
