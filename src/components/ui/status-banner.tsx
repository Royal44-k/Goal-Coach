import type { ReactNode } from "react";

type StatusBannerProps = {
  children: ReactNode;
  tone?: "neutral" | "warning" | "danger";
};

export function StatusBanner({ children, tone = "neutral" }: StatusBannerProps) {
  return <div className={`status-banner status-banner--${tone}`} role="status">{children}</div>;
}
