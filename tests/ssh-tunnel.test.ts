import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.mock("tunnel-ssh", () => ({ createTunnel: vi.fn() }));
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  statSync: vi.fn(),
}));
vi.mock("../src/host-key-verifier.js", () => {
  function MockHostKeyVerifier(this: { verifyHostKey: ReturnType<typeof vi.fn> }) {
    this.verifyHostKey = vi.fn().mockReturnValue({ verified: true, reason: "ok" });
  }
  return { HostKeyVerifier: vi.fn(MockHostKeyVerifier) };
});
vi.mock("../src/database.js", () => ({
  createDatabasePool: vi.fn(),
}));

import { buildSshTunnel, setupSshTunnelListeners } from "../src/ssh-tunnel.js";
import { createTunnel } from "tunnel-ssh";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { EventEmitter } from "node:events";
import type { Env } from "../src/config.js";
import type { SshHostConfig } from "../src/config.js";
import { HostKeyVerifier } from "../src/host-key-verifier.js";
import { createDatabasePool } from "../src/database.js";

function makeMocks(port = 54321) {
  const mockServer = { address: vi.fn(() => ({ port })), close: vi.fn() };
  const mockClient = { on: vi.fn(), end: vi.fn() };
  return { mockServer, mockClient };
}

function makeFakeTunnel(initialPort = 54321) {
  const emitter = new EventEmitter();
  return {
    localPort: initialPort,
    close: vi.fn(),
    on: (event: string, listener: (...args: any[]) => void) =>
      emitter.on(event, listener),
    _emit: (event: string, ...args: any[]) => emitter.emit(event, ...args),
  };
}

const baseEnv: Env = {
  ALLOWED_TOOLS: undefined,
  DB_HOST: "rds.internal",
  DB_PORT: 5432,
  DB_NAME: "db",
  DB_USER: "u",
  DB_PASSWORD: "p",
  DB_READ_ONLY: true,
  DB_SSL: false,
  DB_MAX_ROWS: 1000,
  DB_SSL_CA: undefined,
  DB_SSL_REJECT_UNAUTHORIZED: true,
  DB_CONNECTION_POOL_SIZE: 5,
  DB_CONNECTION_TIMEOUT_MS: 10000,
  DB_QUERY_TIMEOUT_SECONDS: 15,
  SSH_STRICT_HOST_KEY_CHECKING: true,
  SSH_PASSWORD: undefined,
  SSH_KEEPALIVE_INTERVAL_MS: undefined,
  SSH_KEEPALIVE_COUNT_MAX: 3,
  SSH_TRUST_ON_FIRST_USE: true,
  SSH_KNOWN_HOSTS_PATH: undefined,
  SSH_MAX_RECONNECT_ATTEMPTS: 5,
  DB_POOL_DRAIN_TIMEOUT_MS: 5000,
};

const baseSshConfig: SshHostConfig = {
  hostname: "bastion.example.com",
  user: "ubuntu",
  port: 22,
  strictHostKeyChecking: true,
};

let mockServer: ReturnType<typeof makeMocks>["mockServer"];
let mockClient: ReturnType<typeof makeMocks>["mockClient"];
const fakeBuffer = Buffer.from("key");

beforeEach(() => {
  vi.clearAllMocks();
  const mocks = makeMocks();
  mockServer = mocks.mockServer;
  mockClient = mocks.mockClient;
  vi.mocked(createTunnel).mockResolvedValue([mockServer as any, mockClient as any]);
  vi.mocked(fs.existsSync).mockReturnValue(true);
  vi.mocked(fs.readFileSync).mockReturnValue(fakeBuffer);
  vi.mocked(fs.statSync).mockReturnValue({ mode: 0o100600 } as fs.Stats);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildSshTunnel", () => {
  it("returns null when sshConfig is null", async () => {
    const result = await buildSshTunnel(baseEnv, null);
    expect(result).toBeNull();
    expect(createTunnel).not.toHaveBeenCalled();
  });

  it("throws when identity file does not exist", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const config: SshHostConfig = { ...baseSshConfig, identityFile: "/missing/key" };
    expect(buildSshTunnel(baseEnv, config)).rejects.toThrow(
      /SSH identity file not found/,
    );
  });

  it("reads identity file when it exists", async () => {
    const config: SshHostConfig = {
      ...baseSshConfig,
      identityFile: "/home/user/.ssh/id_rsa",
    };
    await buildSshTunnel(baseEnv, config);
    expect(fs.readFileSync).toHaveBeenCalledWith("/home/user/.ssh/id_rsa");
  });

  it("passes privateKey to createTunnel sshOptions", async () => {
    const config: SshHostConfig = {
      ...baseSshConfig,
      identityFile: "/home/user/.ssh/id_rsa",
    };
    await buildSshTunnel(baseEnv, config);
    const [, , sshOptions] = vi.mocked(createTunnel).mock.calls[0];
    expect((sshOptions as any).privateKey).toBe(fakeBuffer);
  });

  it("does not check fs when identityFile is undefined", async () => {
    const config: SshHostConfig = { ...baseSshConfig, identityFile: undefined };
    await buildSshTunnel(baseEnv, config);
    expect(fs.existsSync).not.toHaveBeenCalled();
    expect(fs.readFileSync).not.toHaveBeenCalled();
  });

  it("sets hostVerifier to always-true when strictHostKeyChecking=false", async () => {
    const config: SshHostConfig = { ...baseSshConfig, strictHostKeyChecking: false };
    await buildSshTunnel(baseEnv, config);
    const [, , sshOptions] = vi.mocked(createTunnel).mock.calls[0];
    expect(typeof (sshOptions as any).hostVerifier).toBe("function");
    expect((sshOptions as any).hostVerifier()).toBe(true);
  });

  it("sets hostVerifier with HostKeyVerifier when strictHostKeyChecking=true", async () => {
    const config: SshHostConfig = { ...baseSshConfig, strictHostKeyChecking: true };
    await buildSshTunnel(baseEnv, config);
    const [, , sshOptions] = vi.mocked(createTunnel).mock.calls[0];
    expect(typeof (sshOptions as any).hostVerifier).toBe("function");
  });

  it("calls createTunnel with { autoClose: false, reconnectOnError: false }", async () => {
    await buildSshTunnel(baseEnv, baseSshConfig);
    const [tunnelOptions] = vi.mocked(createTunnel).mock.calls[0];
    expect(tunnelOptions).toEqual({ autoClose: false, reconnectOnError: false });
  });

  it("calls createTunnel with { host: '127.0.0.1', port: 0 } serverOptions", async () => {
    await buildSshTunnel(baseEnv, baseSshConfig);
    const [, serverOptions] = vi.mocked(createTunnel).mock.calls[0];
    expect(serverOptions).toEqual({ host: "127.0.0.1", port: 0 });
  });

  it("calls createTunnel with correct forwardOptions from env", async () => {
    await buildSshTunnel(baseEnv, baseSshConfig);
    const [, , , forwardOptions] = vi.mocked(createTunnel).mock.calls[0];
    expect(forwardOptions).toEqual({ dstAddr: "rds.internal", dstPort: 5432 });
  });

  it("sshOptions has correct host/port/username/readyTimeout", async () => {
    await buildSshTunnel(baseEnv, baseSshConfig);
    const [, , sshOptions] = vi.mocked(createTunnel).mock.calls[0];
    expect((sshOptions as any).host).toBe("bastion.example.com");
    expect((sshOptions as any).port).toBe(22);
    expect((sshOptions as any).username).toBe("ubuntu");
    expect((sshOptions as any).readyTimeout).toBe(10000);
  });

  it("returns localPort from server.address().port", async () => {
    const result = await buildSshTunnel(baseEnv, baseSshConfig);
    expect(result!.localPort).toBe(54321);
  });

  it("returns close function", async () => {
    const result = await buildSshTunnel(baseEnv, baseSshConfig);
    expect(typeof result!.close).toBe("function");
  });

  it("close() calls server.close() and client.end()", async () => {
    const result = await buildSshTunnel(baseEnv, baseSshConfig);
    result!.close();
    expect(mockServer.close).toHaveBeenCalledOnce();
    expect(mockClient.end).toHaveBeenCalledOnce();
  });

  it("attaches 'error' listener on SSH client", async () => {
    await buildSshTunnel(baseEnv, baseSshConfig);
    expect(mockClient.on).toHaveBeenCalledWith("error", expect.any(Function));
  });

  it("passes passphrase to sshOptions when SSH_KEY_PASSPHRASE is set", async () => {
    const env = { ...baseEnv, SSH_KEY_PASSPHRASE: "my-secret" };
    await buildSshTunnel(env, baseSshConfig);
    const [, , sshOptions] = vi.mocked(createTunnel).mock.calls[0];
    expect((sshOptions as any).passphrase).toBe("my-secret");
  });

  it("does not set passphrase on sshOptions when SSH_KEY_PASSPHRASE is undefined", async () => {
    await buildSshTunnel(baseEnv, baseSshConfig);
    const [, , sshOptions] = vi.mocked(createTunnel).mock.calls[0];
    expect((sshOptions as any).passphrase).toBeUndefined();
  });

  it("client error handler logs error message", async () => {
    const consoleSpy = vi.spyOn(console, "error");
    await buildSshTunnel(baseEnv, baseSshConfig);
    const errorCall = mockClient.on.mock.calls.find((c) => c[0] === "error");
    expect(errorCall).toBeDefined();
    const handler = errorCall![1] as Function;
    handler(new Error("ssh broke"));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("ssh broke"));
  });

  it("should pass password to sshOptions when SSH_PASSWORD is set", async () => {
    const env = { ...baseEnv, SSH_PASSWORD: "secret123" };
    await buildSshTunnel(env, baseSshConfig);
    const [, , sshOptions] = vi.mocked(createTunnel).mock.calls[0];
    expect((sshOptions as any).password).toBe("secret123");
  });

  it("should pass keepaliveInterval to sshOptions", async () => {
    const env = { ...baseEnv, SSH_KEEPALIVE_INTERVAL_MS: 5000 };
    await buildSshTunnel(env, baseSshConfig);
    const [, , sshOptions] = vi.mocked(createTunnel).mock.calls[0];
    expect((sshOptions as any).keepaliveInterval).toBe(5000);
    expect((sshOptions as any).keepaliveCountMax).toBe(3);
  });

  it("should pass custom SSH_KEEPALIVE_COUNT_MAX to sshOptions", async () => {
    const env = {
      ...baseEnv,
      SSH_KEEPALIVE_INTERVAL_MS: 10000,
      SSH_KEEPALIVE_COUNT_MAX: 5,
    };
    await buildSshTunnel(env, baseSshConfig);
    const [, , sshOptions] = vi.mocked(createTunnel).mock.calls[0];
    expect((sshOptions as any).keepaliveCountMax).toBe(5);
  });

  it("should warn when identity file has loose permissions", async () => {
    const consoleSpy = vi.spyOn(console, "error");
    vi.mocked(fs.statSync).mockReturnValue({ mode: 0o100644 } as fs.Stats);
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });

    const config: SshHostConfig = {
      ...baseSshConfig,
      identityFile: "/home/user/.ssh/id_rsa",
    };
    await buildSshTunnel(baseEnv, config);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("WARNING"));
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("should not warn when identity file has correct permissions", async () => {
    const consoleSpy = vi.spyOn(console, "error");
    vi.mocked(fs.statSync).mockReturnValue({ mode: 0o100600 } as fs.Stats);
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });

    const config: SshHostConfig = {
      ...baseSshConfig,
      identityFile: "/home/user/.ssh/id_rsa",
    };
    await buildSshTunnel(baseEnv, config);

    expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining("WARNING"));
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("should use HostKeyVerifier when strictHostKeyChecking=true", async () => {
    const env = {
      ...baseEnv,
      SSH_TRUST_ON_FIRST_USE: true,
      SSH_KNOWN_HOSTS_PATH: "/tmp/known_hosts",
    };
    const config = { ...baseSshConfig, strictHostKeyChecking: true };
    await buildSshTunnel(env, config);
    expect(HostKeyVerifier).toHaveBeenCalledWith("/tmp/known_hosts", true);
    const [, , sshOptions] = vi.mocked(createTunnel).mock.calls[0];
    expect(typeof (sshOptions as any).hostVerifier).toBe("function");
  });

  it("should not use HostKeyVerifier when strictHostKeyChecking=false", async () => {
    const env = { ...baseEnv, SSH_TRUST_ON_FIRST_USE: true };
    const config = { ...baseSshConfig, strictHostKeyChecking: false };
    await buildSshTunnel(env, config);
    const [, , sshOptions] = vi.mocked(createTunnel).mock.calls[0];
    expect((sshOptions as any).hostVerifier("anything")).toBe(true);
  });

  it("returns TunnelInfo with on() method for events", async () => {
    const result = await buildSshTunnel(baseEnv, baseSshConfig);
    expect(typeof result!.on).toBe("function");
  });

  it("registers close handler on SSH client", async () => {
    await buildSshTunnel(baseEnv, baseSshConfig);
    expect(mockClient.on).toHaveBeenCalledWith("close", expect.any(Function));
  });

  it("does not set keepaliveCountMax when SSH_KEEPALIVE_INTERVAL_MS is undefined", async () => {
    await buildSshTunnel(baseEnv, baseSshConfig);
    const [, , sshOptions] = vi.mocked(createTunnel).mock.calls[0];
    expect((sshOptions as any).keepaliveCountMax).toBeUndefined();
  });

  it("uses default ~/.ssh/known_hosts when SSH_KNOWN_HOSTS_PATH is undefined", async () => {
    const expectedPath = path.join(os.homedir(), ".ssh", "known_hosts");
    await buildSshTunnel(baseEnv, baseSshConfig);
    expect(HostKeyVerifier).toHaveBeenCalledWith(expectedPath, expect.anything());
  });

  it("hostVerifier returns false and logs reason when verification fails", async () => {
    const consoleSpy = vi.spyOn(console, "error");
    const config = { ...baseSshConfig, strictHostKeyChecking: true };
    await buildSshTunnel(baseEnv, config);

    const [, , sshOptions] = vi.mocked(createTunnel).mock.calls[0];
    const hostVerifier = (sshOptions as any).hostVerifier as (key: string) => boolean;

    const mockInstance = vi.mocked(HostKeyVerifier).mock.instances[0] as any;
    mockInstance.verifyHostKey.mockReturnValue({
      verified: false,
      reason: "key mismatch",
    });

    const result = hostVerifier(Buffer.from("some-key").toString("hex"));

    expect(result).toBe(false);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("key mismatch"));
  });

  it("skips identity file permission check on Windows", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const config: SshHostConfig = {
      ...baseSshConfig,
      identityFile: "/home/user/.ssh/id_rsa",
    };
    await buildSshTunnel(baseEnv, config);
    expect(fs.statSync).not.toHaveBeenCalled();
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      configurable: true,
    });
  });
});

describe("reconnect on client close", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function getCloseHandler(): Function {
    const closeCall = mockClient.on.mock.calls.find((c) => c[0] === "close");
    if (!closeCall) throw new Error("close handler not registered");
    return closeCall[1] as Function;
  }

  it("logs 'Reconnection disabled' and calls process.exit(1) when SSH_MAX_RECONNECT_ATTEMPTS is 0", async () => {
    const consoleSpy = vi.spyOn(console, "error");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
    const env = { ...baseEnv, SSH_MAX_RECONNECT_ATTEMPTS: 0 };
    await buildSshTunnel(env, baseSshConfig);
    getCloseHandler()();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Reconnection disabled"),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("emits 'reconnected' with { oldPort, newPort } on successful reconnect", async () => {
    const newServer = { address: vi.fn(() => ({ port: 99999 })), close: vi.fn() };
    const newClient = { on: vi.fn(), end: vi.fn() };
    vi.mocked(createTunnel)
      .mockResolvedValueOnce([mockServer as any, mockClient as any])
      .mockResolvedValueOnce([newServer as any, newClient as any]);

    const result = await buildSshTunnel(baseEnv, baseSshConfig);
    const reconnectedHandler = vi.fn();
    result!.on("reconnected", reconnectedHandler);

    getCloseHandler()();
    await vi.runAllTimersAsync();

    expect(reconnectedHandler).toHaveBeenCalledWith({ oldPort: 54321, newPort: 99999 });
  });

  it("emits 'failed' after exhausting all reconnect attempts", async () => {
    vi.mocked(createTunnel)
      .mockResolvedValueOnce([mockServer as any, mockClient as any])
      .mockRejectedValue(new Error("refused"));

    const env = { ...baseEnv, SSH_MAX_RECONNECT_ATTEMPTS: 2 };
    const result = await buildSshTunnel(env, baseSshConfig);
    const failedHandler = vi.fn();
    result!.on("failed", failedHandler);

    getCloseHandler()();
    await vi.runAllTimersAsync();

    expect(failedHandler).toHaveBeenCalledWith(expect.any(Error));
  });

  it("logs each failed reconnect attempt with error message", async () => {
    const consoleSpy = vi.spyOn(console, "error");
    vi.mocked(createTunnel)
      .mockResolvedValueOnce([mockServer as any, mockClient as any])
      .mockRejectedValue(new Error("timed out"));

    const env = { ...baseEnv, SSH_MAX_RECONNECT_ATTEMPTS: 2 };
    await buildSshTunnel(env, baseSshConfig);

    getCloseHandler()();
    await vi.runAllTimersAsync();

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Reconnect attempt"));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("timed out"));
  });

  it("registers close and error listeners on new client after successful reconnect", async () => {
    const newServer = { address: vi.fn(() => ({ port: 99999 })), close: vi.fn() };
    const newClient = { on: vi.fn(), end: vi.fn() };
    vi.mocked(createTunnel)
      .mockResolvedValueOnce([mockServer as any, mockClient as any])
      .mockResolvedValueOnce([newServer as any, newClient as any]);

    await buildSshTunnel(baseEnv, baseSshConfig);

    getCloseHandler()();
    await vi.runAllTimersAsync();

    expect(newClient.on).toHaveBeenCalledWith("close", expect.any(Function));
    expect(newClient.on).toHaveBeenCalledWith("error", expect.any(Function));
  });

  it("emits 'reconnected' when SSH_MAX_RECONNECT_ATTEMPTS is -1 (unlimited)", async () => {
    const newServer = { address: vi.fn(() => ({ port: 99999 })), close: vi.fn() };
    const newClient = { on: vi.fn(), end: vi.fn() };
    vi.mocked(createTunnel)
      .mockResolvedValueOnce([mockServer as any, mockClient as any])
      .mockResolvedValueOnce([newServer as any, newClient as any]);

    const env = { ...baseEnv, SSH_MAX_RECONNECT_ATTEMPTS: -1 };
    const result = await buildSshTunnel(env, baseSshConfig);
    const reconnectedHandler = vi.fn();
    result!.on("reconnected", reconnectedHandler);

    getCloseHandler()();
    await vi.runAllTimersAsync();

    expect(reconnectedHandler).toHaveBeenCalled();
  });

  it("ignores concurrent close events (reconnecting flag)", async () => {
    const newServer = { address: vi.fn(() => ({ port: 99999 })), close: vi.fn() };
    const newClient = { on: vi.fn(), end: vi.fn() };
    vi.mocked(createTunnel)
      .mockResolvedValueOnce([mockServer as any, mockClient as any])
      .mockResolvedValueOnce([newServer as any, newClient as any]);

    await buildSshTunnel(baseEnv, baseSshConfig);
    const closeHandler = getCloseHandler();

    // Fire two close events before the first reconnect completes
    closeHandler();
    closeHandler();
    await vi.runAllTimersAsync();

    // createTunnel: 1 initial + 1 reconnect (not 2 reconnects)
    expect(createTunnel).toHaveBeenCalledTimes(2);
  });

  it("caps exponential backoff delay at 30000ms", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    vi.mocked(createTunnel)
      .mockResolvedValueOnce([mockServer as any, mockClient as any])
      .mockRejectedValue(new Error("refused"));

    const env = { ...baseEnv, SSH_MAX_RECONNECT_ATTEMPTS: 8 };
    await buildSshTunnel(env, baseSshConfig);

    getCloseHandler()();
    await vi.runAllTimersAsync();

    // Collect the delays passed to setTimeout during reconnect
    const delays = setTimeoutSpy.mock.calls
      .map((c) => c[1])
      .filter((d): d is number => typeof d === "number" && d >= 1000);

    // All delays should be <= 30000
    for (const delay of delays) {
      expect(delay).toBeLessThanOrEqual(30000);
    }
    // At least one delay should be 30000 (the cap) given 8 attempts
    expect(delays).toContain(30000);
    setTimeoutSpy.mockRestore();
  });

  it("allows a second reconnect after a successful first reconnect", async () => {
    const newServer1 = { address: vi.fn(() => ({ port: 77777 })), close: vi.fn() };
    const newClient1 = { on: vi.fn(), end: vi.fn() };
    const newServer2 = { address: vi.fn(() => ({ port: 88888 })), close: vi.fn() };
    const newClient2 = { on: vi.fn(), end: vi.fn() };
    vi.mocked(createTunnel)
      .mockResolvedValueOnce([mockServer as any, mockClient as any])
      .mockResolvedValueOnce([newServer1 as any, newClient1 as any])
      .mockResolvedValueOnce([newServer2 as any, newClient2 as any]);

    const result = await buildSshTunnel(baseEnv, baseSshConfig);
    const reconnectedHandler = vi.fn();
    result!.on("reconnected", reconnectedHandler);

    // First reconnect
    getCloseHandler()();
    await vi.runAllTimersAsync();
    expect(reconnectedHandler).toHaveBeenCalledWith({ oldPort: 54321, newPort: 77777 });

    // Trigger close on the NEW client to start a second reconnect
    const newCloseCall = newClient1.on.mock.calls.find((c) => c[0] === "close");
    expect(newCloseCall).toBeDefined();
    newCloseCall![1]();
    await vi.runAllTimersAsync();

    expect(reconnectedHandler).toHaveBeenCalledTimes(2);
    expect(reconnectedHandler).toHaveBeenCalledWith({ oldPort: 77777, newPort: 88888 });
  });
});

describe("setupSshTunnelListeners", () => {
  let tunnel: ReturnType<typeof makeFakeTunnel>;
  let oldPool: { end: ReturnType<typeof vi.fn> };
  let poolRef: { current: any };

  beforeEach(() => {
    tunnel = makeFakeTunnel();
    oldPool = { end: vi.fn().mockResolvedValue(undefined) };
    poolRef = { current: oldPool };
    vi.mocked(createDatabasePool).mockResolvedValue({} as any);
  });

  it("logs port change on 'reconnected' event", () => {
    const consoleSpy = vi.spyOn(console, "error");
    setupSshTunnelListeners(tunnel as any, poolRef, baseEnv);
    tunnel._emit("reconnected", { oldPort: 100, newPort: 200 });
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("100"));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("200"));
  });

  it("calls createDatabasePool with updated localPort on 'reconnected'", () => {
    setupSshTunnelListeners(tunnel as any, poolRef, baseEnv);
    tunnel._emit("reconnected", { oldPort: 100, newPort: 200 });
    expect(createDatabasePool).toHaveBeenCalledWith(
      baseEnv,
      expect.objectContaining({ localPort: 200 }),
    );
  });

  it("updates poolRef.current to new pool on 'reconnected'", async () => {
    const newPool = { end: vi.fn() };
    vi.mocked(createDatabasePool).mockResolvedValue(newPool as any);
    setupSshTunnelListeners(tunnel as any, poolRef, baseEnv);
    tunnel._emit("reconnected", { oldPort: 100, newPort: 200 });
    await new Promise((r) => setImmediate(r));
    expect(poolRef.current).toBe(newPool);
  });

  it("drains old pool on 'reconnected'", async () => {
    setupSshTunnelListeners(tunnel as any, poolRef, baseEnv);
    tunnel._emit("reconnected", { oldPort: 100, newPort: 200 });
    await new Promise((r) => setImmediate(r));
    expect(oldPool.end).toHaveBeenCalled();
  });

  it("logs 'Pool drain timeout' and force-closes when drain times out", async () => {
    vi.useFakeTimers();
    try {
      const consoleSpy = vi.spyOn(console, "error");
      oldPool.end = vi.fn().mockReturnValue(new Promise(() => {})); // never resolves
      setupSshTunnelListeners(tunnel as any, poolRef, baseEnv);
      tunnel._emit("reconnected", { oldPort: 100, newPort: 200 });
      await vi.advanceTimersByTimeAsync(baseEnv.DB_POOL_DRAIN_TIMEOUT_MS + 1);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Pool drain timeout"),
      );
      expect(oldPool.end).toHaveBeenCalledTimes(2); // once in race, once force-close
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not log 'Pool drain timeout' when DB_POOL_DRAIN_TIMEOUT_MS is 0", async () => {
    vi.useFakeTimers();
    try {
      const consoleSpy = vi.spyOn(console, "error");
      const env = { ...baseEnv, DB_POOL_DRAIN_TIMEOUT_MS: 0 };
      oldPool.end = vi.fn().mockReturnValue(new Promise(() => {}));
      setupSshTunnelListeners(tunnel as any, poolRef, env);
      tunnel._emit("reconnected", { oldPort: 100, newPort: 200 });
      await vi.advanceTimersByTimeAsync(10);
      expect(consoleSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("Pool drain timeout"),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs failure and calls process.exit(1) on 'failed' event", () => {
    const consoleSpy = vi.spyOn(console, "error");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
    setupSshTunnelListeners(tunnel as any, poolRef, baseEnv);
    tunnel._emit("failed", new Error("permanent failure"));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("permanent failure"));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("does not replace poolRef.current when createDatabasePool rejects", async () => {
    // createDatabasePool rejection in the async event handler is currently unhandled,
    // so we catch it here to prevent vitest from failing on unhandled rejection.
    const unhandled: Error[] = [];
    const handler = (err: Error) => unhandled.push(err);
    process.on("unhandledRejection", handler);

    vi.mocked(createDatabasePool).mockRejectedValueOnce(new Error("connection failed"));
    setupSshTunnelListeners(tunnel as any, poolRef, baseEnv);
    tunnel._emit("reconnected", { oldPort: 100, newPort: 200 });
    await new Promise((r) => setImmediate(r));

    // poolRef.current should still be the old pool (createDatabasePool threw before assignment)
    expect(poolRef.current).toBe(oldPool);
    expect(unhandled[0]?.message).toBe("connection failed");
    process.off("unhandledRejection", handler);
  });

  it("handles oldPool.end() rejection without crashing", async () => {
    oldPool.end = vi.fn().mockRejectedValue(new Error("pool end failed"));
    setupSshTunnelListeners(tunnel as any, poolRef, baseEnv);
    tunnel._emit("reconnected", { oldPort: 100, newPort: 200 });
    // Should not throw an unhandled rejection
    await new Promise((r) => setImmediate(r));
    expect(oldPool.end).toHaveBeenCalled();
  });
});
