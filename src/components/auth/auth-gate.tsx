"use client";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { z } from "zod";
import { apiClient } from "@/lib/api-client";
import { LoginForm } from "./login-form";
import { SessionSchema, type Session } from "./auth-contracts";

const AccountContext = createContext<{ session: Session | null; logout: () => Promise<void> }>({ session: null, logout: async () => undefined });
function readSession() { return apiClient.request("/api/auth/session", { cache: "no-store" }, SessionSchema); }
export const useAccount = () => useContext(AccountContext);
export function AuthGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null), [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true), [logoutFailed, setLogoutFailed] = useState(false);
  const epoch = useRef(0), stopped = useRef(false);
  const observe = useCallback((promise: Promise<Session>, ticket: number) => {
    return promise.then(value => {
      if (ticket !== epoch.current || stopped.current) return;
      setSession(value); setError(null); setChecking(false);
    }, () => {
      if (ticket !== epoch.current || stopped.current) return;
      setSession(null); setError("无法确认登录状态，请重新读取。"); setChecking(false);
    });
  }, []);
  const check = useCallback(() => { if (stopped.current) return Promise.resolve(); return observe(readSession(), ++epoch.current); }, [observe]);
  useEffect(() => {
    let active = true;
    stopped.current = false;
    const expire = () => { epoch.current++; stopped.current = true; setSession({ mode: "invite", actor: null }); setError(null); setChecking(false); };
    const refresh = () => { if (active && !stopped.current) { setChecking(true); void check(); } };
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    void observe(readSession(), ++epoch.current);
    window.addEventListener("goal-coach-auth-required", expire); window.addEventListener("focus", refresh); window.addEventListener("pageshow", refresh);
    document.addEventListener("visibilitychange", visible);
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void check(); }, 60_000);
    return () => { active = false; stopped.current = true; window.clearInterval(timer); window.removeEventListener("goal-coach-auth-required", expire); window.removeEventListener("focus", refresh); window.removeEventListener("pageshow", refresh); document.removeEventListener("visibilitychange", visible); };
  }, [check, observe]);
  async function logout() {
    epoch.current++; stopped.current = true;
    setSession({ mode: "invite", actor: null }); setChecking(true); setLogoutFailed(false);
    try { await apiClient.request("/api/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }, z.null()); window.location.replace("/login"); }
    catch { setError("无法确认退出是否完成，请重试退出。"); setLogoutFailed(true); setChecking(false); }
  }
  if (checking && !(session?.mode === "local" || session?.actor)) return <main className="auth-page"><p role="status">正在确认登录状态…</p></main>;
  if (error) return <main className="auth-page"><p role="alert">{error}</p><button onClick={() => void (logoutFailed ? logout() : check())}>{logoutFailed ? "重试退出" : "重新读取"}</button></main>;
  if (!session || (session.mode === "invite" && !session.actor)) return <LoginForm />;
  return <AccountContext.Provider key={session.actor?.ownerId} value={{ session, logout }}><div hidden={checking}>{children}</div>{checking ? <main className="auth-page"><p role="status">正在确认登录状态…</p></main> : null}</AccountContext.Provider>;
}
