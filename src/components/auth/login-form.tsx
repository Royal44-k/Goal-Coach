"use client";
import { useState, type FormEvent } from "react";
import { apiClient, isReceivedApiError } from "@/lib/api-client";
import { LoginResultSchema } from "./auth-contracts";

export function LoginForm() {
  const [register, setRegister] = useState(false), [visible, setVisible] = useState(false);
  const [pending, setPending] = useState(false), [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (pending) return;
    const data = new FormData(event.currentTarget);
    setPending(true); setError(null);
    try {
      await apiClient.request(`/api/auth/${register ? "register" : "login"}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: data.get("username"), password: data.get("password"), ...(register ? { inviteToken: data.get("inviteToken") } : {}) }) }, LoginResultSchema);
      window.location.replace("/");
    } catch (failure) { setError(isReceivedApiError(failure) ? failure.message : "暂时无法完成，请检查网络后重试。"); setPending(false); }
  }
  return <main className="auth-page">
    <p className="wordmark">自适应目标教练</p><p>登录后继续自己的目标与行动。</p>
    <section className="settings-card" aria-labelledby="account-title">
      <h1 id="account-title">{register ? "邀请注册" : "账号登录"}</h1>
      <button type="button" className="button-secondary" disabled={pending} onClick={() => { setRegister(!register); setError(null); }}>{register ? "已有账号，去登录" : "使用邀请注册"}</button>
      <form onSubmit={submit} aria-describedby={error ? "account-error" : undefined}>
        <label>账号名<input name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} required minLength={3} maxLength={32} pattern={"[A-Za-z0-9_\\-]+"} disabled={pending} aria-describedby="username-help" /></label>
        <p id="username-help" className="form-help">3–32 位英文字母、数字、下划线或短横线。</p>
        <label>密码<input name="password" type={visible ? "text" : "password"} autoComplete={register ? "new-password" : "current-password"} required minLength={register ? 12 : 1} maxLength={128} disabled={pending} aria-describedby={error ? "password-help account-error" : "password-help"} /></label>
        <p id="password-help" className="form-help">{register ? "密码为 12–128 个字符，可使用密码管理器。" : "忘记密码请联系管理员，在服务器重置。"}</p>
        <button type="button" className="button-secondary" aria-pressed={visible} onClick={() => setVisible(!visible)}>{visible ? "隐藏密码" : "显示密码"}</button>
        {register ? <label>邀请码<input name="inviteToken" autoComplete="off" spellCheck={false} required maxLength={128} disabled={pending} /></label> : null}
        {error ? <p id="account-error" role="alert" className="inline-error">{error}</p> : null}
        <button type="submit" disabled={pending}>{pending ? "正在处理…" : register ? "注册并登录" : "登录"}</button>
      </form>
    </section>
  </main>;
}
