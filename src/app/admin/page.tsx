"use client";
import { AppShell } from "@/components/layout/app-shell";
import { useAccount } from "@/components/auth/auth-gate";
import { AdminPanel } from "@/components/auth/admin-panel";
export default function AdminPage() {
  const { session } = useAccount();
  return <AppShell goals={[]} settings={null}><header className="page-intro"><h1>邀请与账号</h1><p>管理邀请试用的账号访问权限。</p></header>{session?.mode === "invite" && session.actor?.role === "admin" ? <AdminPanel /> : <p role="alert">只有管理员可以管理邀请与账号。</p>}</AppShell>;
}
