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
import { HostKeyVerifier } from "./host-key-verifier.js";

export interface TunnelInfo {
  localPort: number;
  close: () => void;
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

  const sshOptions: SshOptions = {
    host: sshConfig.hostname,
    port: sshConfig.port,
    username: sshConfig.user,
    readyTimeout: 10000,
    keepaliveInterval: env.SSH_KEEPALIVE_INTERVAL_MS,
    keepaliveCountMax: 3,
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

  const serverOptions: ServerOptions = { host: "127.0.0.1", port: 0 };
  const forwardOptions: ForwardOptions = { dstAddr: env.DB_HOST, dstPort: env.DB_PORT };

  const [server, client] = await createTunnel(
    { autoClose: false, reconnectOnError: false },
    serverOptions,
    sshOptions,
    forwardOptions,
  );

  client.on("error", (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Fatal: SSH tunnel error after connection: ${message}`);
    process.exit(1);
  });

  const addr = server.address() as net.AddressInfo;
  console.error(`SSH tunnel established on local port ${addr.port}`);

  return {
    localPort: addr.port,
    close: () => {
      server.close();
      client.end();
    },
  };
}
