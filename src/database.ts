import { Pool, type PoolClient, type QueryResult } from "pg";
import type { TunnelInfo } from "./ssh-tunnel.js";
import type { Env } from "./config.js";
import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { validateReadOnlyQuery, ValidationError } from "./sql-validator.js";

export type ToolResult = Awaited<ReturnType<ToolCallback>>;

export async function runQuery(
  pool: Pool,
  sql: string,
  readOnly: boolean,
): Promise<ToolResult> {
  if (readOnly) {
    try {
      await validateReadOnlyQuery(sql);
    } catch (err) {
      if (err instanceof ValidationError) {
        return {
          content: [{ type: "text", text: err.message }],
          isError: true,
        };
      }
      throw err;
    }
  }

  const client = await pool.connect();
  let startedTransaction = false;

  try {
    if (readOnly) {
      await client.query("BEGIN TRANSACTION READ ONLY");
      startedTransaction = true;
    }
    const result = await client.query(sql);

    const text =
      result.rows.length === 0
        ? "Query returned no rows"
        : JSON.stringify({ rows: result.rows, rowCount: result.rowCount }, null, 2);

    return {
      content: [{ type: "text", text: text }],
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
    if (startedTransaction) {
      await client.query("ROLLBACK").catch(() => {});
    }
    client.release();
  }
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

async function runUnsafeQuery(
  pool: Pool,
  runQuery: (client: PoolClient) => Promise<QueryResult>,
): Promise<ToolResult> {
  const client = await pool.connect();
  try {
    const result = await runQuery(client);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result.rows, null, 2),
        },
      ],
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
  const db = new Pool({
    host: sshTunnel ? "127.0.0.1" : env.DB_HOST,
    port: sshTunnel ? sshTunnel.localPort : env.DB_PORT,
    database: env.DB_NAME,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    max: 5,
    connectionTimeoutMillis: 10000,
    ssl: env.DB_ENABLE_SSL,
  });
  db.on("error", (err) => {
    console.error("Database error:", err);
  });
  await testDatabaseConnection(db);
  return db;
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
