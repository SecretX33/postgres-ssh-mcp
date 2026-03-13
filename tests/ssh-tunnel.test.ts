import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.mock("tunnel-ssh", () => ({ createTunnel: vi.fn() }));
vi.mock("node:fs", () => ({ existsSync: vi.fn(), readFileSync: vi.fn() }));

import { buildSshTunnel } from "../src/ssh-tunnel.js";
import { createTunnel } from "tunnel-ssh";
import * as fs from "node:fs";
import type { Env } from "../src/config.js";
import type { SshHostConfig } from "../src/config.js";

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
  SSH_STRICT_HOST_KEY_CHECKING: true,
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

  it("does not set hostVerifier when strictHostKeyChecking=true", async () => {
    const config: SshHostConfig = { ...baseSshConfig, strictHostKeyChecking: true };
    await buildSshTunnel(baseEnv, config);
    const [, , sshOptions] = vi.mocked(createTunnel).mock.calls[0];
    expect((sshOptions as any).hostVerifier).toBeUndefined();
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

  it("client error handler calls process.exit(1)", async () => {
    await buildSshTunnel(baseEnv, baseSshConfig);
    const errorCall = mockClient.on.mock.calls.find((c) => c[0] === "error");
    expect(errorCall).toBeDefined();
    const handler = errorCall![1] as Function;

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((): never => {
      throw new Error("process.exit called");
    });
    expect(() => handler(new Error("ssh broke"))).toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
