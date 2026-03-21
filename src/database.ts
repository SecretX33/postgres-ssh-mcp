import { Pool, type PoolClient, type QueryResult } from "pg";
import * as fs from "node:fs";
import type { TunnelInfo } from "./ssh-tunnel.js";
import type { Env } from "./config.js";
import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { validateQuery, ValidationError } from "./sql-validator.js";

export type ToolResult = Awaited<ReturnType<ToolCallback>>;

export const EXPLAIN_FORMATS = ["text", "json", "yaml", "xml"] as const;
export type ExplainFormat = (typeof EXPLAIN_FORMATS)[number];

export interface DatabaseMetadata {
  version: string | null;
  databaseSize: string | null;
}

const LOCALHOST_ADDRESSES = ["localhost", "127.0.0.1", "::1"];

export async function runQuery(
  pool: Pool,
  sql: string,
  readOnly: boolean,
  maxRows: number,
  params?: (string | number | boolean | null)[],
): Promise<ToolResult> {
  try {
    await validateQuery(sql, readOnly);
  } catch (err) {
    if (err instanceof ValidationError) {
      return {
        content: [{ type: "text", text: err.message }],
        isError: true,
      };
    }
    throw err;
  }

  const client = await pool.connect();
  let startedTransaction = false;

  try {
    if (readOnly) {
      await client.query("BEGIN TRANSACTION READ ONLY");
      startedTransaction = true;
    }

    let rows: Record<string, unknown>[];
    let truncated = false;

    if (readOnly) {
      const cursorName = `mcp_cursor_${crypto.randomUUID().replace(/-/g, "")}`;
      await client.query(`DECLARE ${cursorName} CURSOR FOR ${sql}`, params);
      const result = await client.query(`FETCH ${maxRows + 1} FROM ${cursorName}`);
      truncated = result.rows.length > maxRows;
      rows = truncated ? result.rows.slice(0, maxRows) : result.rows;
      await client.query(`CLOSE ${cursorName}`);
    } else {
      const result = await client.query(sql, params);
      if (result.rows.length > maxRows) {
        truncated = true;
        rows = result.rows.slice(0, maxRows);
      } else {
        rows = result.rows;
      }
    }

    const text =
      rows.length === 0
        ? "Query returned no rows"
        : JSON.stringify(
            { rows, rowCount: rows.length, ...(truncated ? { truncated } : {}) },
            null,
            2,
          );

    return {
      content: [{ type: "text", text: text }],
    };
  } catch (err) {
    if (err instanceof Error && err.message === "Query read timeout") {
      return {
        content: [
          {
            type: "text",
            text: `Query timed out. The query exceeded the configured time limit (${pool.options.query_timeout}s). Try simplifying the query or increasing DB_QUERY_TIMEOUT_SECONDS.`,
          },
        ],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: "text",
          text: `Error: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      isError: true,
    };
  } finally {
    if (startedTransaction) {
      await client.query("ROLLBACK").catch(() => {});
    }
    client.release();
  }
}

export async function runExplainQuery(
  pool: Pool,
  sql: string,
  readOnly: boolean,
  format: ExplainFormat,
): Promise<ToolResult> {
  try {
    await validateQuery(sql, readOnly);
  } catch (err) {
    if (err instanceof ValidationError) {
      return {
        content: [{ type: "text", text: err.message }],
        isError: true,
      };
    }
    throw err;
  }

  const explainSql = `EXPLAIN (FORMAT ${format.toUpperCase()}) ${sql}`;

  return runUnsafeQuery(
    pool,
    (client) => client.query(explainSql),
    (result) => {
      const rows = result.rows;
      if (rows.length === 0) {
        return "Query returned no rows";
      }

      if (format === "json") {
        return JSON.stringify(result.rows[0]?.["QUERY PLAN"], null, 2);
      }
      return result.rows.map((r) => r["QUERY PLAN"]).join("\n");
    },
  );
}

export function runSchemaQuery(pool: Pool): Promise<ToolResult> {
  return runUnsafeQuery(pool, (client) =>
    client.query(
      "SELECT schema_name FROM information_schema.schemata ORDER BY schema_name",
    ),
  );
}

export async function runListTables(pool: Pool, schema: string): Promise<ToolResult> {
  return runUnsafeQuery(pool, (client) =>
    client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name",
      [schema],
    ),
  );
}

export async function runDescribeTable(
  pool: Pool,
  schema: string,
  table: string,
): Promise<ToolResult> {
  return runUnsafeQuery(pool, (client) =>
    client.query(
      "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position",
      [schema, table],
    ),
  );
}

export function getConnectionStatus(
  pool: Pool,
  env: Env,
  sshTunnel: TunnelInfo | null,
  metadata: DatabaseMetadata,
): ToolResult {
  const status = {
    pool: {
      totalConnections: pool.totalCount,
      idleConnections: pool.idleCount,
      waitingRequests: pool.waitingCount,
    },
    database: {
      version: metadata.version,
      size: metadata.databaseSize,
      host: env.DB_HOST,
      port: env.DB_PORT,
      name: env.DB_NAME,
    },
    config: {
      readOnly: env.DB_READ_ONLY,
      maxRows: env.DB_MAX_ROWS,
      queryTimeoutSeconds: env.DB_QUERY_TIMEOUT_SECONDS,
      connectionPoolSize: env.DB_CONNECTION_POOL_SIZE,
    },
    sshTunnel: sshTunnel ? "connected" : "not configured",
  };

  return {
    content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
  };
}

export async function fetchServerMetadata(pool: Pool): Promise<DatabaseMetadata> {
  const metadata: DatabaseMetadata = { version: null, databaseSize: null };

  try {
    const [versionResult, sizeResult] = await Promise.all([
      pool.query("SELECT version()"),
      pool.query("SELECT pg_size_pretty(pg_database_size(current_database())) AS size"),
    ]);
    metadata.version = versionResult.rows[0]?.version ?? null;
    metadata.databaseSize = sizeResult.rows[0]?.size ?? null;
  } catch {
    // Non-critical — metadata will remain null
  }

  return metadata;
}

async function runUnsafeQuery(
  pool: Pool,
  queryFn: (client: PoolClient) => Promise<QueryResult>,
  formatFn?: (result: QueryResult) => string,
): Promise<ToolResult> {
  const client = await pool.connect();
  try {
    const result = await queryFn(client);

    const text = formatFn ? formatFn(result) : JSON.stringify(result.rows, null, 2);

    return {
      content: [{ type: "text", text }],
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      isError: true,
    };
  } finally {
    client.release();
  }
}

export async function createDatabasePool(
  env: Env,
  sshTunnel: TunnelInfo | null,
): Promise<Pool> {
  const ssl = resolveSSL(env);
  const db = new Pool({
    host: sshTunnel ? "127.0.0.1" : env.DB_HOST,
    port: sshTunnel ? sshTunnel.localPort : env.DB_PORT,
    database: env.DB_NAME,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    max: env.DB_CONNECTION_POOL_SIZE,
    connectionTimeoutMillis:
      env.DB_CONNECTION_TIMEOUT_MS > 0 ? env.DB_CONNECTION_TIMEOUT_MS : undefined,
    query_timeout:
      env.DB_QUERY_TIMEOUT_SECONDS > 0 ? env.DB_QUERY_TIMEOUT_SECONDS : undefined,
    ssl,
  });
  db.on("error", (err) => {
    console.error("Database error:", err);
  });
  await testDatabaseConnection(db);
  return db;
}

function resolveSSL(env: Env): boolean | { ca?: string; rejectUnauthorized?: boolean } {
  // Determine whether SSL should be enabled
  let sslEnabled = env.DB_SSL ?? !LOCALHOST_ADDRESSES.includes(env.DB_HOST);
  if (!sslEnabled) return false;

  const sslConfig: { ca?: string; rejectUnauthorized?: boolean } = {};
  if (env.DB_SSL_CA) {
    sslConfig.ca = fs.readFileSync(env.DB_SSL_CA, "utf-8");
  }
  if (!env.DB_SSL_REJECT_UNAUTHORIZED) {
    sslConfig.rejectUnauthorized = false;
  }
  return Object.keys(sslConfig).length > 0 ? sslConfig : true;
}

async function testDatabaseConnection(db: Pool) {
  try {
    const res = await db.query("SELECT 1 AS ok");

    console.error(`Database connection test successful: ${res.rows[0].ok}`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Database connection test failed: ${message}`);
    process.exit(1);
  }
}

export function fetchDatabaseMetadataAsync(poolRef: { current: Pool }): DatabaseMetadata {
  // Fetch database metadata asynchronously — does not block server startup
  const serverMetadata: DatabaseMetadata = { version: null, databaseSize: null };
  fetchServerMetadata(poolRef.current).then((meta) => {
    serverMetadata.version = meta.version;
    serverMetadata.databaseSize = meta.databaseSize;
  });
  return serverMetadata;
}
