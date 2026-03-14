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

import { buildSshTunnel } from "../src/ssh-tunnel.js";
import { createTunnel } from "tunnel-ssh";
import * as fs from "node:fs";
import type { Env } from "../src/config.js";
import type { SshHostConfig } from "../src/config.js";
import { HostKeyVerifier } from "../src/host-key-verifier.js";

function makeMocks(port = 54321) {
  const mockServer = { address: vi.fn(() => ({ port })), close: vi.fn() };
  const mockClient = { on: vi.fn(), end: vi.fn() };
  return { mockServer, mockClient };
}

const baseEnv: Env = {
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
  SSH_STRICT_HOST_KEY_CHECKING: true,
  SSH_PASSWORD: undefined,
  SSH_KEEPALIVE_INTERVAL_MS: 0,
  SSH_KEEPALIVE_COUNT_MAX: 3,
  SSH_TRUST_ON_FIRST_USE: true,
  SSH_KNOWN_HOSTS_PATH: undefined,
  SSH_MAX_RECONNECT_ATTEMPTS: 5,
  POOL_DRAIN_TIMEOUT_MS: 5000,
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
    const env = { ...baseEnv, SSH_KEEPALIVE_COUNT_MAX: 5 };
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
});
