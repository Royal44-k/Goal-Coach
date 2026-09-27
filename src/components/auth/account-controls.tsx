"use client";
import Link from "next/link";
import { useAccount } from "./auth-gate";
export function AccountControls() {
  const { session, logout } = useAccount();
  if (session?.mode !== "invite" || !session.actor) return null;
  return <div className="account-controls"><span>当前账号：{session.actor.username}</span>{session.actor.role === "admin" ? <Link href="/admin" prefetch={false}>邀请与账号</Link> : null}<button className="button-secondary" onClick={() => void logout()}>退出登录</button></div>;
}
