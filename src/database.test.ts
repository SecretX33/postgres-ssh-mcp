import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { Pool, type QueryResult } from "pg";
import {
  runQuery,
  runSchemaQuery,
  runListTables,
  runDescribeTable,
  createDatabasePool,
} from "./database.js";
import type { Env } from "./config.js";

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
    await runQuery(pool, "SELECT 1", true);
    expect(client.query).toHaveBeenNthCalledWith(1, "BEGIN TRANSACTION READ ONLY");
  });

  it("readOnly=true → ROLLBACK is called in finally on success", async () => {
    const { pool, client } = makePool(() => Promise.resolve(makeResult([])));
    await runQuery(pool, "SELECT 1", true);
    const calls = (client.query as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(calls).toContain("ROLLBACK");
  });

  it("readOnly=false → no BEGIN call made", async () => {
    const { pool, client } = makePool(() => Promise.resolve(makeResult([])));
    await runQuery(pool, "SELECT 1", false);
    const calls = (client.query as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(calls).not.toContain("BEGIN TRANSACTION READ ONLY");
  });

  it("readOnly=false → no ROLLBACK call made", async () => {
    const { pool, client } = makePool(() => Promise.resolve(makeResult([])));
    await runQuery(pool, "SELECT 1", false);
    const calls = (client.query as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(calls).not.toContain("ROLLBACK");
  });

  it("returns serialized { rows, rowCount } when rows are present", async () => {
    const rows = [{ id: 1, name: "Alice" }];
    const { pool } = makePool((sql) => {
      if (sql === "BEGIN TRANSACTION READ ONLY") return Promise.resolve(makeResult([]));
      return Promise.resolve(makeResult(rows));
    });
    const result = await runQuery(pool, "SELECT * FROM users", true);
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.rows).toEqual(rows);
    expect(parsed.rowCount).toBe(1);
  });

  it("returns 'Query returned no rows' when rows is empty", async () => {
    const { pool } = makePool(() => Promise.resolve(makeResult([])));
    const result = await runQuery(pool, "SELECT 1", false);
    expect((result.content[0] as { text: string }).text).toBe("Query returned no rows");
  });

  it("returns isError=true + message when query throws an Error", async () => {
    const { pool } = makePool((sql) => {
      if (sql === "BEGIN TRANSACTION READ ONLY") return Promise.resolve(makeResult([]));
      return Promise.reject(new Error("syntax error"));
    });
    const result = await runQuery(pool, "BAD SQL", true);
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("syntax error");
  });

  it("returns isError=true + stringified value when a non-Error is thrown", async () => {
    const { pool } = makePool(() => Promise.reject("plain string error"));
    const result = await runQuery(pool, "SELECT 1", false);
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("plain string error");
  });

  it("ROLLBACK failure is silently caught and does not surface to caller", async () => {
    const { pool, client } = makePool((sql) => {
      if (sql === "BEGIN TRANSACTION READ ONLY") return Promise.resolve(makeResult([]));
      if (sql === "ROLLBACK") return Promise.reject(new Error("rollback failed"));
      return Promise.resolve(makeResult([]));
    });
    const result = await runQuery(pool, "SELECT 1", true);
    // No error returned to caller
    expect(result.isError).toBeUndefined();
  });

  it("client.release() is called even when the query throws", async () => {
    const { pool, client } = makePool(() => Promise.reject(new Error("oops")));
    await runQuery(pool, "SELECT 1", false);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("client.release() is called even when BEGIN throws", async () => {
    const { pool, client } = makePool((sql) => {
      if (sql === "BEGIN TRANSACTION READ ONLY")
        return Promise.reject(new Error("begin failed"));
      return Promise.resolve(makeResult([]));
    });
    await runQuery(pool, "SELECT 1", true);
    expect(client.release).toHaveBeenCalledOnce();
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
  it("returns isError response for DELETE statement", async () => {
    const { pool } = makePool(() => Promise.resolve(makeResult([])));
    const result = await runQuery(pool, "DELETE FROM t", false);
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/DELETE/i);
  });

  it("returns isError response for multi-statement input", async () => {
    const { pool } = makePool(() => Promise.resolve(makeResult([])));
    const result = await runQuery(pool, "SELECT 1; DROP TABLE t", false);
    expect(result.isError).toBe(true);
  });

  it("passes a valid SELECT through to the pool", async () => {
    const { pool } = makePool(() => Promise.resolve(makeResult([{ id: 1 }])));
    const result = await runQuery(pool, "SELECT 1", false);
    expect(result.isError).toBeUndefined();
  });
});

vi.mock("pg", () => {
  const Pool = vi.fn();
  Pool.prototype.on = vi.fn();
  Pool.prototype.query = vi.fn();
  return { Pool };
});

describe("createDatabasePool", () => {
  const baseEnv: Env = {
    DB_HOST: "db.example.com",
    DB_PORT: 5432,
    DB_NAME: "mydb",
    DB_USER: "user",
    DB_PASSWORD: "pass",
    DB_READ_ONLY: true,
    SSH_STRICT_HOST_KEY_CHECKING: true,
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
    const sshTunnel = { localPort: 54321, close: vi.fn() };
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
