import z from "zod";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const BooleanType = z.enum(["true", "false"]).transform((value) => value === "true");
const NonEmptyString = z.string().min(1);
const NonEmptyOptionalString = z.string().transform(convertEmptyToUndefined).optional();

function convertEmptyToUndefined<T>(value: T | null | undefined): T | undefined {
  return !value ? undefined : value;
}

export const EnvSchema = z
  .object({
    DB_HOST: NonEmptyString,
    DB_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
    DB_NAME: NonEmptyString,
    DB_USER: NonEmptyString,
    DB_PASSWORD: NonEmptyString,
    DB_READ_ONLY: BooleanType.default(true),
    DB_SSL: BooleanType.default(false),
    // Mode 1: SSH config file alias
    SSH_HOST: NonEmptyOptionalString,
    // Mode 2: explicit SSH connection
    SSH_HOSTNAME: NonEmptyOptionalString,
    SSH_USER: NonEmptyOptionalString,
    SSH_PORT: z.coerce.number().int().min(1).max(65535).optional(),
    SSH_STRICT_HOST_KEY_CHECKING: BooleanType.default(true),
    SSH_IDENTITY_FILE: NonEmptyOptionalString,
    SSH_KEY_PASSPHRASE: NonEmptyOptionalString,
  })
  .superRefine((data, ctx) => {
    const hasHost = data.SSH_HOST !== undefined;
    const hasHostname = data.SSH_HOSTNAME !== undefined;
    const hasUser = data.SSH_USER !== undefined;
    const hasPort = data.SSH_PORT !== undefined;
    const hasIdentityFile = data.SSH_IDENTITY_FILE !== undefined;

    // SSH_HOST must be used alone (no Mode 2 vars)
    if (hasHost && (hasHostname || hasUser || hasPort || hasIdentityFile)) {
      ctx.addIssue(
        "SSH_HOST cannot be combined with SSH_HOSTNAME, SSH_USER, SSH_PORT, or SSH_IDENTITY_FILE",
      );
    }

    // SSH_HOSTNAME and SSH_USER must come together
    if (!hasHost && hasHostname !== hasUser) {
      ctx.addIssue(
        "SSH_HOSTNAME and SSH_USER must both be provided together for Mode 2 configuration",
      );
    }

    // SSH_PORT and SSH_IDENTITY_FILE cannot be orphaned (require Mode 2)
    if (!hasHost && !hasHostname && !hasUser && (hasPort || hasIdentityFile)) {
      ctx.addIssue(
        "SSH_PORT and SSH_IDENTITY_FILE require SSH_HOSTNAME and SSH_USER to be set",
      );
    }
  });

export type Env = z.infer<typeof EnvSchema>;

export interface SshHostConfig {
  hostname: string;
  user: string;
  port: number;
  identityFile?: string;
  strictHostKeyChecking: boolean;
}

/**
 * Parse an SSH config file and return the connection config for the given host alias.
 * @param alias  The `Host` entry to look up (e.g. "my-bastion")
 * @param configPath  Path to the SSH config file (defaults to ~/.ssh/config)
 */
export function parseSshConfigFile(
  alias: string,
  configPath = path.join(os.homedir(), ".ssh", "config"),
): SshHostConfig {
  if (!fs.existsSync(configPath)) {
    throw new Error(`SSH tunnel enabled but SSH config file not found at ${configPath}`);
  }

  const content = fs.readFileSync(configPath, "utf-8");
  const lines = content.split(/\r?\n/);

  let inBlock = false;
  let hostname: string | undefined;
  let user: string | undefined;
  let port: number | undefined;
  let identityFile: string | undefined;
  let strictHostKeyChecking: boolean | undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const spaceIdx = trimmed.search(/\s/);
    if (spaceIdx === -1) continue;

    const key = trimmed.slice(0, spaceIdx).toLowerCase();
    const value = trimmed.slice(spaceIdx).trim();

    if (key === "host") {
      // Only match exact alias (SSH config supports patterns, we only need exact match)
      inBlock = value === alias;
      continue;
    }

    if (!inBlock) continue;

    switch (key) {
      case "hostname":
        hostname = value;
        break;
      case "user":
        user = value;
        break;
      case "port": {
        const parsed = parseInt(value, 10);
        if (!/^\d+$/.test(value) || isNaN(parsed) || parsed < 1 || parsed > 65535) {
          throw new Error(
            `Invalid Port value "${value}" for host "${alias}" in SSH config`,
          );
        }
        port = parsed;
        break;
      }
      case "identityfile":
        if (value.startsWith("~/")) {
          identityFile = path.join(os.homedir(), value.slice(2));
        } else {
          identityFile = value;
        }
        break;
      case "stricthostkeychecking":
        strictHostKeyChecking = !["no", "false"].includes(value.toLowerCase());
        break;
    }
  }

  if (!hostname)
    throw new Error(`Host "${alias}" not found in SSH config or missing HostName`);
  if (!user) throw new Error(`No User defined for host "${alias}" in SSH config`);

  return {
    hostname,
    user,
    port: port ?? 22,
    identityFile,
    strictHostKeyChecking: strictHostKeyChecking ?? true,
  };
}

/**
 * Resolve SSH connection config from validated env vars.
 * Mode 1 (SSH_HOST only): reads ~/.ssh/config using the alias
 * Mode 2 (SSH_HOSTNAME + SSH_USER): uses env vars directly
 * Mode 3 (no SSH vars): returns null for direct Postgres connection
 */
export function resolveSshConfig(env: Env, sshConfigPath?: string): SshHostConfig | null {
  if (env.SSH_HOST !== undefined) {
    // Mode 1: SSH config file lookup using alias
    return parseSshConfigFile(env.SSH_HOST, sshConfigPath);
  }
  if (env.SSH_HOSTNAME !== undefined && env.SSH_USER !== undefined) {
    // Mode 2: explicit env var configuration
    return {
      hostname: env.SSH_HOSTNAME,
      user: env.SSH_USER,
      port: env.SSH_PORT ?? 22,
      identityFile: env.SSH_IDENTITY_FILE?.startsWith("~/")
        ? path.join(os.homedir(), env.SSH_IDENTITY_FILE.slice(2))
        : env.SSH_IDENTITY_FILE,
      strictHostKeyChecking: env.SSH_STRICT_HOST_KEY_CHECKING,
    };
  }
  // Mode 3: no SSH — direct Postgres connection
  return null;
}

export function loadEnvOrExit(): Env {
  try {
    return EnvSchema.parse(process.env);
  } catch (err) {
    console.error("Invalid environment variables:", err);
    process.exit(1);
  }
}
