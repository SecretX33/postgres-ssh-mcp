import { Pool, type PoolClient, type PoolOptions, type QueryResult } from "pg";
import * as fs from "node:fs";
import type { TunnelInfo } from "./ssh-tunnel.js";
import type { Env } from "./config.js";
import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { validateQuery, ValidationError } from "./sql-validator.js";
import { z } from "zod";

export type ToolResult = Awaited<ReturnType<ToolCallback>>;

export const EXPLAIN_FORMATS = ["text", "json", "yaml", "xml"] as const;
export const EXPLAIN_FORMAT_SCHEMA = z.enum(EXPLAIN_FORMATS);
export type ExplainFormat = z.infer<typeof EXPLAIN_FORMAT_SCHEMA>;

export const SERIALIZE_VALUES = ["none", "text", "binary"] as const;
export const SERIALIZE_SCHEMA = z.enum(SERIALIZE_VALUES);
export type SerializeValue = z.infer<typeof SERIALIZE_SCHEMA>;

export interface ExplainOptions {
  analyze?: boolean;
  verbose?: boolean;
  costs?: boolean;
  settings?: boolean;
  generic_plan?: boolean;
  buffers?: boolean;
  serialize?: SerializeValue;
  wal?: boolean;
  timing?: boolean;
  summary?: boolean;
  memory?: boolean;
  format?: ExplainFormat;
}

/**
 * Builds the `EXPLAIN (...)` prefix from the provided options.
 * Only explicitly provided options are included in the clause.
 * FORMAT defaults to TEXT if not specified.
 */
export function buildExplainPrefix(options: ExplainOptions): string {
  const parts: string[] = [];

  const booleanOptions: { key: keyof ExplainOptions; sql: string }[] = [
    { key: "analyze", sql: "ANALYZE" },
    { key: "verbose", sql: "VERBOSE" },
    { key: "costs", sql: "COSTS" },
    { key: "settings", sql: "SETTINGS" },
    { key: "generic_plan", sql: "GENERIC_PLAN" },
    { key: "buffers", sql: "BUFFERS" },
    { key: "wal", sql: "WAL" },
    { key: "timing", sql: "TIMING" },
    { key: "summary", sql: "SUMMARY" },
    { key: "memory", sql: "MEMORY" },
  ];

  for (const { key, sql } of booleanOptions) {
    const val = options[key];
    if (typeof val === "boolean") {
      parts.push(`${sql} ${val ? "TRUE" : "FALSE"}`);
    }
  }

  if (options.serialize && options.serialize !== "none") {
    parts.push(`SERIALIZE ${options.serialize.toUpperCase()}`);
  }

  const format = (options.format ?? "text").toUpperCase();
  parts.push(`FORMAT ${format}`);

  return `EXPLAIN (${parts.join(", ")})`;
}

export interface DatabaseMetadata {
  version: string | null;
  databaseSize: string | null;
}

export async function runQuery(
  pool: Pool,
  sql: string,
  readOnly: boolean,
  maxRows: number,
  params?: (string | number | boolean | null)[],
): Promise<ToolResult> {
  const validationError = await validateUserProvidedQuery({
    sql,
    readOnly,
    mode: "select",
  });
  if (validationError) return validationError;

  return await withClient({
    pool,
    runInReadOnlyTransaction: readOnly,
    blockFn: async (client) => {
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

      const structuredContent = {
        rows,
        rowCount: rows.length,
        ...(truncated ? { truncated } : {}),
      };
      const text =
        rows.length === 0
          ? "Query returned no rows"
          : JSON.stringify(structuredContent, null, 2);

      return {
        content: [{ type: "text", text }],
        structuredContent,
      };
    },
  });
}

export async function runExplainQuery(
  pool: Pool,
  sql: string,
  readOnly: boolean,
  options: ExplainOptions,
): Promise<ToolResult> {
  const validationError = await validateUserProvidedQuery({
    sql,
    readOnly,
    mode: "explain",
  });
  if (validationError) return validationError;

  const explainSql = `${buildExplainPrefix(options)} ${sql}`;

  return doRunQuery({
    pool,
    queryFn: (client) => client.query(explainSql),
    customFormatResult: (result) => {
      const rows = result.rows as Record<string, string>[];
      if (rows.length === 0) {
        return { text: "Query returned no rows" };
      }
      const plan = result.rows
        .map((it) => {
          const val = it["QUERY PLAN"];
          return typeof val === "string" ? val : JSON.stringify(val, null, 2);
        })
        .filter((it) => it != null)
        .join("\n");
      if (!plan) {
        return {
          text: `Query returned ${rows.length} rows, but no QUERY PLAN was found`,
        };
      }
      return { text: plan };
    },
  });
}

export function runSchemaQuery(pool: Pool): Promise<ToolResult> {
  return doRunQuery({
    pool,
    queryFn: (client) =>
      client.query(
        "SELECT schema_name FROM information_schema.schemata ORDER BY schema_name",
      ),
    runInReadOnlyTransaction: false, // SAFE: list schemas does not modify data
  });
}

export async function runListTables(pool: Pool, schema: string): Promise<ToolResult> {
  return doRunQuery({
    pool,
    queryFn: (client) =>
      client.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name",
        [schema],
      ),
    runInReadOnlyTransaction: false, // SAFE: list tables does not modify data, and 'schema' param is taken as a safe query param
  });
}

export async function runDescribeTable(
  pool: Pool,
  schema: string,
  table: string,
): Promise<ToolResult> {
  return doRunQuery({
    pool,
    queryFn: (client) =>
      client.query(
        "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position",
        [schema, table],
      ),
    runInReadOnlyTransaction: false, // SAFE: describe table does not modify data, and 'schema' and 'table' params are taken as safe query params
  });
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
      queryTimeoutMs: env.DB_QUERY_TIMEOUT_MS,
      connectionPoolSize: env.DB_CONNECTION_POOL_SIZE,
    },
    sshTunnel: sshTunnel ? "connected" : "not configured",
  };

  return {
    content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
    structuredContent: status,
  };
}

async function doRunQuery({
  pool,
  runInReadOnlyTransaction = true,
  queryFn,
  customFormatResult,
}: {
  pool: Pool;
  runInReadOnlyTransaction?: boolean;
  queryFn: (client: PoolClient) => Promise<QueryResult>;
  customFormatResult?: (result: QueryResult) => {
    text: string;
    structuredContent?: Record<string, unknown>;
  };
}): Promise<ToolResult> {
  const handler = async (client: PoolClient): Promise<ToolResult> => {
    const result = await queryFn(client);

    if (customFormatResult) {
      const { text, structuredContent } = customFormatResult(result);
      return {
        content: [{ type: "text", text }],
        structuredContent,
      };
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }],
      structuredContent: { rows: result.rows },
    };
  };
  return await withClient({ pool, runInReadOnlyTransaction, blockFn: handler });
}

/**
 * Acquires a DB client from the pool, runs the provided function, and releases the
 * client back to the pool.
 *
 * Automatically maps errors thrown while acquiring a DB client or by {@link blockFn}
 * to {@link ToolResult}.
 */
async function withClient(input: {
  pool: Pool;
  runInReadOnlyTransaction?: boolean;
  blockFn: (client: PoolClient) => Promise<ToolResult>;
}): Promise<ToolResult> {
  try {
    return await withRawClient({
      ...input,
      runInReadOnlyTransaction: input.runInReadOnlyTransaction ?? true,
    });
  } catch (err) {
    return buildErrorResult(err, input.pool.options);
  }
}

/**
 * Same as {@link withClient}, but without any automatic error mapping.
 */
async function withRawClient<T>({
  pool,
  runInReadOnlyTransaction = true,
  blockFn,
}: {
  pool: Pool;
  runInReadOnlyTransaction: boolean;
  blockFn: (client: PoolClient) => Promise<T>;
}): Promise<T> {
  const client = await pool.connect();
  let startedTransaction = false;

  try {
    if (runInReadOnlyTransaction) {
      await client.query("BEGIN TRANSACTION READ ONLY");
      startedTransaction = true;
    }

    return await blockFn(client);
  } finally {
    if (startedTransaction) {
      await client.query("ROLLBACK").catch(() => {});
    }
    client.release();
  }
}

function buildErrorResult(error: unknown, poolOptions: PoolOptions): ToolResult {
  if (error instanceof Error && error.message === "Query read timeout") {
    return {
      content: [
        {
          type: "text",
          text: `Query timed out. The query exceeded the configured time limit${poolOptions.query_timeout ? ` (${poolOptions.query_timeout}ms)` : ""}. Try simplifying the query or increasing DB_QUERY_TIMEOUT_MS.`,
        },
      ],
      isError: true,
    };
  }
  return {
    content: [
      {
        type: "text",
        text: `Error: ${error instanceof Error ? error.message : String(error)}`,
      },
    ],
    isError: true,
  };
}

async function validateUserProvidedQuery(
  input: Parameters<typeof validateQuery>[0],
): Promise<ToolResult | null> {
  try {
    await validateQuery(input);
  } catch (err) {
    if (err instanceof ValidationError) {
      return {
        content: [{ type: "text", text: err.message }],
        isError: true,
      };
    }
    throw err;
  }
  return null;
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
    query_timeout: env.DB_QUERY_TIMEOUT_MS > 0 ? env.DB_QUERY_TIMEOUT_MS : undefined,
    ssl,
  });
  db.on("error", (err) => {
    console.error("Database error:", err);
  });
  await testDatabaseConnection(db);
  return db;
}

function resolveSSL(env: Env): boolean | { ca?: string; rejectUnauthorized?: boolean } {
  if (!env.DB_SSL) return false;

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
  const serverMetadata: DatabaseMetadata = { version: null, databaseSize: null };
  fetchServerMetadata(poolRef.current).then((meta) => {
    serverMetadata.version = meta.version;
    serverMetadata.databaseSize = meta.databaseSize;
  });
  return serverMetadata;
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
