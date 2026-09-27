import { describe, expect, it } from "vitest";

import { validateEvidenceShape, EvidenceSubmissionSchema } from "./evidence";

it("accepts only typed text or metadata submissions without bytes or mixed fields", () => {
  for (const type of ["text", "check_answer", "user_declaration"])
    expect(EvidenceSubmissionSchema.parse({ type, text: " 内容 " })).toEqual({ type, text: "内容" });
  expect(EvidenceSubmissionSchema.safeParse({ type: "file_metadata", fileName: "a.txt", fileSize: 0, mimeType: "text/plain" }).success).toBe(true);
  for (const value of [{ type: "text", text: " " }, { type: "text", text: "ok", fileName: "a" }, { type: "file_metadata", fileName: "a", fileSize: 1, mimeType: "x", bytes: "secret" }])
    expect(EvidenceSubmissionSchema.safeParse(value).success).toBe(false);
});

describe("validateEvidenceShape", () => {
  it.each([
    ["text", { text: "完成了第一章笔记" }],
    ["check_answer", { text: "是，三个检查项都通过" }],
    ["user_declaration", { text: "我确认已完成" }],
    [
      "file_metadata",
      { fileName: "report.pdf", fileSize: 1200, mimeType: "application/pdf" },
    ],
  ] as const)("accepts the canonical %s evidence form", (type, value) => {
    expect(validateEvidenceShape(type, value)).toBe(true);
  });

  it.each([
    ["file_metadata", { content: "raw file" }],
    ["file_metadata", { fileName: "report.pdf", fileSize: -1, mimeType: "application/pdf" }],
    ["file_metadata", { fileName: "report.pdf", fileSize: 1200, mimeType: "" }],
    ["text", { text: "完成", content: "extra" }],
    ["text", { text: "  " }],
    ["check_answer", { answer: "yes" }],
    ["user_declaration", null],
  ] as const)("rejects incompatible or malformed %s evidence", (type, value) => {
    expect(validateEvidenceShape(type, value)).toBe(false);
  });
});
