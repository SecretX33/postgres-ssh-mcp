import dotenv from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Pool } from "pg";
import { loadEnvOrExit, resolveSshConfig } from "./config.js";
import { PROJECT_INFO } from "./util.js";
import { buildSshTunnel } from "./ssh-tunnel.js";
import {
  createDatabasePool,
  runDescribeTable,
  runListTables,
  runReadOnlyQuery,
  runSchemaQuery,
} from "./database.js";

function buildServer(pool: Pool): McpServer {
  const server = new McpServer({
    name: PROJECT_INFO.name,
    version: PROJECT_INFO.version,
  });

  server.registerTool(
    "run_query",
    {
      description:
        "Execute a read-only SQL query against the PostgreSQL database and return the results. " +
        "All queries run inside a READ ONLY transaction.",
      inputSchema: z.object({
        sql: z.string().describe("The SQL query to execute"),
      }),
    },
    ({ sql }) => runReadOnlyQuery(pool, sql),
  );

  server.registerTool(
    "list_schemas",
    { description: "List all schemas in the database." },
    () => runSchemaQuery(pool),
  );

  server.registerTool(
    "list_tables",
    {
      description: "List tables in a schema (default: public).",
      inputSchema: z.object({
        schema: z.string().default("public").describe("Schema name"),
      }),
    },
    ({ schema }) => runListTables(pool, schema),
  );

  server.registerTool(
    "describe_table",
    {
      description: "Show columns, types, and nullability for a table.",
      inputSchema: z.object({
        schema: z.string().default("public").describe("Schema name"),
        table: z.string().describe("Table name"),
      }),
    },
    ({ schema, table }) => runDescribeTable(pool, schema, table),
  );

  return server;
}

async function main() {
  if (process.env.NODE_ENV !== "production") {
    dotenv.config();
  }
  const env = loadEnvOrExit();
  const sshConfig = resolveSshConfig(env);

  const sshTunnel = await buildSshTunnel(env, sshConfig);
  const pool = await createDatabasePool(env, sshTunnel);

  const server = buildServer(pool);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.info("Postgres SSH MCP server ready");

  const cleanup = async () => {
    console.info("Shutting down...");
    await pool.end().catch(() => {});
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
