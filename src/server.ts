#!/usr/bin/env node
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
  runQuery,
  runSchemaQuery,
} from "./database.js";

export function buildServer(pool: Pool, readOnly: boolean): McpServer {
  const server = new McpServer({
    name: PROJECT_INFO.name,
    version: PROJECT_INFO.version,
  });

  server.registerTool(
    "run_query",
    {
      description: readOnly
        ? "Execute a read-only SQL query against the PostgreSQL database and return the results. All queries run inside a READ ONLY transaction."
        : "Execute a SQL query against the PostgreSQL database and return the results.",
      inputSchema: z.object({
        sql: z.string().describe("The SQL query to execute"),
      }),
    },
    ({ sql }) => runQuery(pool, sql, readOnly),
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
  if (process.env.NODE_ENV && process.env.NODE_ENV !== "production") {
    dotenv.config();
  }
  const env = loadEnvOrExit();
  const sshConfig = resolveSshConfig(env);

  const sshTunnel = await buildSshTunnel(env, sshConfig);
  const pool = await createDatabasePool(env, sshTunnel);

  const server = buildServer(pool, env.DB_READ_ONLY);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("Postgres SSH MCP server ready");

  const cleanup = async () => {
    console.error("Shutting down...");
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
