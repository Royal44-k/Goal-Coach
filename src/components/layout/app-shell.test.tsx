// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { AppShell } from "./app-shell";

const goal = {
  id: "8d6ab7e8-d538-4dd6-a5e8-c65b981d9550",
  title: "完成 TypeScript 待办网页",
  category: "learning" as const,
  status: "active" as const,
  agentState: "active" as const,
  updatedAt: "2026-09-16T08:00:00+08:00",
  progress: { completed: 1, total: 3, percent: 33 },
};

afterEach(cleanup);

it("places keyboard navigation before one named main landmark", () => {
  const { container } = render(
    <AppShell goals={[goal]} settings={null}>
      <h1>工作区</h1>
    </AppShell>,
  );

  expect(screen.getByRole("link", { name: "跳到主要内容" })).toHaveAttribute("href", "#main-content");
  expect(screen.getByRole("navigation", { name: "目标导航" })).toContainElement(screen.getByRole("link", { name: goal.title }));
  expect(screen.getByRole("link", { name: "设置与数据" })).toHaveAttribute("href", "/settings");
  expect(screen.getAllByRole("main")).toHaveLength(1);
  const navigation = container.querySelector("nav");
  const main = container.querySelector("main");
  expect(navigation).not.toBeNull();
  expect(main).not.toBeNull();
  expect(navigation!.compareDocumentPosition(main!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it("describes model selection and credential presence without claiming connectivity", () => {
  render(
    <AppShell
      goals={[]}
      settings={{ provider: "qwen", apiKeyConfigured: true }}
    >
      <h1>工作区</h1>
    </AppShell>,
  );

  expect(screen.getByRole("status")).toHaveTextContent("已选择阿里云百炼模型，并已检测到本机凭证");
  expect(screen.getByRole("status")).not.toHaveTextContent(/已连接|连接成功/);
});

it("uses the exact offline disclosure for mock mode", () => {
  render(
    <AppShell goals={[]} settings={{ provider: "mock", apiKeyConfigured: false }}>
      <h1>工作区</h1>
    </AppShell>,
  );

  expect(screen.getByRole("status")).toHaveTextContent("当前未连接模型，对话使用预设流程。");
});

it("names DeepSeek in the model banner without claiming a verified connection", () => {
  render(<AppShell goals={[]} settings={{ provider: "deepseek", apiKeyConfigured: true }}><h1>工作区</h1></AppShell>);
  expect(screen.getByRole("status")).toHaveTextContent("已选择DeepSeek模型，并已检测到本机凭证");
  expect(screen.getByRole("status")).not.toHaveTextContent(/已连接|连接成功/);
});
