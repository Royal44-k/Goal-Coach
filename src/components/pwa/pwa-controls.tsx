"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";

type InstallEvent = Event & { prompt: () => Promise<void> };
type PWAState = {
  online: boolean;
  standalone: boolean;
  ios: boolean;
  iosSafari: boolean;
  embedded: boolean;
  supported: boolean;
  installPrompt: InstallEvent | null;
  waiting: ServiceWorker | null;
  updateStarted: boolean;
  updateReady: boolean;
  install: () => void;
  update: () => void;
};

const Context = createContext<PWAState | null>(null);

export function PWAProvider({ children }: { children: ReactNode }) {
  const [online, setOnline] = useState(true);
  const [standalone, setStandalone] = useState(false);
  const [ios, setIos] = useState(false);
  const [iosSafari, setIosSafari] = useState(false);
  const [embedded, setEmbedded] = useState(false);
  const [supported, setSupported] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<InstallEvent | null>(null);
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [updateStarted, setUpdateStarted] = useState(false);
  const [updateReady, setUpdateReady] = useState(false);
  const updateRequested = useRef(false);

  useEffect(() => {
    let active = true;
    let registration: ServiceWorkerRegistration | undefined;
    let installing: ServiceWorker | null = null;
    const media = window.matchMedia("(display-mode: standalone)");
    const refreshDisplay = () => setStandalone(media.matches || (navigator as Navigator & { standalone?: boolean }).standalone === true);
    const refreshOnline = () => setOnline(navigator.onLine);
    const showInstall = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallEvent);
    };
    const installed = () => setInstallPrompt(null);
    const controllerChanged = () => { if (updateRequested.current) setUpdateReady(true); };
    const trackWaiting = () => { if (registration?.waiting) setWaiting(registration.waiting); };
    const trackInstalling = () => {
      installing?.removeEventListener("statechange", trackWaiting);
      installing = registration?.installing ?? null;
      installing?.addEventListener("statechange", trackWaiting);
      trackWaiting();
    };
    queueMicrotask(() => {
      if (!active) return;
      refreshDisplay();
      refreshOnline();
      const ua = navigator.userAgent;
      setEmbedded(/MicroMessenger|FBAN|FBAV|Instagram|Line\/|GSA\/|; wv\)|\bwv\b/i.test(ua));
      setIos(/iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));
      setIosSafari(/Version\/[\d.]+/.test(ua) && /Safari\/[\d.]+/.test(ua) && !/(CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo|MicroMessenger|FBAN|FBAV|Instagram|Line\/|GSA\/|wv)/i.test(ua));
      setSupported("serviceWorker" in navigator);
    });
    media.addEventListener("change", refreshDisplay);
    window.addEventListener("online", refreshOnline);
    window.addEventListener("offline", refreshOnline);
    window.addEventListener("beforeinstallprompt", showInstall);
    window.addEventListener("appinstalled", installed);
    if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("controllerchange", controllerChanged);
      void navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).then(value => {
        if (!active) return;
        registration = value;
        trackWaiting();
        registration.addEventListener("updatefound", trackInstalling);
        trackInstalling();
      }).catch(() => { /* Installation guidance remains available without offline support. */ });
    }
    return () => {
      active = false;
      media.removeEventListener("change", refreshDisplay);
      window.removeEventListener("online", refreshOnline);
      window.removeEventListener("offline", refreshOnline);
      window.removeEventListener("beforeinstallprompt", showInstall);
      window.removeEventListener("appinstalled", installed);
      if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) navigator.serviceWorker.removeEventListener("controllerchange", controllerChanged);
      registration?.removeEventListener("updatefound", trackInstalling);
      installing?.removeEventListener("statechange", trackWaiting);
    };
  }, []);

  const install = () => {
    if (!installPrompt) return;
    void installPrompt.prompt().finally(() => setInstallPrompt(null));
  };
  const update = () => {
    if (!waiting) return;
    updateRequested.current = true;
    waiting.postMessage({ type: "SKIP_WAITING" });
    setUpdateStarted(true);
  };
  return <Context.Provider value={{ online, standalone, ios, iosSafari, embedded, supported, installPrompt, waiting, updateStarted, updateReady, install, update }}>{children}</Context.Provider>;
}

export function PWAControls() {
  const state = useContext(Context);
  if (!state) return null;
  const { online, standalone, ios, iosSafari, embedded, supported, installPrompt, waiting, updateStarted, updateReady, install, update } = state;
  return (
    <section className="pwa-controls" aria-label="安装与连接">
      {!standalone && (
        installPrompt ? <button type="button" className="button-secondary" onClick={install}>添加到主屏幕</button>
          : embedded ? <p>{ios ? "请在当前浏览器中选择“在 Safari 中打开”；若没有此选项，复制链接并在 Safari 打开，再通过“分享”添加到主屏幕。" : "请在当前应用中选择“在系统浏览器中打开”；若没有此选项，复制链接并在系统浏览器打开。"}</p>
            : ios ? <p>{iosSafari ? "在 Safari 中点“分享”，再选“添加到主屏幕”。" : "请在 Safari 中打开，再通过“分享”添加到主屏幕。"}</p>
            : <p>{supported ? "可在浏览器菜单中选择“添加到主屏幕”。" : "浏览器菜单中可查看是否支持添加到主屏幕。"}</p>
      )}
      {!online && <p role="status">当前离线，请联网后继续</p>}
      {waiting && !updateStarted && <div role="status"><p>有新版本，可在保存当前内容后更新。</p><button type="button" className="button-secondary" onClick={update}>保存当前内容后更新</button></div>}
      {updateStarted && !updateReady && <p role="status">正在启用新版本，请保存当前内容。</p>}
      {updateReady && <div role="status"><p>新版本已就绪。未保存的输入会丢失，请先保存当前内容。</p><button type="button" className="button-secondary" onClick={() => window.location.reload()}>刷新页面</button></div>}
    </section>
  );
}
