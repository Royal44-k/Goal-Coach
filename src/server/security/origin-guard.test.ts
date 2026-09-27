import { describe, expect, it } from "vitest";
import { assertLocalMutationOrigin } from "./origin-guard";

const request = (method: string, origin?: string) => new Request(
  "http://127.0.0.1:3000/api/goals",
  { method, headers: origin === undefined ? undefined : { origin } },
);

describe("assertLocalMutationOrigin", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "allows canonical local origin for %s",
    (method) => expect(() => assertLocalMutationOrigin(
      request(method, "http://127.0.0.1:3000"),
    )).not.toThrow(),
  );

  it.each([
    undefined,
    "null",
    "http://localhost:3000",
    "https://127.0.0.1:3000",
    "http://127.0.0.1:3001",
    "https://malicious.example",
  ])("rejects non-canonical mutation origin %s", (origin) => {
    expect(() => assertLocalMutationOrigin(request("POST", origin))).toThrowError(
      expect.objectContaining({ code: "ORIGIN_REJECTED" }),
    );
  });

  it("does not require an Origin header for a read-only request", () => {
    expect(() => assertLocalMutationOrigin(request("GET"))).not.toThrow();
  });
});
