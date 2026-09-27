import { describe, expect, it } from "vitest";
import { APP_ERROR_CODES, AppError, AppErrorCodeSchema, toSafeErrorResponse } from "./app-error";

it("keeps one strict public schema for every application error code", () => {
  expect(AppErrorCodeSchema.parse("VERSION_CONFLICT")).toBe("VERSION_CONFLICT");
  expect(AppErrorCodeSchema.safeParse("PRIVATE_UPSTREAM_ERROR").success).toBe(false);
  expect(APP_ERROR_CODES).toContain("DATABASE_ERROR");
});

describe("toSafeErrorResponse", () => {
  it("maps an app error to stable user copy without exposing its internal message", () => {
    const response = toSafeErrorResponse(
      new AppError("INVALID_TRANSITION", 409, "内部说明"),
    );

    expect(response).toEqual({
      code: "INVALID_TRANSITION",
      message: "当前状态不能执行此操作。",
    });
    expect(JSON.stringify(response)).not.toContain("内部说明");
  });

  it("never serializes detail even when a caller mislabels sensitive text as safe", () => {
    const error = new AppError(
      "VERSION_CONFLICT",
      409,
      "D:\\private\\goal.db 中的版本已变化",
      "API_KEY=secret at D:\\private\\goal.db",
    );

    expect(toSafeErrorResponse(error)).toEqual({
      code: "VERSION_CONFLICT",
      message: "内容已被更新，请刷新后重试。",
    });
    expect(JSON.stringify(toSafeErrorResponse(error))).not.toMatch(
      /API_KEY|secret|private|goal\.db/i,
    );
  });

  it("turns unknown thrown values into a fixed generic response", () => {
    const response = toSafeErrorResponse(
      new Error("API_KEY=secret at D:\\private\\goal.db"),
    );

    expect(response).toEqual({
      code: "DATABASE_ERROR",
      message: "暂时无法完成操作，请稍后重试。",
    });
    expect(JSON.stringify(response)).not.toMatch(/secret|private|goal\.db|stack/i);
  });
});
