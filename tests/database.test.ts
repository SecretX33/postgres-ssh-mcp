import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { Pool, type QueryResult } from "pg";
import * as fs from "node:fs";
import {
  runQuery,
  runExplainQuery,
  runSchemaQuery,
  runListTables,
  runDescribeTable,
  createDatabasePool,
  getConnectionStatus,
  fetchServerMetadata,
  type DatabaseMetadata,
} from "../src/database.js";
import type { Env } from "../src/config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(
  rows: Record<string, unknown>[],
  rowCount = rows.length,
): QueryResult {
  return { rows, rowCount, command: "SELECT", oid: 0, fields: [] };
}

function makePool(
  queryFn: (sql: string, params?: unknown[]) => Promise<QueryResult> | never,
) {
  const client = { query: vi.fn().mockImplementation(queryFn), release: vi.fn() };
  const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;
  return { pool, client };
}

// ---------------------------------------------------------------------------
// runQuery
// ---------------------------------------------------------------------------

describe("runQuery", () => {
  it("readOnly=true → first query call is BEGIN TRANSACTION READ ONLY", async () => {
    const { pool, client } = makePool(() => Promise.resolve(makeResult([])));
    await runQuery(pool, "SELECT 1", true, 1000);
    expect(client.query).toHaveBeenNthCalledWith(1, "BEGIN TRANSACTION READ ONLY");
  });

  it("readOnly=true → ROLLBACK is called in finally on success", async () => {
    const { pool, client } = makePool(() => Promise.resolve(makeResult([])));
    await runQuery(pool, "SELECT 1", true, 1000);
    const calls = (client.query as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(calls).toContain("ROLLBACK");
  });

  it("readOnly=false → no BEGIN call made", async () => {
    const { pool, client } = makePool(() => Promise.resolve(makeResult([])));
    await runQuery(pool, "SELECT 1", false, 1000);
    const calls = (client.query as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(calls).not.toContain("BEGIN TRANSACTION READ ONLY");
  });

  it("readOnly=false → no ROLLBACK call made", async () => {
    const { pool, client } = makePool(() => Promise.resolve(makeResult([])));
    await runQuery(pool, "SELECT 1", false, 1000);
    const calls = (client.query as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(calls).not.toContain("ROLLBACK");
  });

  it("returns serialized { rows, rowCount } when rows are present", async () => {
    const rows = [{ id: 1, name: "Alice" }];
    const { pool } = makePool((sql) => {
      if (sql === "BEGIN TRANSACTION READ ONLY") return Promise.resolve(makeResult([]));
      return Promise.resolve(makeResult(rows));
    });
    const result = await runQuery(pool, "SELECT * FROM users", true, 1000);
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.rows).toEqual(rows);
    expect(parsed.rowCount).toBe(1);
  });

  it("returns 'Query returned no rows' when rows is empty", async () => {
    const { pool } = makePool(() => Promise.resolve(makeResult([])));
    const result = await runQuery(pool, "SELECT 1", false, 1000);
    expect((result.content[0] as { text: string }).text).toBe("Query returned no rows");
  });

  it("returns isError=true + message when query throws an Error", async () => {
    const { pool } = makePool((sql) => {
      if (sql === "BEGIN TRANSACTION READ ONLY") return Promise.resolve(makeResult([]));
      return Promise.reject(new Error("syntax error"));
    });
    const result = await runQuery(pool, "BAD SQL", true, 1000);
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("syntax error");
  });

  it("returns isError=true + stringified value when a non-Error is thrown", async () => {
    const { pool } = makePool(() => Promise.reject("plain string error"));
    const result = await runQuery(pool, "SELECT 1", false, 1000);
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("plain string error");
  });

  it("ROLLBACK failure is silently caught and does not surface to caller", async () => {
    const { pool } = makePool((sql) => {
      if (sql === "BEGIN TRANSACTION READ ONLY") return Promise.resolve(makeResult([]));
      if (sql === "ROLLBACK") return Promise.reject(new Error("rollback failed"));
      return Promise.resolve(makeResult([]));
    });
    const result = await runQuery(pool, "SELECT 1", true, 1000);
    // No error returned to caller
    expect(result.isError).toBeUndefined();
  });

  it("client.release() is called even when the query throws", async () => {
    const { pool, client } = makePool(() => Promise.reject(new Error("oops")));
    await runQuery(pool, "SELECT 1", false, 1000);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("client.release() is called even when BEGIN throws", async () => {
    const { pool, client } = makePool((sql) => {
      if (sql === "BEGIN TRANSACTION READ ONLY")
        return Promise.reject(new Error("begin failed"));
      return Promise.resolve(makeResult([]));
    });
    await runQuery(pool, "SELECT 1", true, 1000);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("returns isError=true with friendly timeout message when query throws 'Query read timeout'", async () => {
    const { pool } = makePool((sql) => {
      if (sql === "BEGIN TRANSACTION READ ONLY") return Promise.resolve(makeResult([]));
      return Promise.reject(new Error("Query read timeout"));
    });
    (pool as unknown as { options: { query_timeout: number } }).options = {
      query_timeout: 5000,
    };
    const result = await runQuery(pool, "SELECT 1", false, 1000);
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("timed out");
    expect(text).toContain("5000");
  });
});

// ---------------------------------------------------------------------------
// runSchemaQuery
// ---------------------------------------------------------------------------

describe("runSchemaQuery", () => {
  it("executes the correct schema query SQL", async () => {
    const { pool, client } = makePool(() => Promise.resolve(makeResult([])));
    await runSchemaQuery(pool);
    expect(client.query).toHaveBeenCalledWith(
      "SELECT schema_name FROM information_schema.schemata ORDER BY schema_name",
    );
  });

  it("returns serialized row objects (not just schema_name strings)", async () => {
    const rows = [{ schema_name: "public" }, { schema_name: "private" }];
    const { pool } = makePool(() => Promise.resolve(makeResult(rows)));
    const result = await runSchemaQuery(pool);
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed).toEqual(rows);
  });

  it("returns isError=true when query throws", async () => {
    const { pool } = makePool(() => Promise.reject(new Error("db error")));
    const result = await runSchemaQuery(pool);
    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runListTables
// ---------------------------------------------------------------------------

describe("runListTables", () => {
  it("executes the correct SQL with schema as $1 parameter", async () => {
    const { pool, client } = makePool(() => Promise.resolve(makeResult([])));
    await runListTables(pool, "public");
    expect(client.query).toHaveBeenCalledWith(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name",
      ["public"],
    );
  });

  it("returns serialized row objects", async () => {
    const rows = [{ table_name: "users" }, { table_name: "orders" }];
    const { pool } = makePool(() => Promise.resolve(makeResult(rows)));
    const result = await runListTables(pool, "public");
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed).toEqual(rows);
  });

  it("returns isError=true when query throws", async () => {
    const { pool } = makePool(() => Promise.reject(new Error("db error")));
    const result = await runListTables(pool, "public");
    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runDescribeTable
// ---------------------------------------------------------------------------

describe("runDescribeTable", () => {
  it("executes the correct SQL with schema as $1 and table as $2", async () => {
    const { pool, client } = makePool(() => Promise.resolve(makeResult([])));
    await runDescribeTable(pool, "public", "users");
    expect(client.query).toHaveBeenCalledWith(
      "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position",
      ["public", "users"],
    );
  });

  it("returns serialized row objects", async () => {
    const rows = [
      {
        column_name: "id",
        data_type: "integer",
        is_nullable: "NO",
        column_default: null,
      },
    ];
    const { pool } = makePool(() => Promise.resolve(makeResult(rows)));
    const result = await runDescribeTable(pool, "public", "users");
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed).toEqual(rows);
  });

  it("returns isError=true when query throws", async () => {
    const { pool } = makePool(() => Promise.reject(new Error("db error")));
    const result = await runDescribeTable(pool, "public", "users");
    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createDatabasePool
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// runQuery – validation integration
// ---------------------------------------------------------------------------

describe("runQuery – validation integration", () => {
  it("returns isError response for DELETE statement when readOnly=true", async () => {
    const { pool } = makePool(() => Promise.resolve(makeResult([])));
    const result = await runQuery(pool, "DELETE FROM t", true, 1000);
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/DELETE/i);
  });

  it("returns isError response for multi-statement input when readOnly=true", async () => {
    const { pool } = makePool(() => Promise.resolve(makeResult([])));
    const result = await runQuery(pool, "SELECT 1; DROP TABLE t", true, 1000);
    expect(result.isError).toBe(true);
  });

  it("passes a valid SELECT through to the pool", async () => {
    const { pool } = makePool(() => Promise.resolve(makeResult([{ id: 1 }])));
    const result = await runQuery(pool, "SELECT 1", false, 1000);
    expect(result.isError).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// runQuery – MAX_ROWS limiting
// ---------------------------------------------------------------------------

describe("runQuery – MAX_ROWS limiting", () => {
  it("should use DECLARE CURSOR and FETCH when readOnly and maxRows is set", async () => {
    const mockRows = Array.from({ length: 5 }, (_, i) => ({ id: i }));
    const { pool, client } = makePool((sql) => {
      if (sql === "BEGIN TRANSACTION READ ONLY") return Promise.resolve(makeResult([]));
      if (typeof sql === "string" && sql.startsWith("DECLARE"))
        return Promise.resolve(makeResult([]));
      if (typeof sql === "string" && sql.startsWith("FETCH"))
        return Promise.resolve(makeResult(mockRows));
      if (typeof sql === "string" && sql.startsWith("CLOSE"))
        return Promise.resolve(makeResult([]));
      return Promise.resolve(makeResult([]));
    });

    const result = await runQuery(pool, "SELECT * FROM t", true, 10);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);

    expect(parsed.truncated).toBeUndefined();
    expect(parsed.rows).toHaveLength(5);
    const calls = (client.query as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(calls.some((c: string) => c.startsWith("DECLARE"))).toBe(true);
  });

  it("should set truncated=true when rows exceed maxRows", async () => {
    const mockRows = Array.from({ length: 6 }, (_, i) => ({ id: i }));
    const { pool } = makePool((sql) => {
      if (sql === "BEGIN TRANSACTION READ ONLY") return Promise.resolve(makeResult([]));
      if (typeof sql === "string" && sql.startsWith("DECLARE"))
        return Promise.resolve(makeResult([]));
      if (typeof sql === "string" && sql.startsWith("FETCH"))
        return Promise.resolve(makeResult(mockRows));
      if (typeof sql === "string" && sql.startsWith("CLOSE"))
        return Promise.resolve(makeResult([]));
      return Promise.resolve(makeResult([]));
    });

    const result = await runQuery(pool, "SELECT * FROM t", true, 5);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);

    expect(parsed.truncated).toBe(true);
    expect(parsed.rows).toHaveLength(5);
    expect(parsed.rowCount).toBe(5);
  });

  it("should not use cursor when readOnly is false", async () => {
    const mockRows = Array.from({ length: 3 }, (_, i) => ({ id: i }));
    const { pool, client } = makePool(() => Promise.resolve(makeResult(mockRows)));

    const result = await runQuery(pool, "SELECT * FROM t", false, 5);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);

    expect(parsed.truncated).toBeUndefined();
    const calls = (client.query as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(
      calls.some((c: string) => typeof c === "string" && c.startsWith("DECLARE")),
    ).toBe(false);
  });

  it("should truncate rows in write mode when exceeding maxRows", async () => {
    const mockRows = Array.from({ length: 6 }, (_, i) => ({ id: i }));
    const { pool } = makePool(() => Promise.resolve(makeResult(mockRows)));

    const result = await runQuery(pool, "SELECT * FROM t", false, 5);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);

    expect(parsed.truncated).toBe(true);
    expect(parsed.rows).toHaveLength(5);
  });
});

vi.mock("pg", () => {
  const Pool = vi.fn();
  Pool.prototype.on = vi.fn();
  Pool.prototype.query = vi.fn();
  return { Pool };
});

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
}));

describe("createDatabasePool", () => {
  const baseEnv: Env = {
    DB_HOST: "db.example.com",
    DB_PORT: 5432,
    DB_NAME: "mydb",
    DB_USER: "user",
    DB_PASSWORD: "pass",
    DB_READ_ONLY: true,
    DB_SSL: false,
    DB_CONNECTION_POOL_SIZE: 5,
    DB_CONNECTION_TIMEOUT_MS: 10000,
    DB_QUERY_TIMEOUT_MS: 15000,
    DB_MAX_ROWS: 1000,
    DB_SSL_CA: undefined,
    DB_SSL_REJECT_UNAUTHORIZED: true,
    SSH_STRICT_HOST_KEY_CHECKING: true,
    SSH_PASSWORD: undefined,
    SSH_KEEPALIVE_COUNT_MAX: 3,
    SSH_TRUST_ON_FIRST_USE: true,
    SSH_KNOWN_HOSTS_PATH: undefined,
    SSH_MAX_RECONNECT_ATTEMPTS: 5,
    DB_POOL_DRAIN_TIMEOUT_MS: 5000,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (Pool.prototype.query as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeResult([{ ok: 1 }]),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("constructs Pool with host 127.0.0.1 and sshTunnel.localPort when sshTunnel is provided", async () => {
    const sshTunnel = { localPort: 54321, close: vi.fn(), on: vi.fn() };
    await createDatabasePool(baseEnv, sshTunnel);
    expect(Pool).toHaveBeenCalledWith(
      expect.objectContaining({ host: "127.0.0.1", port: 54321 }),
    );
  });

  it("constructs Pool with env DB_HOST and DB_PORT when sshTunnel is null", async () => {
    await createDatabasePool(baseEnv, null);
    expect(Pool).toHaveBeenCalledWith(
      expect.objectContaining({ host: "db.example.com", port: 5432 }),
    );
  });

  it("constructs Pool with connectionTimeoutMillis from DB_CONNECTION_TIMEOUT_MS", async () => {
    await createDatabasePool({ ...baseEnv, DB_CONNECTION_TIMEOUT_MS: 7500 }, null);
    expect(Pool).toHaveBeenCalledWith(
      expect.objectContaining({ connectionTimeoutMillis: 7500 }),
    );
  });

  it("constructs Pool with query_timeout from DB_QUERY_TIMEOUT_MS", async () => {
    await createDatabasePool({ ...baseEnv, DB_QUERY_TIMEOUT_MS: 30000 }, null);
    expect(Pool).toHaveBeenCalledWith(expect.objectContaining({ query_timeout: 30000 }));
  });

  it("returns the pool when connection test succeeds", async () => {
    const pool = await createDatabasePool(baseEnv, null);
    expect(pool).toBeInstanceOf(Pool);
  });

  it("calls process.exit(1) when connection test fails", async () => {
    (Pool.prototype.query as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("connection refused"),
    );
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    await expect(createDatabasePool(baseEnv, null)).rejects.toThrow(
      "process.exit called",
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("createDatabasePool – SSL CA", () => {
  const baseEnv: Env = {
    DB_HOST: "db.example.com",
    DB_PORT: 5432,
    DB_NAME: "mydb",
    DB_USER: "user",
    DB_PASSWORD: "pass",
    DB_READ_ONLY: true,
    DB_SSL: false,
    DB_CONNECTION_POOL_SIZE: 5,
    DB_CONNECTION_TIMEOUT_MS: 10000,
    DB_QUERY_TIMEOUT_MS: 15000,
    DB_MAX_ROWS: 1000,
    DB_SSL_CA: undefined,
    DB_SSL_REJECT_UNAUTHORIZED: true,
    SSH_STRICT_HOST_KEY_CHECKING: true,
    SSH_PASSWORD: undefined,
    SSH_KEEPALIVE_COUNT_MAX: 3,
    SSH_TRUST_ON_FIRST_USE: true,
    SSH_KNOWN_HOSTS_PATH: undefined,
    SSH_MAX_RECONNECT_ATTEMPTS: 5,
    DB_POOL_DRAIN_TIMEOUT_MS: 5000,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (Pool.prototype.query as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeResult([{ ok: 1 }]),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should pass ssl object with ca and rejectUnauthorized when DB_SSL_CA is set", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue("--- CA CERT ---");
    const env = {
      ...baseEnv,
      DB_SSL: true,
      DB_SSL_CA: "/path/to/ca.pem",
      DB_SSL_REJECT_UNAUTHORIZED: true,
    };
    await createDatabasePool(env, null);
    expect(Pool).toHaveBeenCalledWith(
      expect.objectContaining({
        ssl: { ca: "--- CA CERT ---" },
      }),
    );
  });

  it("should pass rejectUnauthorized=false when configured", async () => {
    const env = { ...baseEnv, DB_SSL: true, DB_SSL_REJECT_UNAUTHORIZED: false };
    await createDatabasePool(env, null);
    expect(Pool).toHaveBeenCalledWith(
      expect.objectContaining({
        ssl: { rejectUnauthorized: false },
      }),
    );
  });

  it("should pass ssl=true when DB_SSL=true with no CA and rejectUnauthorized=true", async () => {
    const env = { ...baseEnv, DB_SSL: true, DB_SSL_REJECT_UNAUTHORIZED: true };
    await createDatabasePool(env, null);
    expect(Pool).toHaveBeenCalledWith(expect.objectContaining({ ssl: true }));
  });

  it("should pass ssl: false when DB_SSL is false regardless of CA", async () => {
    const env = {
      ...baseEnv,
      DB_SSL: false,
      DB_SSL_CA: "/path/to/ca.pem",
      DB_SSL_REJECT_UNAUTHORIZED: true,
    };
    await createDatabasePool(env, null);
    expect(Pool).toHaveBeenCalledWith(expect.objectContaining({ ssl: false }));
  });
});

// ---------------------------------------------------------------------------
// Auto SSL for non-localhost
// ---------------------------------------------------------------------------

describe("createDatabasePool – Auto SSL", () => {
  const baseEnv: Env = {
    DB_HOST: "db.example.com",
    DB_PORT: 5432,
    DB_NAME: "mydb",
    DB_USER: "user",
    DB_PASSWORD: "pass",
    DB_READ_ONLY: true,
    DB_SSL: undefined,
    DB_CONNECTION_POOL_SIZE: 5,
    DB_CONNECTION_TIMEOUT_MS: 10000,
    DB_QUERY_TIMEOUT_MS: 15000,
    DB_MAX_ROWS: 1000,
    DB_SSL_CA: undefined,
    DB_SSL_REJECT_UNAUTHORIZED: true,
    SSH_STRICT_HOST_KEY_CHECKING: true,
    SSH_PASSWORD: undefined,
    SSH_KEEPALIVE_COUNT_MAX: 3,
    SSH_TRUST_ON_FIRST_USE: true,
    SSH_KNOWN_HOSTS_PATH: undefined,
    SSH_MAX_RECONNECT_ATTEMPTS: 5,
    DB_POOL_DRAIN_TIMEOUT_MS: 5000,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (Pool.prototype.query as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeResult([{ ok: 1 }]),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("auto-enables SSL for remote host when DB_SSL is undefined", async () => {
    await createDatabasePool({ ...baseEnv, DB_SSL: undefined }, null);
    expect(Pool).toHaveBeenCalledWith(expect.objectContaining({ ssl: true }));
  });

  it("auto-disables SSL for localhost when DB_SSL is undefined", async () => {
    await createDatabasePool(
      { ...baseEnv, DB_HOST: "localhost", DB_SSL: undefined },
      null,
    );
    expect(Pool).toHaveBeenCalledWith(expect.objectContaining({ ssl: false }));
  });

  it("auto-disables SSL for 127.0.0.1 when DB_SSL is undefined", async () => {
    await createDatabasePool(
      { ...baseEnv, DB_HOST: "127.0.0.1", DB_SSL: undefined },
      null,
    );
    expect(Pool).toHaveBeenCalledWith(expect.objectContaining({ ssl: false }));
  });

  it("auto-disables SSL for ::1 when DB_SSL is undefined", async () => {
    await createDatabasePool({ ...baseEnv, DB_HOST: "::1", DB_SSL: undefined }, null);
    expect(Pool).toHaveBeenCalledWith(expect.objectContaining({ ssl: false }));
  });

  it("explicit DB_SSL=true overrides auto for localhost", async () => {
    await createDatabasePool({ ...baseEnv, DB_HOST: "localhost", DB_SSL: true }, null);
    expect(Pool).toHaveBeenCalledWith(expect.objectContaining({ ssl: true }));
  });

  it("explicit DB_SSL=false overrides auto for remote host", async () => {
    await createDatabasePool(
      { ...baseEnv, DB_HOST: "remote.example.com", DB_SSL: false },
      null,
    );
    expect(Pool).toHaveBeenCalledWith(expect.objectContaining({ ssl: false }));
  });

  it("uses original DB_HOST for auto-SSL check when SSH tunnel is active", async () => {
    const sshTunnel = { localPort: 54321, close: vi.fn(), on: vi.fn() };
    await createDatabasePool(
      { ...baseEnv, DB_HOST: "remote.rds.amazonaws.com", DB_SSL: undefined },
      sshTunnel,
    );
    // Pool connects to 127.0.0.1 (tunnel), but SSL check uses original DB_HOST
    expect(Pool).toHaveBeenCalledWith(
      expect.objectContaining({ host: "127.0.0.1", ssl: true }),
    );
  });

  it("auto-enables SSL with DB_SSL_CA when DB_SSL is undefined and host is remote", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue("--- CA ---");
    await createDatabasePool(
      { ...baseEnv, DB_SSL: undefined, DB_SSL_CA: "/path/ca.pem" },
      null,
    );
    expect(Pool).toHaveBeenCalledWith(
      expect.objectContaining({ ssl: { ca: "--- CA ---" } }),
    );
  });
});

// ---------------------------------------------------------------------------
// runQuery – parameterized queries
// ---------------------------------------------------------------------------

describe("runQuery – parameterized queries", () => {
  it("passes params to client.query in write mode", async () => {
    const { pool, client } = makePool(() => Promise.resolve(makeResult([{ id: 1 }])));
    await runQuery(pool, "SELECT $1::int", false, 1000, [42]);
    expect(client.query).toHaveBeenCalledWith("SELECT $1::int", [42]);
  });

  it("passes params to DECLARE CURSOR in read-only mode", async () => {
    const { pool, client } = makePool((sql) => {
      if (sql === "BEGIN TRANSACTION READ ONLY") return Promise.resolve(makeResult([]));
      return Promise.resolve(makeResult([{ id: 1 }]));
    });
    await runQuery(pool, "SELECT $1::int", true, 1000, [42]);
    const calls = (client.query as ReturnType<typeof vi.fn>).mock.calls;
    const declareCalls = calls.filter(
      (c) => typeof c[0] === "string" && c[0].startsWith("DECLARE"),
    );
    expect(declareCalls.length).toBe(1);
    expect(declareCalls[0][1]).toEqual([42]);
  });

  it("works without params (undefined)", async () => {
    const { pool, client } = makePool(() => Promise.resolve(makeResult([{ id: 1 }])));
    await runQuery(pool, "SELECT 1", false, 1000);
    expect(client.query).toHaveBeenCalledWith("SELECT 1", undefined);
  });

  it("works with empty params array", async () => {
    const { pool, client } = makePool(() => Promise.resolve(makeResult([{ id: 1 }])));
    await runQuery(pool, "SELECT 1", false, 1000, []);
    expect(client.query).toHaveBeenCalledWith("SELECT 1", []);
  });

  it("passes null values in params", async () => {
    const { pool, client } = makePool(() => Promise.resolve(makeResult([{ id: 1 }])));
    await runQuery(pool, "SELECT $1", false, 1000, [null]);
    expect(client.query).toHaveBeenCalledWith("SELECT $1", [null]);
  });

  it("passes mixed type params", async () => {
    const { pool, client } = makePool(() => Promise.resolve(makeResult([])));
    await runQuery(pool, "SELECT $1, $2, $3", false, 1000, ["hello", 42, true]);
    expect(client.query).toHaveBeenCalledWith("SELECT $1, $2, $3", ["hello", 42, true]);
  });
});

// ---------------------------------------------------------------------------
// runExplainQuery
// ---------------------------------------------------------------------------

describe("runExplainQuery", () => {
  it("constructs EXPLAIN with TEXT format", async () => {
    const { pool, client } = makePool(() =>
      Promise.resolve(makeResult([{ "QUERY PLAN": "Seq Scan on t" }])),
    );
    const result = await runExplainQuery(pool, "SELECT 1", false, "text");
    expect(result.isError).toBeUndefined();
    expect(client.query).toHaveBeenCalledWith("EXPLAIN (FORMAT TEXT) SELECT 1");
    expect((result.content[0] as { text: string }).text).toBe("Seq Scan on t");
  });

  it("constructs EXPLAIN with JSON format and parses output", async () => {
    const planData = [{ Plan: { "Node Type": "Result" } }];
    const { pool } = makePool(() =>
      Promise.resolve(makeResult([{ "QUERY PLAN": planData }])),
    );
    const result = await runExplainQuery(pool, "SELECT 1", false, "json");
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed).toEqual(planData);
  });

  it("constructs EXPLAIN with YAML format", async () => {
    const { pool, client } = makePool(() =>
      Promise.resolve(makeResult([{ "QUERY PLAN": "- Plan:" }])),
    );
    await runExplainQuery(pool, "SELECT 1", false, "yaml");
    expect(client.query).toHaveBeenCalledWith("EXPLAIN (FORMAT YAML) SELECT 1");
  });

  it("constructs EXPLAIN with XML format", async () => {
    const { pool, client } = makePool(() =>
      Promise.resolve(makeResult([{ "QUERY PLAN": "<explain>" }])),
    );
    await runExplainQuery(pool, "SELECT 1", false, "xml");
    expect(client.query).toHaveBeenCalledWith("EXPLAIN (FORMAT XML) SELECT 1");
  });

  it("joins multiple QUERY PLAN rows for text format", async () => {
    const { pool } = makePool(() =>
      Promise.resolve(
        makeResult([
          { "QUERY PLAN": "Seq Scan on t" },
          { "QUERY PLAN": "  Filter: (id > 1)" },
        ]),
      ),
    );
    const result = await runExplainQuery(pool, "SELECT * FROM t", false, "text");
    const text = (result.content[0] as { text: string }).text;
    expect(text).toBe("Seq Scan on t\n  Filter: (id > 1)");
  });

  it("validates SQL and returns error for DML in read-only mode", async () => {
    const { pool } = makePool(() => Promise.resolve(makeResult([])));
    const result = await runExplainQuery(pool, "DELETE FROM t", true, "text");
    expect(result.isError).toBe(true);
  });

  it("returns error when explain query throws", async () => {
    const { pool } = makePool(() => Promise.reject(new Error("explain failed")));
    const result = await runExplainQuery(pool, "SELECT 1", false, "text");
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("explain failed");
  });
});

// ---------------------------------------------------------------------------
// getConnectionStatus
// ---------------------------------------------------------------------------

describe("getConnectionStatus", () => {
  const mockEnv: Env = {
    DB_HOST: "db.example.com",
    DB_PORT: 5432,
    DB_NAME: "mydb",
    DB_USER: "user",
    DB_PASSWORD: "pass",
    DB_READ_ONLY: true,
    DB_SSL: undefined,
    DB_CONNECTION_POOL_SIZE: 5,
    DB_CONNECTION_TIMEOUT_MS: 10000,
    DB_QUERY_TIMEOUT_MS: 15000,
    DB_MAX_ROWS: 1000,
    DB_SSL_CA: undefined,
    DB_SSL_REJECT_UNAUTHORIZED: true,
    SSH_STRICT_HOST_KEY_CHECKING: true,
    SSH_PASSWORD: undefined,
    SSH_KEEPALIVE_COUNT_MAX: 3,
    SSH_TRUST_ON_FIRST_USE: true,
    SSH_KNOWN_HOSTS_PATH: undefined,
    SSH_MAX_RECONNECT_ATTEMPTS: 5,
    DB_POOL_DRAIN_TIMEOUT_MS: 5000,
  };

  it("returns valid JSON with all expected fields", () => {
    const pool = {
      totalCount: 5,
      idleCount: 3,
      waitingCount: 0,
    } as unknown as Pool;
    const metadata: DatabaseMetadata = {
      version: "PostgreSQL 16.1",
      databaseSize: "42 MB",
    };

    const result = getConnectionStatus(pool, mockEnv, null, metadata);
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.pool.totalConnections).toBe(5);
    expect(parsed.pool.idleConnections).toBe(3);
    expect(parsed.pool.waitingRequests).toBe(0);
    expect(parsed.database.version).toBe("PostgreSQL 16.1");
    expect(parsed.database.size).toBe("42 MB");
    expect(parsed.config.readOnly).toBe(true);
    expect(parsed.sshTunnel).toBe("not configured");
  });

  it("returns null metadata when not yet available", () => {
    const pool = {
      totalCount: 0,
      idleCount: 0,
      waitingCount: 0,
    } as unknown as Pool;
    const metadata: DatabaseMetadata = { version: null, databaseSize: null };

    const result = getConnectionStatus(pool, mockEnv, null, metadata);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.database.version).toBeNull();
    expect(parsed.database.size).toBeNull();
  });

  it("shows SSH tunnel as connected when sshTunnel is present", () => {
    const pool = {
      totalCount: 1,
      idleCount: 1,
      waitingCount: 0,
    } as unknown as Pool;
    const sshTunnel = { localPort: 54321, close: vi.fn(), on: vi.fn() };
    const metadata: DatabaseMetadata = { version: null, databaseSize: null };

    const result = getConnectionStatus(pool, mockEnv, sshTunnel, metadata);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.sshTunnel).toBe("connected");
  });

  it("includes config values", () => {
    const pool = {
      totalCount: 0,
      idleCount: 0,
      waitingCount: 0,
    } as unknown as Pool;
    const metadata: DatabaseMetadata = { version: null, databaseSize: null };

    const result = getConnectionStatus(pool, mockEnv, null, metadata);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.config.maxRows).toBe(1000);
    expect(parsed.config.queryTimeoutMs).toBe(15000);
    expect(parsed.config.connectionPoolSize).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// fetchServerMetadata
// ---------------------------------------------------------------------------

describe("fetchServerMetadata", () => {
  it("returns version and size when queries succeed", async () => {
    const pool = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes("version()"))
          return Promise.resolve({ rows: [{ version: "PG 16" }] });
        if (sql.includes("pg_database_size"))
          return Promise.resolve({ rows: [{ size: "100 MB" }] });
        return Promise.resolve({ rows: [] });
      }),
    } as unknown as Pool;

    const meta = await fetchServerMetadata(pool);
    expect(meta.version).toBe("PG 16");
    expect(meta.databaseSize).toBe("100 MB");
  });

  it("returns nulls when queries fail", async () => {
    const pool = {
      query: vi.fn().mockRejectedValue(new Error("permission denied")),
    } as unknown as Pool;

    const meta = await fetchServerMetadata(pool);
    expect(meta.version).toBeNull();
    expect(meta.databaseSize).toBeNull();
  });
});

describe("structuredContent", () => {
  it("runQuery returns structuredContent with rows on success", async () => {
    const rows = [{ id: 1 }];
    const { pool } = makePool((sql) => {
      if (sql === "BEGIN TRANSACTION READ ONLY") return Promise.resolve(makeResult([]));
      return Promise.resolve(makeResult(rows));
    });
    const result = await runQuery(pool, "SELECT 1", true, 1000);
    expect(result.structuredContent).toEqual({ rows, rowCount: 1 });
  });

  it("runQuery returns structuredContent with empty rows when no results", async () => {
    const { pool } = makePool((sql) => {
      if (sql === "BEGIN TRANSACTION READ ONLY") return Promise.resolve(makeResult([]));
      return Promise.resolve(makeResult([]));
    });
    const result = await runQuery(pool, "SELECT 1", true, 1000);
    expect(result.structuredContent).toEqual({ rows: [], rowCount: 0 });
  });

  it("runQuery includes truncated in structuredContent when rows exceed maxRows", async () => {
    const mockRows = Array.from({ length: 6 }, (_, i) => ({ id: i }));
    const { pool } = makePool((sql) => {
      if (sql === "BEGIN TRANSACTION READ ONLY") return Promise.resolve(makeResult([]));
      if (typeof sql === "string" && sql.startsWith("DECLARE"))
        return Promise.resolve(makeResult([]));
      if (typeof sql === "string" && sql.startsWith("FETCH"))
        return Promise.resolve(makeResult(mockRows));
      if (typeof sql === "string" && sql.startsWith("CLOSE"))
        return Promise.resolve(makeResult([]));
      return Promise.resolve(makeResult([]));
    });
    const result = await runQuery(pool, "SELECT * FROM t", true, 5);
    expect(result.structuredContent).toEqual({
      rows: mockRows.slice(0, 5),
      rowCount: 5,
      truncated: true,
    });
  });

  it("runQuery does not return structuredContent on error", async () => {
    const { pool } = makePool(() => Promise.reject(new Error("fail")));
    const result = await runQuery(pool, "SELECT 1", false, 1000);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
  });

  it("runQuery does not return structuredContent on validation error", async () => {
    const { pool } = makePool(() => Promise.resolve(makeResult([])));
    const result = await runQuery(pool, "DELETE FROM t", true, 1000);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
  });

  it("runExplainQuery returns structuredContent with plan", async () => {
    const { pool } = makePool(() =>
      Promise.resolve(makeResult([{ "QUERY PLAN": "Seq Scan on t" }])),
    );
    const result = await runExplainQuery(pool, "SELECT 1", false, "text");
    expect(result.structuredContent).toEqual({ plan: "Seq Scan on t" });
  });

  it("runExplainQuery does not return structuredContent on error", async () => {
    const { pool } = makePool(() => Promise.reject(new Error("fail")));
    const result = await runExplainQuery(pool, "SELECT 1", false, "text");
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
  });

  it("runSchemaQuery returns structuredContent with rows", async () => {
    const rows = [{ schema_name: "public" }];
    const { pool } = makePool(() => Promise.resolve(makeResult(rows)));
    const result = await runSchemaQuery(pool);
    expect(result.structuredContent).toEqual({ rows });
  });

  it("runListTables returns structuredContent with rows", async () => {
    const rows = [{ table_name: "users" }];
    const { pool } = makePool(() => Promise.resolve(makeResult(rows)));
    const result = await runListTables(pool, "public");
    expect(result.structuredContent).toEqual({ rows });
  });

  it("runDescribeTable returns structuredContent with rows", async () => {
    const rows = [
      {
        column_name: "id",
        data_type: "integer",
        is_nullable: "NO",
        column_default: null,
      },
    ];
    const { pool } = makePool(() => Promise.resolve(makeResult(rows)));
    const result = await runDescribeTable(pool, "public", "users");
    expect(result.structuredContent).toEqual({ rows });
  });

  it("getConnectionStatus returns structuredContent", () => {
    const pool = { totalCount: 2, idleCount: 1, waitingCount: 0 } as unknown as Pool;
    const env: Env = {
      DB_HOST: "db.example.com",
      DB_PORT: 5432,
      DB_NAME: "mydb",
      DB_USER: "user",
      DB_PASSWORD: "pass",
      DB_READ_ONLY: true,
      DB_SSL: undefined,
      DB_CONNECTION_POOL_SIZE: 5,
      DB_CONNECTION_TIMEOUT_MS: 10000,
      DB_QUERY_TIMEOUT_MS: 15000,
      DB_MAX_ROWS: 1000,
      DB_SSL_CA: undefined,
      DB_SSL_REJECT_UNAUTHORIZED: true,
      SSH_STRICT_HOST_KEY_CHECKING: true,
      SSH_PASSWORD: undefined,
      SSH_KEEPALIVE_COUNT_MAX: 3,
      SSH_TRUST_ON_FIRST_USE: true,
      SSH_KNOWN_HOSTS_PATH: undefined,
      SSH_MAX_RECONNECT_ATTEMPTS: 5,
      DB_POOL_DRAIN_TIMEOUT_MS: 5000,
    };
    const metadata: DatabaseMetadata = { version: "PG 16", databaseSize: "10 MB" };
    const result = getConnectionStatus(pool, env, null, metadata);
    expect(result.structuredContent).toBeDefined();
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc.sshTunnel).toBe("not configured");
    expect((sc.database as Record<string, unknown>).version).toBe("PG 16");
  });

  it("schema tools do not return structuredContent on error", async () => {
    const { pool } = makePool(() => Promise.reject(new Error("db error")));
    const result = await runSchemaQuery(pool);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
  });
});
