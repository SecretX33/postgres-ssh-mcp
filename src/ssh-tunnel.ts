import { type Env, type SshHostConfig } from "./config.js";
import {
  createTunnel,
  type ForwardOptions,
  type ServerOptions,
  type SshOptions,
} from "tunnel-ssh";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import * as os from "node:os";
import { EventEmitter } from "node:events";
import { HostKeyVerifier } from "./host-key-verifier.js";
import { createDatabasePool } from "./database.js";
import type { Pool } from "pg";

export interface TunnelEvents {
  reconnected: [{ oldPort: number; newPort: number }];
  failed: [Error];
}

export interface TunnelInfo {
  localPort: number;
  close: () => void;
  on<K extends keyof TunnelEvents>(
    event: K,
    listener: (...args: TunnelEvents[K]) => void,
  ): void;
}

export async function buildSshTunnel(
  env: Env,
  sshConfig: SshHostConfig | null,
): Promise<TunnelInfo | null> {
  if (!sshConfig) {
    console.error(`Connecting directly to Postgres at ${env.DB_HOST}:${env.DB_PORT}`);
    return null;
  }

  console.error(
    `Connecting to SSH bastion ${sshConfig.hostname}:${sshConfig.port} as ${sshConfig.user}...`,
  );

  const sshOptions = buildSshOptions(env, sshConfig);
  const serverOptions: ServerOptions = { host: "127.0.0.1", port: 0 };
  const forwardOptions: ForwardOptions = { dstAddr: env.DB_HOST, dstPort: env.DB_PORT };

  const [server, client] = await createTunnel(
    { autoClose: false, reconnectOnError: false },
    serverOptions,
    sshOptions,
    forwardOptions,
  );

  const addr = server.address() as net.AddressInfo;
  console.error(`SSH tunnel established on local port ${addr.port}`);

  const emitter = new EventEmitter();
  let currentPort = addr.port;
  let reconnecting = false;

  const reconnect = async () => {
    if (reconnecting) return;
    if (env.SSH_MAX_RECONNECT_ATTEMPTS === 0) {
      console.error("[SSH] Tunnel closed. Reconnection disabled.");
      process.exit(1);
    }
    reconnecting = true;
    const maxAttempts = env.SSH_MAX_RECONNECT_ATTEMPTS;
    let attempt = 0;

    while (maxAttempts === -1 || attempt < maxAttempts) {
      attempt++;
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
      console.error(
        `[SSH] Reconnecting (attempt ${attempt}${maxAttempts === -1 ? "" : `/${maxAttempts}`}) in ${delay}ms...`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));

      try {
        const newSshOptions = buildSshOptions(env, sshConfig);
        const [newServer, newClient] = await createTunnel(
          { autoClose: false, reconnectOnError: false },
          { host: "127.0.0.1", port: 0 },
          newSshOptions,
          forwardOptions,
        );

        const newAddr = newServer.address() as net.AddressInfo;
        const oldPort = currentPort;
        currentPort = newAddr.port;

        newClient.on("close", () => {
          console.error("[SSH] Tunnel connection closed");
          reconnect();
        });

        newClient.on("error", (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[SSH] Tunnel error: ${message}`);
        });

        console.error(`[SSH] Tunnel re-established on local port ${newAddr.port}`);
        reconnecting = false;
        emitter.emit("reconnected", { oldPort, newPort: newAddr.port });
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[SSH] Reconnect attempt ${attempt} failed: ${message}`);
      }
    }

    reconnecting = false;
    const error = new Error(
      `SSH tunnel reconnection failed after ${maxAttempts} attempts`,
    );
    emitter.emit("failed", error);
  };

  client.on("close", () => {
    console.error("[SSH] Tunnel connection closed");
    reconnect();
  });

  client.on("error", (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[SSH] Tunnel error: ${message}`);
  });

  return {
    localPort: addr.port,
    close: () => {
      server.close();
      client.end();
    },
    on: (event: string, listener: (...args: any[]) => void) => {
      emitter.on(event, listener);
    },
  };
}

function buildSshOptions(env: Env, sshConfig: SshHostConfig): SshOptions {
  const sshOptions: SshOptions = {
    host: sshConfig.hostname,
    port: sshConfig.port,
    username: sshConfig.user,
    readyTimeout: 10000,
    keepaliveInterval: env.SSH_KEEPALIVE_INTERVAL_MS,
    keepaliveCountMax: env.SSH_KEEPALIVE_INTERVAL_MS
      ? env.SSH_KEEPALIVE_COUNT_MAX
      : undefined,
  };

  if (sshConfig.identityFile) {
    if (!fs.existsSync(sshConfig.identityFile)) {
      throw new Error(`SSH identity file not found at ${sshConfig.identityFile}`);
    }
    if (process.platform !== "win32") {
      const stat = fs.statSync(sshConfig.identityFile);
      const mode = stat.mode & 0o777;
      if (mode & 0o077) {
        console.error(
          `WARNING: SSH identity file "${sshConfig.identityFile}" has permissions ${mode.toString(8)}. ` +
            `It should be 600 or 400. Other users may be able to read your private key.`,
        );
      }
    }
    sshOptions.privateKey = fs.readFileSync(sshConfig.identityFile);
  }

  if (env.SSH_KEY_PASSPHRASE) {
    sshOptions.passphrase = env.SSH_KEY_PASSPHRASE;
  }

  if (env.SSH_PASSWORD) {
    sshOptions.password = env.SSH_PASSWORD;
  }

  if (!sshConfig.strictHostKeyChecking) {
    sshOptions.hostVerifier = () => true;
  } else {
    const knownHostsPath =
      env.SSH_KNOWN_HOSTS_PATH ?? path.join(os.homedir(), ".ssh", "known_hosts");
    const verifier = new HostKeyVerifier(knownHostsPath, env.SSH_TRUST_ON_FIRST_USE);
    sshOptions.hostVerifier = (key: string) => {
      const publicKey = Buffer.from(key, "hex");
      const result = verifier.verifyHostKey(
        sshConfig.hostname,
        sshConfig.port,
        "ssh-rsa",
        publicKey,
      );
      if (!result.verified) {
        console.error(`[SSH] Host key verification failed: ${result.reason}`);
      }
      return result.verified;
    };
  }

  return sshOptions;
}

export function setupSshTunnelListeners(
  sshTunnel: TunnelInfo,
  poolRef: { current: Pool },
  env: Env,
) {
  sshTunnel.on("reconnected", async ({ oldPort, newPort }) => {
    console.error(`[SSH] Tunnel reconnected: port ${oldPort} → ${newPort}`);
    const oldPool = poolRef.current;

    poolRef.current = await createDatabasePool(env, {
      ...sshTunnel,
      localPort: newPort,
    });

    try {
      await Promise.race([
        oldPool.end(),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("Pool drain timeout")),
            env.POOL_DRAIN_TIMEOUT_MS,
          ),
        ),
      ]);
    } catch {
      if (env.POOL_DRAIN_TIMEOUT_MS > 0) {
        console.error("[DB] Pool drain timeout, forcing close");
      }
      oldPool.end().catch(() => {});
    }
  });

  sshTunnel.on("failed", (error) => {
    console.error(`[SSH] Tunnel reconnection failed permanently: ${error.message}`);
    process.exit(1);
  });
}
