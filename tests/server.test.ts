import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.mock("dotenv", () => ({ default: { config: vi.fn() } }));
vi.mock("../src/config.js", () => ({
  loadEnvOrExit: vi.fn(() => ({
    DB_HOST: "localhost",
    DB_PORT: 5432,
    DB_NAME: "testdb",
    DB_USER: "user",
    DB_PASSWORD: "pw",
    DB_READ_ONLY: true,
    SSH_STRICT_HOST_KEY_CHECKING: true,
  })),
  resolveSshConfig: vi.fn(() => null),
}));
vi.mock("../src/ssh-tunnel.js", () => ({
  buildSshTunnel: vi.fn(async () => null),
  setupSshTunnelListeners: vi.fn(),
}));
vi.mock("../src/database.js", () => ({
  createDatabasePool: vi.fn(async () => ({})),
  fetchServerMetadata: vi.fn(async () => ({ version: null, databaseSize: null })),
  fetchDatabaseMetadataAsync: vi.fn(() => ({ version: null, databaseSize: null })),
  EXPLAIN_FORMATS: ["text", "json", "yaml", "xml"],
  getConnectionStatus: vi.fn(() => ({
    content: [{ type: "text", text: "{}" }],
  })),
  runQuery: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
  runExplainQuery: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
  runSchemaQuery: vi.fn(async () => ({ content: [{ type: "text", text: "[]" }] })),
  runListTables: vi.fn(async () => ({ content: [{ type: "text", text: "[]" }] })),
  runDescribeTable: vi.fn(async () => ({ content: [{ type: "text", text: "[]" }] })),
}));
vi.mock("../src/util.js", () => ({ PROJECT_INFO: { name: "test", version: "0.0.0" } }));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: vi.fn(function (this: any) {
    this.start = () => Promise.resolve();
  }),
}));
vi.mock("pg", () => ({ Pool: vi.fn(() => ({ on: vi.fn(), end: vi.fn() })) }));

import { buildServer } from "../src/server.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  runQuery,
  runExplainQuery,
  runSchemaQuery,
  runListTables,
  runDescribeTable,
  getConnectionStatus,
} from "../src/database.js";
import type { Env } from "../src/config.js";
import type { Pool } from "pg";
import type { DatabaseMetadata } from "../src/database.js";

const mockPool = {} as Pool;
const mockEnv = {
  DB_HOST: "localhost",
  DB_PORT: 5432,
  DB_NAME: "testdb",
  DB_USER: "user",
  DB_PASSWORD: "pw",
  DB_READ_ONLY: true,
  DB_SSL: undefined,
  DB_MAX_ROWS: 1000,
  DB_QUERY_TIMEOUT_MS: 15000,
  DB_CONNECTION_POOL_SIZE: 5,
  DB_CONNECTION_TIMEOUT_MS: 10000,
  DB_SSL_CA: undefined,
  DB_SSL_REJECT_UNAUTHORIZED: true,
  SSH_STRICT_HOST_KEY_CHECKING: true,
  SSH_PASSWORD: undefined,
  SSH_KEEPALIVE_COUNT_MAX: 3,
  SSH_TRUST_ON_FIRST_USE: true,
  SSH_KNOWN_HOSTS_PATH: undefined,
  SSH_MAX_RECONNECT_ATTEMPTS: 5,
  DB_POOL_DRAIN_TIMEOUT_MS: 5000,
} as Env;
const mockMetadata: DatabaseMetadata = { version: null, databaseSize: null };

function build(overrides?: Partial<Parameters<typeof buildServer>[0]>) {
  return buildServer({
    poolRef: { current: mockPool },
    readOnly: true,
    maxRows: 1000,
    env: mockEnv,
    sshTunnel: null,
    databaseMetadata: mockMetadata,
    ...overrides,
  });
}

let registerToolSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  registerToolSpy = vi.spyOn(McpServer.prototype, "registerTool");
});

afterEach(() => {
  vi.restoreAllMocks();
});

function getTool(name: string) {
  const call = registerToolSpy.mock.calls.find((c: any) => c[0] === name);
  if (!call) throw new Error(`Tool "${name}" not registered`);
  return { config: call[1] as { description: string }, handler: call[2] as Function };
}

describe("buildServer", () => {
  it("registers exactly 6 tools", () => {
    build();
    expect(registerToolSpy.mock.calls.length).toBe(6);
  });

  it("registers tools with correct names in order", () => {
    build();
    const names = registerToolSpy.mock.calls.map((c: any) => c[0]);
    expect(names).toEqual([
      "run_query",
      "explain_query",
      "list_schemas",
      "list_tables",
      "describe_table",
      "get_connection_status",
    ]);
  });

  it("run_query description contains 'READ ONLY' when readOnly=true", () => {
    build();
    const { config } = getTool("run_query");
    expect(config.description).toContain("READ ONLY transaction");
  });

  it("run_query description omits 'READ ONLY' when readOnly=false", () => {
    build({ readOnly: false });
    const { config } = getTool("run_query");
    expect(config.description).not.toContain("READ ONLY");
    expect(config.description).toContain("Execute a SQL query");
  });

  it("list_schemas description", () => {
    build();
    const { config } = getTool("list_schemas");
    expect(config.description).toBe("List all schemas in the database.");
  });

  it("list_tables description contains 'List tables in a schema'", () => {
    build();
    const { config } = getTool("list_tables");
    expect(config.description).toContain("List tables in a schema");
  });

  it("describe_table description contains 'Show columns, types, and nullability'", () => {
    build();
    const { config } = getTool("describe_table");
    expect(config.description).toContain("Show columns, types, and nullability");
  });

  it("run_query handler calls runQuery(pool, sql, readOnly, maxRows, params)", async () => {
    build();
    const { handler } = getTool("run_query");
    await handler({ sql: "SELECT 1" });
    expect(runQuery).toHaveBeenCalledWith(mockPool, "SELECT 1", true, 1000, undefined);
  });

  it("run_query handler passes readOnly=false", async () => {
    build({ readOnly: false });
    const { handler } = getTool("run_query");
    await handler({ sql: "SELECT 1" });
    expect(runQuery).toHaveBeenCalledWith(mockPool, "SELECT 1", false, 1000, undefined);
  });

  it("run_query handler passes maxRows when provided", async () => {
    build({ maxRows: 500 });
    const { handler } = getTool("run_query");
    await handler({ sql: "SELECT 1" });
    expect(runQuery).toHaveBeenCalledWith(mockPool, "SELECT 1", true, 500, undefined);
  });

  it("run_query handler passes params when provided", async () => {
    build();
    const { handler } = getTool("run_query");
    await handler({ sql: "SELECT $1", params: ["hello"] });
    expect(runQuery).toHaveBeenCalledWith(mockPool, "SELECT $1", true, 1000, ["hello"]);
  });

  it("explain_query handler calls runExplainQuery", async () => {
    build();
    const { handler } = getTool("explain_query");
    await handler({ sql: "SELECT 1", format: "json" });
    expect(runExplainQuery).toHaveBeenCalledWith(mockPool, "SELECT 1", true, "json");
  });

  it("get_connection_status handler calls getConnectionStatus", async () => {
    build();
    const { handler } = getTool("get_connection_status");
    await handler({});
    expect(getConnectionStatus).toHaveBeenCalledWith(
      mockPool,
      mockEnv,
      null,
      mockMetadata,
    );
  });

  it("list_schemas handler calls runSchemaQuery(pool)", async () => {
    build();
    const { handler } = getTool("list_schemas");
    await handler({});
    expect(runSchemaQuery).toHaveBeenCalledWith(mockPool);
  });

  it("list_tables handler calls runListTables(pool, schema)", async () => {
    build();
    const { handler } = getTool("list_tables");
    await handler({ schema: "public" });
    expect(runListTables).toHaveBeenCalledWith(mockPool, "public");
  });

  it("describe_table handler calls runDescribeTable(pool, schema, table)", async () => {
    build();
    const { handler } = getTool("describe_table");
    await handler({ schema: "public", table: "users" });
    expect(runDescribeTable).toHaveBeenCalledWith(mockPool, "public", "users");
  });

  describe("allowedTools filtering", () => {
    it("registers all 6 tools when allowedTools is undefined", () => {
      build();
      expect(registerToolSpy.mock.calls.length).toBe(6);
    });

    it("registers only the specified single tool", () => {
      build({ allowedTools: ["run_query"] });
      expect(registerToolSpy.mock.calls.length).toBe(1);
      const names = registerToolSpy.mock.calls.map((c: any) => c[0]);
      expect(names).toEqual(["run_query"]);
    });

    it("registers only the specified subset of tools", () => {
      build({ allowedTools: ["list_schemas", "list_tables"] });
      expect(registerToolSpy.mock.calls.length).toBe(2);
      const names = registerToolSpy.mock.calls.map((c: any) => c[0]);
      expect(names).toEqual(["list_schemas", "list_tables"]);
    });

    it("registers all 6 tools when all are explicitly listed", () => {
      build({
        allowedTools: [
          "run_query",
          "explain_query",
          "list_schemas",
          "list_tables",
          "describe_table",
          "get_connection_status",
        ],
      });
      expect(registerToolSpy.mock.calls.length).toBe(6);
    });

    it("registers zero tools when allowedTools is an empty array", () => {
      build({ allowedTools: [] });
      expect(registerToolSpy.mock.calls.length).toBe(0);
    });

    it("filters get_connection_status when not in allowedTools", () => {
      build({ allowedTools: ["run_query", "list_schemas"] });
      const names = registerToolSpy.mock.calls.map((c: any) => c[0]);
      expect(names).not.toContain("get_connection_status");
    });
  });

  it("tool handler uses poolRef.current at call time, not build time", async () => {
    const poolRef = { current: mockPool };
    buildServer({
      poolRef,
      readOnly: true,
      maxRows: 1000,
      env: mockEnv,
      sshTunnel: null,
      databaseMetadata: mockMetadata,
    });

    // Swap the pool (simulating SSH reconnection pool swap)
    const newPool = { newPool: true } as unknown as Pool;
    poolRef.current = newPool;

    const { handler } = getTool("run_query");
    await handler({ sql: "SELECT 1" });
    expect(runQuery).toHaveBeenCalledWith(newPool, "SELECT 1", true, 1000, undefined);
  });
});
