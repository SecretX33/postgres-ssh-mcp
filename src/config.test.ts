import { describe, expect, it, vi, afterEach } from "vitest";
import {
  EnvSchema,
  parseSshConfigFile,
  resolveSshConfig,
  loadEnvOrExit,
} from "./config.js";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";

describe("EnvSchema", () => {
  it("parses valid env vars with all required fields", () => {
    const result = EnvSchema.parse({
      DB_HOST: "rds.example.com",
      DB_PORT: "5432",
      DB_NAME: "mydb",
      DB_USER: "dbuser",
      DB_PASSWORD: "secret",
    });
    expect(result.DB_HOST).toBe("rds.example.com");
    expect(result.DB_PORT).toBe(5432);
    expect(result.SSH_STRICT_HOST_KEY_CHECKING).toBe(true);
    expect(result.SSH_USER).toBeUndefined();
  });

  it("defaults DB_PORT to 5432 when not provided", () => {
    const result = EnvSchema.parse({
      DB_HOST: "x",
      DB_NAME: "x",
      DB_USER: "x",
      DB_PASSWORD: "x",
    });
    expect(result.DB_PORT).toBe(5432);
  });

  it("coerces DB_PORT string to number", () => {
    const result = EnvSchema.parse({
      DB_HOST: "x",
      DB_PORT: "3306",
      DB_NAME: "x",
      DB_USER: "x",
      DB_PASSWORD: "x",
    });
    expect(result.DB_PORT).toBe(3306);
  });

  it("fails when DB_HOST is missing", () => {
    expect(() =>
      EnvSchema.parse({
        DB_NAME: "x",
        DB_USER: "x",
        DB_PASSWORD: "x",
      }),
    ).toThrow();
  });

  it("throws when DB_PORT is 0 (out of range)", () => {
    expect(() =>
      EnvSchema.parse({
        DB_HOST: "x",
        DB_PORT: "0",
        DB_NAME: "x",
        DB_USER: "x",
        DB_PASSWORD: "x",
      }),
    ).toThrow();
  });

  it("throws when DB_PORT is 99999 (out of range)", () => {
    expect(() =>
      EnvSchema.parse({
        DB_HOST: "x",
        DB_PORT: "99999",
        DB_NAME: "x",
        DB_USER: "x",
        DB_PASSWORD: "x",
      }),
    ).toThrow();
  });

  it("accepts Mode 2 SSH fields", () => {
    const result = EnvSchema.parse({
      DB_HOST: "x",
      DB_NAME: "x",
      DB_USER: "x",
      DB_PASSWORD: "x",
      SSH_HOSTNAME: "10.0.0.1",
      SSH_USER: "ubuntu",
      SSH_PORT: "22",
      SSH_STRICT_HOST_KEY_CHECKING: "false",
      SSH_IDENTITY_FILE: "/home/user/.ssh/id_rsa",
    });
    expect(result.SSH_USER).toBe("ubuntu");
    expect(result.SSH_PORT).toBe(22);
    expect(result.SSH_STRICT_HOST_KEY_CHECKING).toBe(false);
    expect(result.DB_READ_ONLY).toBe(true);
  });

  it("accepts SSH_HOST alone (Mode 1)", () => {
    const result = EnvSchema.parse({
      DB_HOST: "x",
      DB_NAME: "x",
      DB_USER: "x",
      DB_PASSWORD: "x",
      SSH_HOST: "my-bastion",
    });
    expect(result.SSH_HOST).toBe("my-bastion");
  });

  it("throws when SSH_HOST is combined with SSH_HOSTNAME", () => {
    expect(() =>
      EnvSchema.parse({
        DB_HOST: "x",
        DB_NAME: "x",
        DB_USER: "x",
        DB_PASSWORD: "x",
        SSH_HOST: "my-bastion",
        SSH_HOSTNAME: "10.0.0.1",
      }),
    ).toThrow(/SSH_HOST cannot be combined/);
  });

  it("throws when SSH_HOST is combined with SSH_USER", () => {
    expect(() =>
      EnvSchema.parse({
        DB_HOST: "x",
        DB_NAME: "x",
        DB_USER: "x",
        DB_PASSWORD: "x",
        SSH_HOST: "my-bastion",
        SSH_USER: "ubuntu",
      }),
    ).toThrow(/SSH_HOST cannot be combined/);
  });

  it("throws when SSH_HOST is combined with SSH_IDENTITY_FILE", () => {
    expect(() =>
      EnvSchema.parse({
        DB_HOST: "x",
        DB_NAME: "x",
        DB_USER: "x",
        DB_PASSWORD: "x",
        SSH_HOST: "my-bastion",
        SSH_IDENTITY_FILE: "/home/user/.ssh/id_rsa",
      }),
    ).toThrow(/SSH_HOST cannot be combined/);
  });

  it("throws when SSH_HOSTNAME is provided without SSH_USER", () => {
    expect(() =>
      EnvSchema.parse({
        DB_HOST: "x",
        DB_NAME: "x",
        DB_USER: "x",
        DB_PASSWORD: "x",
        SSH_HOSTNAME: "10.0.0.1",
      }),
    ).toThrow(/SSH_HOSTNAME and SSH_USER must both be provided together/);
  });

  it("throws when SSH_USER is provided without SSH_HOSTNAME", () => {
    expect(() =>
      EnvSchema.parse({
        DB_HOST: "x",
        DB_NAME: "x",
        DB_USER: "x",
        DB_PASSWORD: "x",
        SSH_USER: "ubuntu",
      }),
    ).toThrow(/SSH_HOSTNAME and SSH_USER must both be provided together/);
  });

  it("accepts no SSH vars at all (Mode 3)", () => {
    const result = EnvSchema.parse({
      DB_HOST: "x",
      DB_NAME: "x",
      DB_USER: "x",
      DB_PASSWORD: "x",
    });
    expect(result.SSH_HOST).toBeUndefined();
    expect(result.SSH_HOSTNAME).toBeUndefined();
    expect(result.SSH_USER).toBeUndefined();
  });

  it("throws when SSH_PORT is provided without SSH_HOSTNAME and SSH_USER", () => {
    expect(() =>
      EnvSchema.parse({
        DB_HOST: "x",
        DB_NAME: "x",
        DB_USER: "x",
        DB_PASSWORD: "x",
        SSH_PORT: "22",
      }),
    ).toThrow(/SSH_PORT and SSH_IDENTITY_FILE require SSH_HOSTNAME and SSH_USER/);
  });

  it("throws when SSH_HOSTNAME + SSH_PORT provided without SSH_USER", () => {
    expect(() =>
      EnvSchema.parse({
        DB_HOST: "x",
        DB_NAME: "x",
        DB_USER: "x",
        DB_PASSWORD: "x",
        SSH_HOSTNAME: "10.0.0.1",
        SSH_PORT: "22",
      }),
    ).toThrow(/SSH_HOSTNAME and SSH_USER must both be provided together/);
  });

  // DB_READ_ONLY strict enum behavior
  it("DB_READ_ONLY defaults to true when omitted", () => {
    const result = EnvSchema.parse({
      DB_HOST: "x",
      DB_NAME: "x",
      DB_USER: "x",
      DB_PASSWORD: "x",
    });
    expect(result.DB_READ_ONLY).toBe(true);
  });

  it("DB_READ_ONLY 'true' → true", () => {
    const result = EnvSchema.parse({
      DB_HOST: "x",
      DB_NAME: "x",
      DB_USER: "x",
      DB_PASSWORD: "x",
      DB_READ_ONLY: "true",
    });
    expect(result.DB_READ_ONLY).toBe(true);
  });

  it("DB_READ_ONLY 'false' → false", () => {
    const result = EnvSchema.parse({
      DB_HOST: "x",
      DB_NAME: "x",
      DB_USER: "x",
      DB_PASSWORD: "x",
      DB_READ_ONLY: "false",
    });
    expect(result.DB_READ_ONLY).toBe(false);
  });

  it("DB_READ_ONLY 'no' → throws", () => {
    expect(() =>
      EnvSchema.parse({
        DB_HOST: "x",
        DB_NAME: "x",
        DB_USER: "x",
        DB_PASSWORD: "x",
        DB_READ_ONLY: "no",
      }),
    ).toThrow();
  });

  it("DB_READ_ONLY '0' → throws", () => {
    expect(() =>
      EnvSchema.parse({
        DB_HOST: "x",
        DB_NAME: "x",
        DB_USER: "x",
        DB_PASSWORD: "x",
        DB_READ_ONLY: "0",
      }),
    ).toThrow();
  });

  it("DB_READ_ONLY 'yes' → throws", () => {
    expect(() =>
      EnvSchema.parse({
        DB_HOST: "x",
        DB_NAME: "x",
        DB_USER: "x",
        DB_PASSWORD: "x",
        DB_READ_ONLY: "yes",
      }),
    ).toThrow();
  });

  it("DB_READ_ONLY '1' → throws", () => {
    expect(() =>
      EnvSchema.parse({
        DB_HOST: "x",
        DB_NAME: "x",
        DB_USER: "x",
        DB_PASSWORD: "x",
        DB_READ_ONLY: "1",
      }),
    ).toThrow();
  });

  it("DB_READ_ONLY 'FALSE' (wrong case) → throws", () => {
    expect(() =>
      EnvSchema.parse({
        DB_HOST: "x",
        DB_NAME: "x",
        DB_USER: "x",
        DB_PASSWORD: "x",
        DB_READ_ONLY: "FALSE",
      }),
    ).toThrow();
  });

  // SSH_STRICT_HOST_KEY_CHECKING strict enum behavior
  it("SSH_STRICT_HOST_KEY_CHECKING defaults to true when omitted", () => {
    const result = EnvSchema.parse({
      DB_HOST: "x",
      DB_NAME: "x",
      DB_USER: "x",
      DB_PASSWORD: "x",
    });
    expect(result.SSH_STRICT_HOST_KEY_CHECKING).toBe(true);
  });

  it("SSH_STRICT_HOST_KEY_CHECKING 'true' → true (boolean)", () => {
    const result = EnvSchema.parse({
      DB_HOST: "x",
      DB_NAME: "x",
      DB_USER: "x",
      DB_PASSWORD: "x",
      SSH_STRICT_HOST_KEY_CHECKING: "true",
    });
    expect(result.SSH_STRICT_HOST_KEY_CHECKING).toBe(true);
  });

  it("SSH_STRICT_HOST_KEY_CHECKING 'false' → false (boolean)", () => {
    const result = EnvSchema.parse({
      DB_HOST: "x",
      DB_NAME: "x",
      DB_USER: "x",
      DB_PASSWORD: "x",
      SSH_STRICT_HOST_KEY_CHECKING: "false",
    });
    expect(result.SSH_STRICT_HOST_KEY_CHECKING).toBe(false);
  });

  it("SSH_STRICT_HOST_KEY_CHECKING 'no' → throws", () => {
    expect(() =>
      EnvSchema.parse({
        DB_HOST: "x",
        DB_NAME: "x",
        DB_USER: "x",
        DB_PASSWORD: "x",
        SSH_STRICT_HOST_KEY_CHECKING: "no",
      }),
    ).toThrow();
  });

  it("SSH_STRICT_HOST_KEY_CHECKING 'yes' → throws", () => {
    expect(() =>
      EnvSchema.parse({
        DB_HOST: "x",
        DB_NAME: "x",
        DB_USER: "x",
        DB_PASSWORD: "x",
        SSH_STRICT_HOST_KEY_CHECKING: "yes",
      }),
    ).toThrow();
  });

  it("SSH_STRICT_HOST_KEY_CHECKING '0' → throws", () => {
    expect(() =>
      EnvSchema.parse({
        DB_HOST: "x",
        DB_NAME: "x",
        DB_USER: "x",
        DB_PASSWORD: "x",
        SSH_STRICT_HOST_KEY_CHECKING: "0",
      }),
    ).toThrow();
  });

  // Empty string behavior
  it("DB_HOST '' → throws (nonEmptyString)", () => {
    expect(() =>
      EnvSchema.parse({ DB_HOST: "", DB_NAME: "x", DB_USER: "x", DB_PASSWORD: "x" }),
    ).toThrow();
  });

  it("DB_NAME '' → throws (nonEmptyString)", () => {
    expect(() =>
      EnvSchema.parse({ DB_HOST: "x", DB_NAME: "", DB_USER: "x", DB_PASSWORD: "x" }),
    ).toThrow();
  });

  it("DB_USER '' → throws (nonEmptyString)", () => {
    expect(() =>
      EnvSchema.parse({ DB_HOST: "x", DB_NAME: "x", DB_USER: "", DB_PASSWORD: "x" }),
    ).toThrow();
  });

  it("DB_PASSWORD '' → throws (nonEmptyString)", () => {
    expect(() =>
      EnvSchema.parse({ DB_HOST: "x", DB_NAME: "x", DB_USER: "x", DB_PASSWORD: "" }),
    ).toThrow();
  });

  it("SSH_HOST '' → treated as undefined (no Mode 1 activation)", () => {
    const result = EnvSchema.parse({
      DB_HOST: "x",
      DB_NAME: "x",
      DB_USER: "x",
      DB_PASSWORD: "x",
      SSH_HOST: "",
    });
    expect(result.SSH_HOST).toBeUndefined();
  });

  it("SSH_HOSTNAME '' → treated as undefined (no Mode 2 activation)", () => {
    const result = EnvSchema.parse({
      DB_HOST: "x",
      DB_NAME: "x",
      DB_USER: "x",
      DB_PASSWORD: "x",
      SSH_HOSTNAME: "",
    });
    expect(result.SSH_HOSTNAME).toBeUndefined();
  });

  it("SSH_USER '' → treated as undefined", () => {
    const result = EnvSchema.parse({
      DB_HOST: "x",
      DB_NAME: "x",
      DB_USER: "x",
      DB_PASSWORD: "x",
      SSH_USER: "",
    });
    expect(result.SSH_USER).toBeUndefined();
  });

  it("SSH_IDENTITY_FILE '' → treated as undefined", () => {
    const result = EnvSchema.parse({
      DB_HOST: "x",
      DB_NAME: "x",
      DB_USER: "x",
      DB_PASSWORD: "x",
      SSH_IDENTITY_FILE: "",
    });
    expect(result.SSH_IDENTITY_FILE).toBeUndefined();
  });

  it("SSH_KEY_PASSPHRASE omitted → undefined", () => {
    const result = EnvSchema.parse({ DB_HOST: "x", DB_NAME: "x", DB_USER: "x", DB_PASSWORD: "x" });
    expect(result.SSH_KEY_PASSPHRASE).toBeUndefined();
  });

  it("SSH_KEY_PASSPHRASE '' → undefined", () => {
    const result = EnvSchema.parse({ DB_HOST: "x", DB_NAME: "x", DB_USER: "x", DB_PASSWORD: "x", SSH_KEY_PASSPHRASE: "" });
    expect(result.SSH_KEY_PASSPHRASE).toBeUndefined();
  });

  it("SSH_KEY_PASSPHRASE 'secret' → 'secret'", () => {
    const result = EnvSchema.parse({ DB_HOST: "x", DB_NAME: "x", DB_USER: "x", DB_PASSWORD: "x", SSH_KEY_PASSPHRASE: "secret" });
    expect(result.SSH_KEY_PASSPHRASE).toBe("secret");
  });
});

describe("parseSshConfigFile", () => {
  it("parses a host block with all fields", () => {
    const fakeConfig = `
Host my-bastion
  HostName bastion.example.com
  User ubuntu
  Port 2222
  IdentityFile /home/user/.ssh/key
  StrictHostKeyChecking no
`;
    const tmpFile = path.join(
      os.tmpdir(),
      `test_ssh_config_${process.pid}_${Date.now()}`,
    );
    fs.writeFileSync(tmpFile, fakeConfig, "utf-8");
    try {
      const result = parseSshConfigFile("my-bastion", tmpFile);
      expect(result.hostname).toBe("bastion.example.com");
      expect(result.user).toBe("ubuntu");
      expect(result.port).toBe(2222);
      expect(result.identityFile).toBe("/home/user/.ssh/key");
      expect(result.strictHostKeyChecking).toBe(false);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it("defaults port to 22 when not specified", () => {
    const fakeConfig = `
Host minimal
  HostName 192.168.1.1
  User admin
`;
    const tmpFile = path.join(
      os.tmpdir(),
      `test_ssh_config_min_${process.pid}_${Date.now()}`,
    );
    fs.writeFileSync(tmpFile, fakeConfig, "utf-8");
    try {
      const result = parseSshConfigFile("minimal", tmpFile);
      expect(result.port).toBe(22);
      expect(result.strictHostKeyChecking).toBe(true);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it("throws when host alias not found", () => {
    const fakeConfig = `
Host other-host
  HostName 1.2.3.4
  User admin
`;
    const tmpFile = path.join(
      os.tmpdir(),
      `test_ssh_config_miss_${process.pid}_${Date.now()}`,
    );
    fs.writeFileSync(tmpFile, fakeConfig, "utf-8");
    try {
      expect(() => parseSshConfigFile("my-bastion", tmpFile)).toThrow(/not found/);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it("throws on invalid port value", () => {
    const fakeConfig = `
Host bad-port
  HostName 1.2.3.4
  User admin
  Port abc
`;
    const tmpFile = path.join(
      os.tmpdir(),
      `test_ssh_config_badport_${process.pid}_${Date.now()}`,
    );
    fs.writeFileSync(tmpFile, fakeConfig, "utf-8");
    try {
      expect(() => parseSshConfigFile("bad-port", tmpFile)).toThrow(/Invalid Port value/);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it("throws on partially numeric port value like '22abc'", () => {
    const fakeConfig = `
Host bad-port2
  HostName 1.2.3.4
  User admin
  Port 22abc
`;
    const tmpFile = path.join(
      os.tmpdir(),
      `test_ssh_config_badport2_${process.pid}_${Date.now()}`,
    );
    fs.writeFileSync(tmpFile, fakeConfig, "utf-8");
    try {
      expect(() => parseSshConfigFile("bad-port2", tmpFile)).toThrow(
        /Invalid Port value/,
      );
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it("expands tilde in IdentityFile", () => {
    const fakeConfig = `
Host tilde-host
  HostName 1.2.3.4
  User admin
  IdentityFile ~/.ssh/id_rsa
`;
    const tmpFile = path.join(
      os.tmpdir(),
      `test_ssh_config_tilde_${process.pid}_${Date.now()}`,
    );
    fs.writeFileSync(tmpFile, fakeConfig, "utf-8");
    try {
      const result = parseSshConfigFile("tilde-host", tmpFile);
      expect(result.identityFile).toBe(path.join(os.homedir(), ".ssh", "id_rsa"));
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it("treats StrictHostKeyChecking 'false' as false", () => {
    const fakeConfig = `
Host test
  HostName 1.2.3.4
  User admin
  StrictHostKeyChecking false
`;
    const tmpFile = path.join(
      os.tmpdir(),
      `test_ssh_config_strict_${process.pid}_${Date.now()}`,
    );
    fs.writeFileSync(tmpFile, fakeConfig, "utf-8");
    try {
      const result = parseSshConfigFile("test", tmpFile);
      expect(result.strictHostKeyChecking).toBe(false);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it("throws when config file does not exist", () => {
    expect(() =>
      parseSshConfigFile("any", "/nonexistent/path/__test_ssh_config__"),
    ).toThrow(/SSH config file not found/);
  });

  it("throws when HostName present but User is missing", () => {
    const fakeConfig = `
Host no-user
  HostName 1.2.3.4
`;
    const tmpFile = path.join(
      os.tmpdir(),
      `test_ssh_config_nouser_${process.pid}_${Date.now()}`,
    );
    fs.writeFileSync(tmpFile, fakeConfig, "utf-8");
    try {
      expect(() => parseSshConfigFile("no-user", tmpFile)).toThrow(/No User defined/);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });
});

describe("resolveSshConfig", () => {
  it("uses Mode 2 when SSH_HOSTNAME and SSH_USER are present", () => {
    const env = EnvSchema.parse({
      DB_HOST: "x",
      DB_NAME: "x",
      DB_USER: "x",
      DB_PASSWORD: "x",
      SSH_HOSTNAME: "10.0.0.1",
      SSH_USER: "ubuntu",
      SSH_PORT: "22",
      SSH_STRICT_HOST_KEY_CHECKING: "false",
      SSH_IDENTITY_FILE: "/home/user/.ssh/key",
    });
    const result = resolveSshConfig(env);
    expect(result).not.toBeNull();
    expect(result!.hostname).toBe("10.0.0.1");
    expect(result!.user).toBe("ubuntu");
    expect(result!.port).toBe(22);
    expect(result!.strictHostKeyChecking).toBe(false);
    expect(result!.identityFile).toBe("/home/user/.ssh/key");
  });

  it("SSH_STRICT_HOST_KEY_CHECKING='false' results in strictHostKeyChecking=false (Mode 2)", () => {
    const env = EnvSchema.parse({
      DB_HOST: "x",
      DB_NAME: "x",
      DB_USER: "x",
      DB_PASSWORD: "x",
      SSH_HOSTNAME: "10.0.0.1",
      SSH_USER: "ubuntu",
      SSH_STRICT_HOST_KEY_CHECKING: "false",
    });
    expect(resolveSshConfig(env)!.strictHostKeyChecking).toBe(false);
  });

  it("throws when SSH_STRICT_HOST_KEY_CHECKING is 'no' (not a valid boolean string)", () => {
    expect(() =>
      EnvSchema.parse({
        DB_HOST: "x",
        DB_NAME: "x",
        DB_USER: "x",
        DB_PASSWORD: "x",
        SSH_HOSTNAME: "10.0.0.1",
        SSH_USER: "ubuntu",
        SSH_STRICT_HOST_KEY_CHECKING: "no",
      }),
    ).toThrow();
  });

  it("expands tilde in SSH_IDENTITY_FILE (Mode 2)", () => {
    const env = EnvSchema.parse({
      DB_HOST: "x",
      DB_NAME: "x",
      DB_USER: "x",
      DB_PASSWORD: "x",
      SSH_HOSTNAME: "10.0.0.1",
      SSH_USER: "ubuntu",
      SSH_IDENTITY_FILE: "~/.ssh/id_rsa",
    });
    const result = resolveSshConfig(env);
    expect(result!.identityFile).toBe(path.join(os.homedir(), ".ssh", "id_rsa"));
  });

  it("uses Mode 1 (SSH config file) when SSH_HOST is provided", () => {
    const fakeConfig = `
Host my-bastion
  HostName bastion.example.com
  User ec2-user
  Port 22
`;
    const tmpFile = path.join(
      os.tmpdir(),
      `test_ssh_config_opt1_${process.pid}_${Date.now()}`,
    );
    fs.writeFileSync(tmpFile, fakeConfig, "utf-8");
    try {
      const env = EnvSchema.parse({
        DB_HOST: "x",
        DB_NAME: "x",
        DB_USER: "x",
        DB_PASSWORD: "x",
        SSH_HOST: "my-bastion",
      });
      const result = resolveSshConfig(env, tmpFile);
      expect(result).not.toBeNull();
      expect(result!.hostname).toBe("bastion.example.com");
      expect(result!.user).toBe("ec2-user");
      expect(result!.port).toBe(22);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it("returns null when no SSH vars are provided (Mode 3)", () => {
    const env = EnvSchema.parse({
      DB_HOST: "x",
      DB_NAME: "x",
      DB_USER: "x",
      DB_PASSWORD: "x",
    });
    const result = resolveSshConfig(env);
    expect(result).toBeNull();
  });

  it("defaults SSH port to 22 when SSH_HOSTNAME + SSH_USER provided without SSH_PORT (Mode 2)", () => {
    const env = EnvSchema.parse({
      DB_HOST: "x",
      DB_NAME: "x",
      DB_USER: "x",
      DB_PASSWORD: "x",
      SSH_HOSTNAME: "10.0.0.1",
      SSH_USER: "ubuntu",
    });
    const result = resolveSshConfig(env);
    expect(result!.port).toBe(22);
  });
});

describe("loadEnvOrExit", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("returns parsed env when env vars are valid", () => {
    vi.stubEnv("DB_HOST", "rds.example.com");
    vi.stubEnv("DB_NAME", "mydb");
    vi.stubEnv("DB_USER", "user");
    vi.stubEnv("DB_PASSWORD", "pw");
    vi.stubEnv("SSH_HOST", "");
    vi.stubEnv("SSH_HOSTNAME", "");
    vi.stubEnv("SSH_USER", "");
    const env = loadEnvOrExit();
    expect(env.DB_HOST).toBe("rds.example.com");
    expect(env.DB_READ_ONLY).toBe(true);
    expect(env.SSH_STRICT_HOST_KEY_CHECKING).toBe(true);
  });

  it("calls process.exit(1) when env is invalid", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    const saved = process.env.DB_HOST;
    delete process.env.DB_HOST;
    try {
      expect(() => loadEnvOrExit()).toThrow("process.exit called");
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      if (saved !== undefined) process.env.DB_HOST = saved;
    }
  });
});
