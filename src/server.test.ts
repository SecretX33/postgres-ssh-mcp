import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.mock("dotenv", () => ({ default: { config: vi.fn() } }));
vi.mock("./config.js", () => ({
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
vi.mock("./ssh-tunnel.js", () => ({ buildSshTunnel: vi.fn(async () => null) }));
vi.mock("./database.js", () => ({
  createDatabasePool: vi.fn(async () => ({})),
  runQuery: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
  runSchemaQuery: vi.fn(async () => ({ content: [{ type: "text", text: "[]" }] })),
  runListTables: vi.fn(async () => ({ content: [{ type: "text", text: "[]" }] })),
  runDescribeTable: vi.fn(async () => ({ content: [{ type: "text", text: "[]" }] })),
}));
vi.mock("./util.js", () => ({ PROJECT_INFO: { name: "test", version: "0.0.0" } }));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: vi.fn(function (this: any) {
    this.start = () => Promise.resolve();
  }),
}));
vi.mock("pg", () => ({ Pool: vi.fn(() => ({ on: vi.fn(), end: vi.fn() })) }));

import { buildServer } from "./server.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runQuery, runSchemaQuery, runListTables, runDescribeTable } from "./database.js";
import type { Pool } from "pg";

const mockPool = {} as Pool;
let registerToolSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  registerToolSpy = vi.spyOn(McpServer.prototype, "registerTool");
});

afterEach(() => {
  vi.restoreAllMocks();
});

function getTool(name: string) {
  const call = registerToolSpy.mock.calls.find((c) => c[0] === name);
  if (!call) throw new Error(`Tool "${name}" not registered`);
  return { config: call[1] as { description: string }, handler: call[2] as Function };
}

describe("buildServer", () => {
  it("registers exactly 4 tools", () => {
    buildServer(mockPool, true);
    expect(registerToolSpy.mock.calls.length).toBe(4);
  });

  it("registers tools with correct names in order", () => {
    buildServer(mockPool, true);
    const names = registerToolSpy.mock.calls.map((c) => c[0]);
    expect(names).toEqual(["run_query", "list_schemas", "list_tables", "describe_table"]);
  });

  it("run_query description contains 'READ ONLY' when readOnly=true", () => {
    buildServer(mockPool, true);
    const { config } = getTool("run_query");
    expect(config.description).toContain("READ ONLY transaction");
  });

  it("run_query description omits 'READ ONLY' when readOnly=false", () => {
    buildServer(mockPool, false);
    const { config } = getTool("run_query");
    expect(config.description).not.toContain("READ ONLY");
    expect(config.description).toContain("Execute a SQL query");
  });

  it("list_schemas description", () => {
    buildServer(mockPool, true);
    const { config } = getTool("list_schemas");
    expect(config.description).toBe("List all schemas in the database.");
  });

  it("list_tables description contains 'List tables in a schema'", () => {
    buildServer(mockPool, true);
    const { config } = getTool("list_tables");
    expect(config.description).toContain("List tables in a schema");
  });

  it("describe_table description contains 'Show columns, types, and nullability'", () => {
    buildServer(mockPool, true);
    const { config } = getTool("describe_table");
    expect(config.description).toContain("Show columns, types, and nullability");
  });

  it("run_query handler calls runQuery(pool, sql, true)", async () => {
    buildServer(mockPool, true);
    const { handler } = getTool("run_query");
    await handler({ sql: "SELECT 1" });
    expect(runQuery).toHaveBeenCalledWith(mockPool, "SELECT 1", true);
  });

  it("run_query handler passes readOnly=false", async () => {
    buildServer(mockPool, false);
    const { handler } = getTool("run_query");
    await handler({ sql: "SELECT 1" });
    expect(runQuery).toHaveBeenCalledWith(mockPool, "SELECT 1", false);
  });

  it("list_schemas handler calls runSchemaQuery(pool)", async () => {
    buildServer(mockPool, true);
    const { handler } = getTool("list_schemas");
    await handler({});
    expect(runSchemaQuery).toHaveBeenCalledWith(mockPool);
  });

  it("list_tables handler calls runListTables(pool, schema)", async () => {
    buildServer(mockPool, true);
    const { handler } = getTool("list_tables");
    await handler({ schema: "public" });
    expect(runListTables).toHaveBeenCalledWith(mockPool, "public");
  });

  it("describe_table handler calls runDescribeTable(pool, schema, table)", async () => {
    buildServer(mockPool, true);
    const { handler } = getTool("describe_table");
    await handler({ schema: "public", table: "users" });
    expect(runDescribeTable).toHaveBeenCalledWith(mockPool, "public", "users");
  });
});
