// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { EvidenceDialog } from "./evidence-dialog";

const task = {
  id: "53000000-0000-4000-8000-000000000001", ownerId: "53000000-0000-4000-8000-000000000002",
  goalId: "53000000-0000-4000-8000-000000000003", planVersionId: "53000000-0000-4000-8000-000000000004",
  title: "提交证据", action: "记录结果", doneCriteria: "证据已记录", evidenceType: "file_metadata" as const,
  estimateMinutes: 20, actualMinutes: null, dueAt: null, dependencyIds: [], status: "doing" as const,
  createdAt: "2026-09-17T08:00:00+08:00", updatedAt: "2026-09-17T08:00:00+08:00", version: 1,
};

afterEach(cleanup);

it("submits file metadata without reading file bytes", async () => {
  const user = userEvent.setup();
  const onSubmit = vi.fn();
  const file = new File(["private contents"], "result.txt", { type: "text/plain" });
  const textSpy = vi.spyOn(file, "text");
  const bytesSpy = vi.spyOn(file, "arrayBuffer");
  render(<EvidenceDialog task={task} disabled={false} onCancel={vi.fn()} onSubmit={onSubmit} />);

  fireEvent.change(screen.getByLabelText("选择证据文件"), { target: { files: [file] } });
  await user.click(screen.getByRole("button", { name: "确认完成并保存证据" }));

  expect(onSubmit).toHaveBeenCalledWith({ type: "file_metadata", fileName: "result.txt", fileSize: file.size, mimeType: "text/plain" });
  expect(textSpy).not.toHaveBeenCalled();
  expect(bytesSpy).not.toHaveBeenCalled();
});

it.each([
  ["text", "文字说明"],
  ["check_answer", "检查答案"],
  ["user_declaration", "用户确认"],
] as const)("submits %s evidence as trimmed text", async (evidenceType, label) => {
  const user = userEvent.setup();
  const onSubmit = vi.fn();
  render(<EvidenceDialog task={{ ...task, evidenceType }} disabled={false} onCancel={vi.fn()} onSubmit={onSubmit} />);

  await user.type(screen.getByLabelText(label), "  已核对完成  ");
  await user.click(screen.getByRole("button", { name: "确认完成并保存证据" }));
  expect(onSubmit).toHaveBeenCalledWith({ type: evidenceType, text: "已核对完成" });
});
