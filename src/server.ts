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

export function buildServer(
  poolRef: { current: Pool },
  readOnly: boolean,
  maxRows?: number,
): McpServer {
  const serverInfo = {
    name: PROJECT_INFO.name,
    version: PROJECT_INFO.version,
  };
  const server = new McpServer(serverInfo);

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
    ({ sql }) => runQuery(poolRef.current, sql, readOnly, maxRows),
  );

  server.registerTool(
    "list_schemas",
    { description: "List all schemas in the database." },
    () => runSchemaQuery(poolRef.current),
  );

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

  const server = buildServer(poolRef, env.DB_READ_ONLY, env.DB_MAX_ROWS);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(`Postgres SSH MCP server version ${PROJECT_INFO.version} ready`);

  if (sshTunnel) {
    sshTunnel.on("reconnected", async ({ oldPort, newPort }) => {
      console.error(`[SSH] Tunnel reconnected: port ${oldPort} → ${newPort}`);
      const oldPool = poolRef.current;

      poolRef.current = await createDatabasePool(env, {
        ...sshTunnel,
        localPort: newPort,
      });

      try {
        await Promise.race([
          oldPool.end(),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("Pool drain timeout")),
              env.POOL_DRAIN_TIMEOUT_MS,
            ),
          ),
        ]);
      } catch {
        console.error("[DB] Pool drain timeout, forcing close");
        oldPool.end().catch(() => {});
      }
    });

    sshTunnel.on("failed", (error) => {
      console.error(`[SSH] Tunnel reconnection failed permanently: ${error.message}`);
      process.exit(1);
    });
  }

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
