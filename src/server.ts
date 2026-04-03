#!/usr/bin/env node
import dotenv from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Pool } from "pg";
import { type Env, loadEnvOrExit, resolveSshConfig, type ToolName } from "./config.js";
import { PROJECT_INFO } from "./util.js";
import {
  buildSshTunnel,
  setupSshTunnelListeners,
  type TunnelInfo,
} from "./ssh-tunnel.js";
import {
  createDatabasePool,
  type DatabaseMetadata,
  type ExplainOptions,
  EXPLAIN_FORMAT_SCHEMA,
  SERIALIZE_SCHEMA,
  fetchDatabaseMetadataAsync,
  getConnectionStatus,
  runDescribeTable,
  runExplainQuery,
  runListTables,
  runQuery,
  runSchemaQuery,
} from "./database.js";

export function buildServer({
  env,
  poolRef,
  sshTunnel,
  databaseMetadata,
}: {
  env: Env;
  poolRef: { current: Pool };
  sshTunnel: TunnelInfo | null;
  databaseMetadata: DatabaseMetadata;
}): McpServer {
  const { readOnly, maxRows, allowedTools } = {
    readOnly: env.DB_READ_ONLY,
    maxRows: env.DB_MAX_ROWS,
    allowedTools: env.ALLOWED_TOOLS,
  };
  const serverInfo = {
    name: PROJECT_INFO.name,
    version: PROJECT_INFO.version,
  };
  const server = new McpServer(serverInfo);
  const isAllowed = (name: ToolName) => !allowedTools || allowedTools.includes(name);

  if (isAllowed("run_query")) {
    server.registerTool(
      "run_query",
      {
        description: readOnly
          ? "Execute a read-only SQL query against the PostgreSQL database and return the results. All queries run inside a READ ONLY transaction. Supports parameterized queries using $1, $2, ... placeholders."
          : "Execute a SQL query against the PostgreSQL database and return the results. Supports parameterized queries using $1, $2, ... placeholders.",
        inputSchema: z.object({
          sql: z.string().describe("The SQL query to execute"),
          params: z
            .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
            .describe("Optional parameters for $1, $2, ... placeholders in the query")
            .optional(),
        }),
      },
      ({ sql, params }) => runQuery(poolRef.current, sql, readOnly, maxRows, params),
    );
  }

  if (isAllowed("explain_query")) {
    server.registerTool(
      "explain_query",
      {
        description:
          "Get the execution plan for a SQL query. Returns the EXPLAIN output in the specified format. Supports all PostgreSQL EXPLAIN options including ANALYZE for real execution statistics.",
        inputSchema: z.object({
          sql: z.string().describe("The SQL query to explain"),
          format: EXPLAIN_FORMAT_SCHEMA.default("text").describe(
            "Output format for the execution plan",
          ),
          analyze: z
            .boolean()
            .optional()
            .describe(
              "Execute the query and show actual runtime statistics (timing, rows). The query runs inside a read-only transaction.",
            ),
          verbose: z
            .boolean()
            .optional()
            .describe(
              "Show additional detail including output column lists and schema-qualified names",
            ),
          costs: z
            .boolean()
            .optional()
            .describe(
              "Show estimated startup and total cost for each plan node. Default: true",
            ),
          settings: z
            .boolean()
            .optional()
            .describe("Show non-default planner configuration parameters"),
          generic_plan: z
            .boolean()
            .optional()
            .describe(
              "Generate a generic plan with $N parameter placeholders. Cannot be used with analyze.",
            ),
          buffers: z
            .boolean()
            .optional()
            .describe(
              "Show buffer usage statistics (shared/local/temp hit/read/written). Most useful with analyze.",
            ),
          serialize: SERIALIZE_SCHEMA.optional().describe(
            "Include serialization overhead measurement. Requires analyze.",
          ),
          wal: z
            .boolean()
            .optional()
            .describe("Show WAL record generation statistics. Requires analyze."),
          timing: z
            .boolean()
            .optional()
            .describe(
              "Show actual time per plan node. Requires analyze. Default: true when analyze is on.",
            ),
          summary: z
            .boolean()
            .optional()
            .describe("Show summary information such as planning and execution time"),
          memory: z.boolean().optional().describe("Show planner memory consumption"),
        }),
      },
      ({ sql, format, ...rest }) => {
        const options: ExplainOptions = { format, ...rest };
        return runExplainQuery(poolRef.current, sql, readOnly, options);
      },
    );
  }

  if (isAllowed("list_schemas")) {
    server.registerTool(
      "list_schemas",
      { description: "List all schemas in the database." },
      () => runSchemaQuery(poolRef.current),
    );
  }

  if (isAllowed("list_tables")) {
    server.registerTool(
      "list_tables",
      {
        description: "List tables in a schema (default: public).",
        inputSchema: z.object({
          schema: z.string().default("public").describe("Schema name"),
        }),
      },
      ({ schema }) => runListTables(poolRef.current, schema),
    );
  }

  if (isAllowed("describe_table")) {
    server.registerTool(
      "describe_table",
      {
        description: "Show columns, types, and nullability for a table.",
        inputSchema: z.object({
          schema: z.string().default("public").describe("Schema name"),
          table: z.string().describe("Table name"),
        }),
      },
      ({ schema, table }) => runDescribeTable(poolRef.current, schema, table),
    );
  }

  if (isAllowed("get_connection_status")) {
    server.registerTool(
      "get_connection_status",
      {
        description:
          "Show connection pool stats, database version, size, and server configuration.",
      },
      () => getConnectionStatus(poolRef.current, env, sshTunnel, databaseMetadata),
    );
  }

  return server;
}

async function main() {
  if (process.env.NODE_ENV && process.env.NODE_ENV !== "production") {
    dotenv.config();
  }
  console.error(`Starting Postgres SSH MCP server version ${PROJECT_INFO.version}...`);

  const env = loadEnvOrExit();
  const sshConfig = resolveSshConfig(env);

  const sshTunnel = await buildSshTunnel(env, sshConfig);
  const poolRef = { current: await createDatabasePool(env, sshTunnel) };
  if (sshTunnel) {
    setupSshTunnelListeners(sshTunnel, poolRef, env);
  }
  const databaseMetadata = fetchDatabaseMetadataAsync(poolRef);

  const server = buildServer({
    env,
    poolRef,
    sshTunnel,
    databaseMetadata,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(`Postgres SSH MCP server version ${PROJECT_INFO.version} ready`);

  const cleanup = async () => {
    console.error("Shutting down...");
    await poolRef.current.end().catch(() => {});
    sshTunnel?.close();
    process.exit(0);
  };
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
