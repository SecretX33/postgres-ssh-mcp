import { describe, it, expect } from "vitest";
import { validateQuery, ValidationError } from "../src/sql-validator.js";

describe("ValidationError", () => {
  it("is an instance of Error with a code property", () => {
    const err = new ValidationError("PARSE_ERROR", "bad sql");
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("PARSE_ERROR");
    expect(err.message).toBe("bad sql");
  });
});

describe("validateQuery – always-on checks (readOnly=false)", () => {
  it("throws EMPTY_QUERY for empty input", async () => {
    await expect(validateQuery({ sql: "", readOnly: false })).rejects.toMatchObject({
      code: "EMPTY_QUERY",
    });
  });

  it("throws MULTI_STATEMENT for multiple statements", async () => {
    await expect(
      validateQuery({ sql: "SELECT 1; DROP TABLE t", readOnly: false }),
    ).rejects.toMatchObject({
      code: "MULTI_STATEMENT",
    });
  });
});

describe("validateQuery – allowlist (readOnly=true)", () => {
  it("accepts a plain SELECT", async () => {
    await expect(
      validateQuery({ sql: "SELECT 1", readOnly: true }),
    ).resolves.toBeUndefined();
  });

  it("rejects EXPLAIN SELECT (sql must be unwrapped for explain_query)", async () => {
    await expect(
      validateQuery({
        sql: "EXPLAIN SELECT * FROM users",
        readOnly: true,
        mode: "explain",
      }),
    ).rejects.toMatchObject({ code: "EXPLAIN_UNWRAP_REQUIRED" });
  });

  it("rejects INSERT", async () => {
    await expect(
      validateQuery({ sql: "INSERT INTO t(x) VALUES (1)", readOnly: true }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN_STATEMENT",
    });
  });

  it("rejects UPDATE", async () => {
    await expect(
      validateQuery({ sql: "UPDATE t SET x = 1", readOnly: true }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN_STATEMENT",
    });
  });

  it("rejects DELETE", async () => {
    await expect(
      validateQuery({ sql: "DELETE FROM t", readOnly: true }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN_STATEMENT",
    });
  });

  it("rejects CREATE TABLE", async () => {
    await expect(
      validateQuery({ sql: "CREATE TABLE t (id INT)", readOnly: true }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN_STATEMENT",
    });
  });

  it("rejects DROP TABLE", async () => {
    await expect(
      validateQuery({ sql: "DROP TABLE t", readOnly: true }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN_STATEMENT",
    });
  });

  it("rejects TRUNCATE", async () => {
    await expect(
      validateQuery({ sql: "TRUNCATE t", readOnly: true }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN_STATEMENT",
    });
  });
});

describe("validateQuery – EXPLAIN inner check (readOnly=true)", () => {
  it("rejects EXPLAIN DELETE", async () => {
    await expect(
      validateQuery({
        sql: "EXPLAIN DELETE FROM t",
        readOnly: true,
        mode: "explain",
      }),
    ).rejects.toMatchObject({ code: "EXPLAIN_UNWRAP_REQUIRED" });
  });

  it("rejects EXPLAIN INSERT", async () => {
    await expect(
      validateQuery({
        sql: "EXPLAIN INSERT INTO t(x) VALUES (1)",
        readOnly: true,
        mode: "explain",
      }),
    ).rejects.toMatchObject({ code: "EXPLAIN_UNWRAP_REQUIRED" });
  });

  it("rejects EXPLAIN UPDATE", async () => {
    await expect(
      validateQuery({
        sql: "EXPLAIN UPDATE t SET x = 1",
        readOnly: true,
        mode: "explain",
      }),
    ).rejects.toMatchObject({ code: "EXPLAIN_UNWRAP_REQUIRED" });
  });
});

describe("validateQuery – EXPLAIN ANALYZE (readOnly=true)", () => {
  it("rejects EXPLAIN ANALYZE SELECT when mode is explain (sql must be unwrapped)", async () => {
    await expect(
      validateQuery({
        sql: "EXPLAIN ANALYZE SELECT 1",
        readOnly: true,
        mode: "explain",
      }),
    ).rejects.toMatchObject({ code: "EXPLAIN_UNWRAP_REQUIRED" });
  });

  it("rejects EXPLAIN (ANALYZE, BUFFERS) SELECT when mode is explain", async () => {
    await expect(
      validateQuery({
        sql: "EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM t",
        readOnly: true,
        mode: "explain",
      }),
    ).rejects.toMatchObject({ code: "EXPLAIN_UNWRAP_REQUIRED" });
  });

  it("rejects plain EXPLAIN SELECT (sql must be unwrapped)", async () => {
    await expect(
      validateQuery({
        sql: "EXPLAIN SELECT * FROM t",
        readOnly: true,
        mode: "explain",
      }),
    ).rejects.toMatchObject({ code: "EXPLAIN_UNWRAP_REQUIRED" });
  });

  it("rejects EXPLAIN (ANALYZE FALSE) SELECT (sql must be unwrapped)", async () => {
    await expect(
      validateQuery({
        sql: "EXPLAIN (ANALYZE FALSE) SELECT * FROM t",
        readOnly: true,
        mode: "explain",
      }),
    ).rejects.toMatchObject({ code: "EXPLAIN_UNWRAP_REQUIRED" });
  });

  it("rejects EXPLAIN (ANALYZE OFF) SELECT (sql must be unwrapped)", async () => {
    await expect(
      validateQuery({
        sql: "EXPLAIN (ANALYZE OFF) SELECT * FROM t",
        readOnly: true,
        mode: "explain",
      }),
    ).rejects.toMatchObject({ code: "EXPLAIN_UNWRAP_REQUIRED" });
  });

  it("rejects EXPLAIN ANALYZE DELETE (sql must be unwrapped, DML blocked upstream)", async () => {
    await expect(
      validateQuery({
        sql: "EXPLAIN ANALYZE DELETE FROM t",
        readOnly: true,
        mode: "explain",
      }),
    ).rejects.toMatchObject({ code: "EXPLAIN_UNWRAP_REQUIRED" });
  });

  it("rejects EXPLAIN ANALYZE SELECT with forbidden function (sql must be unwrapped)", async () => {
    await expect(
      validateQuery({
        sql: "EXPLAIN ANALYZE SELECT pg_read_file('/etc/passwd', 0, 100)",
        readOnly: true,
        mode: "explain",
      }),
    ).rejects.toMatchObject({ code: "EXPLAIN_UNWRAP_REQUIRED" });
  });

  it("rejects EXPLAIN ANALYZE via run_query (mode select)", async () => {
    await expect(
      validateQuery({
        sql: "EXPLAIN ANALYZE SELECT 1",
        readOnly: true,
        mode: "select",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_EXPLAIN_IN_QUERY" });
  });

  it("rejects EXPLAIN ANALYZE via run_query (mode select)", async () => {
    await expect(
      validateQuery({
        sql: "EXPLAIN ANALYZE SELECT 1",
        readOnly: true,
        mode: "select",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_EXPLAIN_IN_QUERY" });
  });
});

describe("validateQuery – mode option", () => {
  it("rejects EXPLAIN SELECT when mode is select", async () => {
    await expect(
      validateQuery({ sql: "EXPLAIN SELECT 1", readOnly: true, mode: "select" }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN_EXPLAIN_IN_QUERY",
      message: "Use the explain_query tool for EXPLAIN statements",
    });
  });

  it("rejects EXPLAIN SELECT when mode is explain (sql must be unwrapped)", async () => {
    await expect(
      validateQuery({ sql: "EXPLAIN SELECT 1", readOnly: true, mode: "explain" }),
    ).rejects.toMatchObject({ code: "EXPLAIN_UNWRAP_REQUIRED" });
  });

  it("rejects EXPLAIN SELECT when mode is select (default run_query path)", async () => {
    await expect(
      validateQuery({ sql: "EXPLAIN SELECT 1", readOnly: true, mode: "select" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_EXPLAIN_IN_QUERY" });
  });
});

describe("validateQuery – deep AST walk (readOnly=true)", () => {
  it("rejects mutating CTE (WITH … DELETE … SELECT)", async () => {
    await expect(
      validateQuery({
        sql: `WITH deleted AS (DELETE FROM t RETURNING id)SELECT *FROM deleted`,
        readOnly: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_NESTED_MUTATION" });
  });

  it("rejects mutating CTE (WITH … INSERT … SELECT)", async () => {
    await expect(
      validateQuery({
        sql: `WITH ins AS (INSERT INTO t(x) VALUES (1) RETURNING id) SELECT * FROM ins`,
        readOnly: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_NESTED_MUTATION" });
  });

  it("rejects MERGE inside CTE", async () => {
    await expect(
      validateQuery({
        sql: `WITH m AS (MERGE INTO t USING src ON t.id = src.id WHEN MATCHED THEN DELETE RETURNING t.id) SELECT * FROM m`,
        readOnly: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_NESTED_MUTATION" });
  });

  it("rejects SELECT INTO", async () => {
    await expect(
      validateQuery({ sql: "SELECT * INTO new_table FROM old_table", readOnly: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_SELECT_INTO" });
  });

  it("rejects SELECT FOR UPDATE", async () => {
    await expect(
      validateQuery({ sql: "SELECT * FROM t FOR UPDATE", readOnly: true }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN_LOCKING",
    });
  });

  it("rejects SELECT FOR SHARE", async () => {
    await expect(
      validateQuery({ sql: "SELECT * FROM t FOR SHARE", readOnly: true }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN_LOCKING",
    });
  });

  it("accepts a nested subquery SELECT (no mutation)", async () => {
    await expect(
      validateQuery({
        sql: "SELECT * FROM (SELECT id FROM t WHERE x > 1) sub",
        readOnly: true,
      }),
    ).resolves.toBeUndefined();
  });

  it("accepts a read-only CTE", async () => {
    await expect(
      validateQuery({
        sql: `WITH cte AS (SELECT id FROM t)SELECT *FROM cte`,
        readOnly: true,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("validateQuery – function denylist (readOnly=true)", () => {
  // File system
  it("blocks pg_read_file", async () => {
    await expect(
      validateQuery({
        sql: "SELECT pg_read_file('/etc/passwd', 0, 200)",
        readOnly: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  it("blocks pg_read_binary_file", async () => {
    await expect(
      validateQuery({
        sql: "SELECT pg_read_binary_file('pg_hba.conf', 0, 500)",
        readOnly: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  it("blocks pg_ls_dir", async () => {
    await expect(
      validateQuery({ sql: "SELECT pg_ls_dir('.')", readOnly: true }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN_FUNCTION",
    });
  });

  it("blocks pg_file_write (adminpack)", async () => {
    await expect(
      validateQuery({
        sql: "SELECT pg_file_write('/tmp/evil.sh', 'data', false)",
        readOnly: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  // Server administration
  it("blocks pg_reload_conf", async () => {
    await expect(
      validateQuery({ sql: "SELECT pg_reload_conf()", readOnly: true }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN_FUNCTION",
    });
  });

  it("blocks pg_terminate_backend", async () => {
    await expect(
      validateQuery({ sql: "SELECT pg_terminate_backend(1234)", readOnly: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  it("blocks pg_cancel_backend (with nested call)", async () => {
    await expect(
      validateQuery({
        sql: "SELECT pg_cancel_backend(pg_backend_pid())",
        readOnly: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  // Advisory locks
  it("blocks pg_advisory_lock", async () => {
    await expect(
      validateQuery({ sql: "SELECT pg_advisory_lock(99999)", readOnly: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  it("blocks pg_try_advisory_lock", async () => {
    await expect(
      validateQuery({ sql: "SELECT pg_try_advisory_lock(99998)", readOnly: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  it("blocks pg_advisory_xact_lock", async () => {
    await expect(
      validateQuery({ sql: "SELECT pg_advisory_xact_lock(77777)", readOnly: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  // Advisory unlock
  it("blocks pg_advisory_unlock", async () => {
    await expect(
      validateQuery({ sql: "SELECT pg_advisory_unlock(99999)", readOnly: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  it("blocks pg_advisory_unlock_shared", async () => {
    await expect(
      validateQuery({ sql: "SELECT pg_advisory_unlock_shared(99999)", readOnly: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  it("blocks pg_advisory_unlock_all", async () => {
    await expect(
      validateQuery({ sql: "SELECT pg_advisory_unlock_all()", readOnly: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  // Async messaging
  it("blocks pg_notify", async () => {
    await expect(
      validateQuery({ sql: "SELECT pg_notify('chan', 'payload')", readOnly: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  // DoS
  it("blocks pg_sleep", async () => {
    await expect(
      validateQuery({ sql: "SELECT pg_sleep(30)", readOnly: true }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN_FUNCTION",
    });
  });

  // Sequences
  it("blocks nextval", async () => {
    await expect(
      validateQuery({ sql: "SELECT nextval('users_id_seq')", readOnly: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  it("blocks setval", async () => {
    await expect(
      validateQuery({ sql: "SELECT setval('users_id_seq', 1)", readOnly: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  // Session state
  it("blocks set_config", async () => {
    await expect(
      validateQuery({
        sql: "SELECT set_config('session_replication_role', 'replica', false)",
        readOnly: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  // Arbitrary SQL execution
  it("blocks query_to_xml", async () => {
    await expect(
      validateQuery({
        sql: "SELECT query_to_xml('DELETE FROM users', true, true, '')",
        readOnly: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  // dblink
  it("blocks dblink", async () => {
    await expect(
      validateQuery({
        sql: "SELECT * FROM dblink('dbname=x', 'DROP TABLE users') AS t(r text)",
        readOnly: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  // Large objects
  it("blocks lo_creat", async () => {
    await expect(
      validateQuery({ sql: "SELECT lo_creat(-1)", readOnly: true }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN_FUNCTION",
    });
  });

  // Schema-qualified calls
  it("blocks schema-qualified pg_catalog.pg_read_file", async () => {
    await expect(
      validateQuery({
        sql: "SELECT pg_catalog.pg_read_file('/etc/passwd', 0, 100)",
        readOnly: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  // Placement: inside subquery
  it("blocks dangerous function inside subquery", async () => {
    await expect(
      validateQuery({
        sql: "SELECT * FROM (SELECT pg_read_file('/etc/passwd', 0, 100)) s",
        readOnly: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  // Placement: inside CTE
  it("blocks dangerous function inside CTE", async () => {
    await expect(
      validateQuery({
        sql: "WITH x AS (SELECT pg_reload_conf()) SELECT * FROM x",
        readOnly: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  // Allow-list: safe pg_ functions
  it("allows safe pg_ functions (pg_typeof, pg_size_pretty)", async () => {
    await expect(
      validateQuery({ sql: "SELECT pg_typeof(1), pg_size_pretty(1024)", readOnly: true }),
    ).resolves.toBeUndefined();
  });

  // Allow-list: aggregate functions
  it("allows aggregate functions (count, sum)", async () => {
    await expect(
      validateQuery({ sql: "SELECT count(*), sum(id) FROM t", readOnly: true }),
    ).resolves.toBeUndefined();
  });

  // Allow-list: currval is read-only
  it("allows currval (read-only sequence function)", async () => {
    await expect(
      validateQuery({ sql: "SELECT currval('users_id_seq')", readOnly: true }),
    ).resolves.toBeUndefined();
  });
});

describe("validateQuery – expanded function denylist (readOnly=true)", () => {
  // binary_upgrade_*
  it("blocks binary_upgrade_set_next_pg_type_oid", async () => {
    await expect(
      validateQuery({
        sql: "SELECT binary_upgrade_set_next_pg_type_oid(1::oid)",
        readOnly: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  // GIN/BRIN maintenance
  it("blocks gin_clean_pending_list", async () => {
    await expect(
      validateQuery({
        sql: "SELECT gin_clean_pending_list('myidx'::regclass)",
        readOnly: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });
  it("blocks brin_summarize_new_values", async () => {
    await expect(
      validateQuery({
        sql: "SELECT brin_summarize_new_values('myidx'::regclass)",
        readOnly: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  // Bulk XML
  it("blocks database_to_xml", async () => {
    await expect(
      validateQuery({ sql: "SELECT database_to_xml(true, true, '')", readOnly: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });
  it("blocks schema_to_xml", async () => {
    await expect(
      validateQuery({
        sql: "SELECT schema_to_xml('public', true, true, '')",
        readOnly: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });
  it("blocks table_to_xml", async () => {
    await expect(
      validateQuery({
        sql: "SELECT table_to_xml('mytable'::regclass, true, true, '')",
        readOnly: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  // lo writes
  it("blocks lo_from_bytea", async () => {
    await expect(
      validateQuery({ sql: "SELECT lo_from_bytea(0, '\\xDEAD'::bytea)", readOnly: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });
  it("blocks lo_put", async () => {
    await expect(
      validateQuery({ sql: "SELECT lo_put(16384, 0, '\\xDEAD'::bytea)", readOnly: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  // WAL replay
  it("blocks pg_wal_replay_pause", async () => {
    await expect(
      validateQuery({ sql: "SELECT pg_wal_replay_pause()", readOnly: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });
  it("blocks pg_wal_replay_resume", async () => {
    await expect(
      validateQuery({ sql: "SELECT pg_wal_replay_resume()", readOnly: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  // Stats
  it("blocks pg_stat_clear_snapshot", async () => {
    await expect(
      validateQuery({ sql: "SELECT pg_stat_clear_snapshot()", readOnly: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });
  it("blocks pg_stat_force_next_flush", async () => {
    await expect(
      validateQuery({ sql: "SELECT pg_stat_force_next_flush()", readOnly: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });
  it("blocks pg_stat_reset_subscription_stats", async () => {
    await expect(
      validateQuery({
        sql: "SELECT pg_stat_reset_subscription_stats(1::oid)",
        readOnly: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  // PG15+ backup names
  it("blocks pg_backup_start", async () => {
    await expect(
      validateQuery({ sql: "SELECT pg_backup_start('label')", readOnly: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });
  it("blocks pg_backup_stop", async () => {
    await expect(
      validateQuery({ sql: "SELECT pg_backup_stop()", readOnly: true }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN_FUNCTION",
    });
  });

  // Settings / config disclosure
  it("blocks pg_show_all_settings", async () => {
    await expect(
      validateQuery({ sql: "SELECT * FROM pg_show_all_settings()", readOnly: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });
  it("blocks pg_show_all_file_settings", async () => {
    await expect(
      validateQuery({ sql: "SELECT * FROM pg_show_all_file_settings()", readOnly: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });
  it("blocks pg_config", async () => {
    await expect(
      validateQuery({ sql: "SELECT * FROM pg_config()", readOnly: true }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN_FUNCTION",
    });
  });

  // Replication origin
  it("blocks pg_replication_origin_create", async () => {
    await expect(
      validateQuery({
        sql: "SELECT pg_replication_origin_create('my_origin')",
        readOnly: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });
  it("blocks pg_replication_origin_drop", async () => {
    await expect(
      validateQuery({
        sql: "SELECT pg_replication_origin_drop('my_origin')",
        readOnly: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });
  it("blocks pg_replication_origin_advance", async () => {
    await expect(
      validateQuery({
        sql: "SELECT pg_replication_origin_advance('my_origin', '0/1'::pg_lsn)",
        readOnly: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  // Memory layout
  it("blocks pg_get_shmem_allocations", async () => {
    await expect(
      validateQuery({ sql: "SELECT * FROM pg_get_shmem_allocations()", readOnly: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });
  it("blocks pg_get_backend_memory_contexts", async () => {
    await expect(
      validateQuery({
        sql: "SELECT * FROM pg_get_backend_memory_contexts()",
        readOnly: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  // Extension mutations
  it("blocks pg_extension_config_dump", async () => {
    await expect(
      validateQuery({
        sql: "SELECT pg_extension_config_dump('mytable', '')",
        readOnly: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  // system
  it("blocks system", async () => {
    await expect(
      validateQuery({ sql: "SELECT system('ls')", readOnly: true }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN_FUNCTION",
    });
  });

  // Logical slot peek binary (missing from old list)
  it("blocks pg_logical_slot_peek_binary_changes", async () => {
    await expect(
      validateQuery({
        sql: "SELECT * FROM pg_logical_slot_peek_binary_changes('slot', NULL, NULL)",
        readOnly: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  // Legacy file read
  it("blocks pg_read_file_old", async () => {
    await expect(
      validateQuery({
        sql: "SELECT pg_read_file_old('pg_hba.conf', 0, 1000)",
        readOnly: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  // Additional ls dirs
  it("blocks pg_ls_archive_statusdir", async () => {
    await expect(
      validateQuery({ sql: "SELECT * FROM pg_ls_archive_statusdir()", readOnly: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  // PostGIS metadata mutation
  it("blocks populate_geometry_columns", async () => {
    await expect(
      validateQuery({ sql: "SELECT populate_geometry_columns()", readOnly: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  // pg_trgm session-level state mutation
  it("blocks set_limit", async () => {
    await expect(
      validateQuery({ sql: "SELECT set_limit(0.1)", readOnly: true }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN_FUNCTION",
    });
  });

  // PostGIS admin functions (internal DDL/DML via EXECUTE)
  it("blocks addgeometrycolumn", async () => {
    await expect(
      validateQuery({
        sql: "SELECT addgeometrycolumn('public', 'mytable', 'geom', 4326, 'POINT', 2)",
        readOnly: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });
  it("blocks dropgeometrycolumn", async () => {
    await expect(
      validateQuery({
        sql: "SELECT dropgeometrycolumn('public', 'mytable', 'geom')",
        readOnly: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });
  it("blocks dropgeometrytable", async () => {
    await expect(
      validateQuery({
        sql: "SELECT dropgeometrytable('public', 'mytable')",
        readOnly: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });
  it("blocks updategeometrysrid", async () => {
    await expect(
      validateQuery({
        sql: "SELECT updategeometrysrid('public', 'mytable', 'geom', 4326)",
        readOnly: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });
  it("blocks postgis_extensions_upgrade", async () => {
    await expect(
      validateQuery({ sql: "SELECT postgis_extensions_upgrade()", readOnly: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });
});

describe("validateQuery – allowlist skipped (readOnly=false)", () => {
  it("allows DELETE when readOnly=false", async () => {
    await expect(
      validateQuery({ sql: "DELETE FROM t", readOnly: false }),
    ).resolves.toBeUndefined();
  });

  it("allows INSERT when readOnly=false", async () => {
    await expect(
      validateQuery({ sql: "INSERT INTO t(x) VALUES (1)", readOnly: false }),
    ).resolves.toBeUndefined();
  });
});
