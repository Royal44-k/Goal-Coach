"use client";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { apiClient, isReceivedApiError } from "@/lib/api-client";
import { ActorSchema } from "./auth-contracts";
const UsersSchema = z.array(ActorSchema.extend({ disabledAt: z.number().nullable(), createdAt: z.number() }));
const InvitesSchema = z.array(z.object({ id: z.uuid(), role: z.enum(["admin", "member"]), createdBy: z.string().nullable(), createdAt: z.number(), expiresAt: z.number(), usedAt: z.number().nullable(), revokedAt: z.number().nullable() }).strict());
const CreatedSchema = z.object({ id: z.uuid(), token: z.string(), expiresAt: z.number() }).strict();
function readLists() { return Promise.all([apiClient.request("/api/admin/users", { cache: "no-store" }, UsersSchema), apiClient.request("/api/admin/invites", { cache: "no-store" }, InvitesSchema)]); }
type Confirmation = { kind: "user" | "invite"; id: string; label: string };
export function AdminPanel() {
  const [users, setUsers] = useState<z.infer<typeof UsersSchema>>([]), [invites, setInvites] = useState<z.infer<typeof InvitesSchema>>([]);
  const [created, setCreated] = useState<z.infer<typeof CreatedSchema> | null>(null), [confirm, setConfirm] = useState<Confirmation | null>(null);
  const [pending, setPending] = useState(false), [error, setError] = useState<string | null>(null), [copied, setCopied] = useState(false);
  const [readAt, setReadAt] = useState(0);
  const load = useCallback(async () => {
    const [nextUsers, nextInvites] = await readLists();
    setUsers(nextUsers); setInvites(nextInvites); setReadAt(Date.now());
  }, []);
  useEffect(() => { let active = true; void readLists().then(([nextUsers, nextInvites]) => { if (active) { setUsers(nextUsers); setInvites(nextInvites); setReadAt(Date.now()); } }).catch(() => { if (active) setError("无法读取账号管理，请重新读取。"); }); return () => { active = false; }; }, []);
  async function manage(action: "create" | "confirm") {
    if (pending) return; setPending(true); setError(null);
    try {
      if (action === "create") { setCreated(await apiClient.request("/api/admin/invites", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }, CreatedSchema)); setCopied(false); }
      else if (confirm) {
        await apiClient.request(`/api/admin/${confirm.kind === "user" ? "users" : "invites"}`, { method: confirm.kind === "user" ? "PATCH" : "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: confirm.id }) }, z.null()); setConfirm(null);
      }
      await load();
    } catch (failure) { setError(isReceivedApiError(failure) ? failure.message : "无法确认操作结果，请重新读取列表后检查；不要重复创建邀请。"); }
    finally { setPending(false); }
  }
  async function copy() { if (!created) return; try { await navigator.clipboard.writeText(created.token); setCopied(true); } catch { setError("无法复制，请选择下方邀请码手动复制。"); } }
  return <>
    {error ? <div><p role="alert" className="inline-error">{error}</p><button className="button-secondary" disabled={pending} onClick={() => void load().then(() => setError(null)).catch(() => setError("无法读取账号管理，请重试。"))}>重新读取列表</button></div> : null}
    <section className="settings-card" aria-labelledby="invites-title"><h2 id="invites-title">邀请</h2><p>每个邀请在 72 小时内可注册一次普通账号。请私下分享邀请码。</p><button disabled={pending} onClick={() => void manage("create")}>{pending ? "正在处理…" : "创建普通邀请"}</button>
      {created ? <div><p>邀请码仅本次显示，请现在保存：</p><code className="invite-code">{created.token}</code><p>到期：{new Date(created.expiresAt).toLocaleString("zh-CN")}</p><button className="button-secondary" onClick={() => void copy()}>{copied ? "已复制" : "复制邀请码"}</button></div> : null}
      <ul className="admin-list">{invites.map(invite => <li key={invite.id}><span>{invite.role === "admin" ? "管理员邀请" : "普通邀请"} · {new Date(invite.createdAt).toLocaleString("zh-CN")} · {invite.usedAt ? "已使用" : invite.revokedAt ? "已撤销" : invite.expiresAt <= readAt ? "已过期" : "待使用"}</span>{!invite.usedAt && !invite.revokedAt && invite.expiresAt > readAt ? <button className="button-secondary" disabled={pending} onClick={() => setConfirm({ kind: "invite", id: invite.id, label: "这条未使用的邀请" })}>撤销邀请</button> : null}</li>)}</ul>
    </section>
    <section className="settings-card" aria-labelledby="users-title"><h2 id="users-title">账号</h2><p>禁用会立即撤销该账号的登录会话。忘记密码请在服务器管理命令中重置。</p><ul className="admin-list">{users.map(user => <li key={user.ownerId}><span>{user.username} · {user.role === "admin" ? "管理员" : "普通成员"} · {user.disabledAt ? "已禁用" : "可登录"}</span>{!user.disabledAt ? <button className="button-secondary" disabled={pending} onClick={() => setConfirm({ kind: "user", id: user.ownerId, label: user.username })}>禁用 {user.username}</button> : null}</li>)}</ul></section>
    {confirm ? <section className="settings-card settings-card--danger" aria-labelledby="admin-confirm-title"><h2 id="admin-confirm-title">{confirm.kind === "user" ? "确认禁用账号" : "确认撤销邀请"}</h2><p>{confirm.label}；{confirm.kind === "user" ? "该账号将立即退出，已有业务数据保留。" : "该邀请码将不能再注册。"}</p><button className="button-danger" disabled={pending} onClick={() => void manage("confirm")}>{confirm.kind === "user" ? "确认禁用" : "确认撤销"}</button> <button className="button-secondary" disabled={pending} onClick={() => setConfirm(null)}>取消</button></section> : null}
  </>;
}
