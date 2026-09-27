/* Test-process preload only. Never loaded by production application entrypoints. */
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Node preload must be CommonJS.
const net = require("node:net");
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const normalized = Array.isArray(args[0]) ? args[0] : args;
  const first = normalized[0];
  const options = first && typeof first === "object" ? first : null;
  const host = options?.host ?? (typeof normalized[1] === "string" ? normalized[1] : "localhost");
  // Local IPC is used by the TS runner; remote TCP is rejected before DNS/connect.
  const pipe = options?.path ?? (typeof first === "string" && !/^\d+$/.test(first) ? first : null);
  if (!pipe && !["localhost", "127.0.0.1", "::1"].includes(host)) {
    console.error("E2E_EXTERNAL_NETWORK_BLOCKED");
    throw new Error("E2E_EXTERNAL_NETWORK_BLOCKED");
  }
  return originalConnect.apply(this, args);
};
