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
    await expect(validateQuery("", false)).rejects.toMatchObject({
      code: "EMPTY_QUERY",
    });
  });

  it("throws MULTI_STATEMENT for multiple statements", async () => {
    await expect(validateQuery("SELECT 1; DROP TABLE t", false)).rejects.toMatchObject({
      code: "MULTI_STATEMENT",
    });
  });
});

describe("validateQuery – allowlist (readOnly=true)", () => {
  it("accepts a plain SELECT", async () => {
    await expect(validateQuery("SELECT 1", true)).resolves.toBeUndefined();
  });

  it("accepts EXPLAIN SELECT", async () => {
    await expect(
      validateQuery("EXPLAIN SELECT * FROM users", true),
    ).resolves.toBeUndefined();
  });

  it("rejects INSERT", async () => {
    await expect(
      validateQuery("INSERT INTO t(x) VALUES (1)", true),
    ).rejects.toMatchObject({
      code: "FORBIDDEN_STATEMENT",
    });
  });

  it("rejects UPDATE", async () => {
    await expect(validateQuery("UPDATE t SET x = 1", true)).rejects.toMatchObject({
      code: "FORBIDDEN_STATEMENT",
    });
  });

  it("rejects DELETE", async () => {
    await expect(validateQuery("DELETE FROM t", true)).rejects.toMatchObject({
      code: "FORBIDDEN_STATEMENT",
    });
  });

  it("rejects CREATE TABLE", async () => {
    await expect(validateQuery("CREATE TABLE t (id INT)", true)).rejects.toMatchObject({
      code: "FORBIDDEN_STATEMENT",
    });
  });

  it("rejects DROP TABLE", async () => {
    await expect(validateQuery("DROP TABLE t", true)).rejects.toMatchObject({
      code: "FORBIDDEN_STATEMENT",
    });
  });

  it("rejects TRUNCATE", async () => {
    await expect(validateQuery("TRUNCATE t", true)).rejects.toMatchObject({
      code: "FORBIDDEN_STATEMENT",
    });
  });
});

describe("validateQuery – EXPLAIN inner check (readOnly=true)", () => {
  it("rejects EXPLAIN DELETE", async () => {
    await expect(validateQuery("EXPLAIN DELETE FROM t", true)).rejects.toMatchObject({
      code: "FORBIDDEN_EXPLAIN_TARGET",
    });
  });

  it("rejects EXPLAIN INSERT", async () => {
    await expect(
      validateQuery("EXPLAIN INSERT INTO t(x) VALUES (1)", true),
    ).rejects.toMatchObject({ code: "FORBIDDEN_EXPLAIN_TARGET" });
  });

  it("rejects EXPLAIN UPDATE", async () => {
    await expect(validateQuery("EXPLAIN UPDATE t SET x = 1", true)).rejects.toMatchObject(
      {
        code: "FORBIDDEN_EXPLAIN_TARGET",
      },
    );
  });
});

describe("validateQuery – EXPLAIN ANALYZE (readOnly=true)", () => {
  it("rejects EXPLAIN ANALYZE SELECT", async () => {
    await expect(validateQuery("EXPLAIN ANALYZE SELECT 1", true)).rejects.toMatchObject({
      code: "FORBIDDEN_EXPLAIN_ANALYZE",
    });
  });

  it("rejects EXPLAIN (ANALYZE, BUFFERS) SELECT", async () => {
    await expect(
      validateQuery("EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM t", true),
    ).rejects.toMatchObject({ code: "FORBIDDEN_EXPLAIN_ANALYZE" });
  });

  it("accepts plain EXPLAIN SELECT", async () => {
    await expect(validateQuery("EXPLAIN SELECT * FROM t", true)).resolves.toBeUndefined();
  });

  it("accepts EXPLAIN (ANALYZE FALSE) SELECT", async () => {
    await expect(
      validateQuery("EXPLAIN (ANALYZE FALSE) SELECT * FROM t", true),
    ).resolves.toBeUndefined();
  });

  it("accepts EXPLAIN (ANALYZE OFF) SELECT", async () => {
    await expect(
      validateQuery("EXPLAIN (ANALYZE OFF) SELECT * FROM t", true),
    ).resolves.toBeUndefined();
  });
});

describe("validateQuery – deep AST walk (readOnly=true)", () => {
  it("rejects mutating CTE (WITH … DELETE … SELECT)", async () => {
    await expect(
      validateQuery(
        `WITH deleted AS (DELETE FROM t RETURNING id)SELECT *FROM deleted`,
        true,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN_NESTED_MUTATION" });
  });

  it("rejects mutating CTE (WITH … INSERT … SELECT)", async () => {
    await expect(
      validateQuery(
        `WITH ins AS (INSERT INTO t(x) VALUES (1) RETURNING id) SELECT * FROM ins`,
        true,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN_NESTED_MUTATION" });
  });

  it("rejects MERGE inside CTE", async () => {
    await expect(
      validateQuery(
        `WITH m AS (MERGE INTO t USING src ON t.id = src.id WHEN MATCHED THEN DELETE RETURNING t.id) SELECT * FROM m`,
        true,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN_NESTED_MUTATION" });
  });

  it("rejects SELECT INTO", async () => {
    await expect(
      validateQuery("SELECT * INTO new_table FROM old_table", true),
    ).rejects.toMatchObject({ code: "FORBIDDEN_SELECT_INTO" });
  });

  it("rejects SELECT FOR UPDATE", async () => {
    await expect(validateQuery("SELECT * FROM t FOR UPDATE", true)).rejects.toMatchObject(
      {
        code: "FORBIDDEN_LOCKING",
      },
    );
  });

  it("rejects SELECT FOR SHARE", async () => {
    await expect(validateQuery("SELECT * FROM t FOR SHARE", true)).rejects.toMatchObject({
      code: "FORBIDDEN_LOCKING",
    });
  });

  it("accepts a nested subquery SELECT (no mutation)", async () => {
    await expect(
      validateQuery("SELECT * FROM (SELECT id FROM t WHERE x > 1) sub", true),
    ).resolves.toBeUndefined();
  });

  it("accepts a read-only CTE", async () => {
    await expect(
      validateQuery(`WITH cte AS (SELECT id FROM t)SELECT *FROM cte`, true),
    ).resolves.toBeUndefined();
  });
});

describe("validateQuery – function denylist (readOnly=true)", () => {
  // File system
  it("blocks pg_read_file", async () => {
    await expect(
      validateQuery("SELECT pg_read_file('/etc/passwd', 0, 200)", true),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  it("blocks pg_read_binary_file", async () => {
    await expect(
      validateQuery("SELECT pg_read_binary_file('pg_hba.conf', 0, 500)", true),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  it("blocks pg_ls_dir", async () => {
    await expect(validateQuery("SELECT pg_ls_dir('.')", true)).rejects.toMatchObject({
      code: "FORBIDDEN_FUNCTION",
    });
  });

  it("blocks pg_file_write (adminpack)", async () => {
    await expect(
      validateQuery("SELECT pg_file_write('/tmp/evil.sh', 'data', false)", true),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  // Server administration
  it("blocks pg_reload_conf", async () => {
    await expect(validateQuery("SELECT pg_reload_conf()", true)).rejects.toMatchObject({
      code: "FORBIDDEN_FUNCTION",
    });
  });

  it("blocks pg_terminate_backend", async () => {
    await expect(
      validateQuery("SELECT pg_terminate_backend(1234)", true),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  it("blocks pg_cancel_backend (with nested call)", async () => {
    await expect(
      validateQuery("SELECT pg_cancel_backend(pg_backend_pid())", true),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  // Advisory locks
  it("blocks pg_advisory_lock", async () => {
    await expect(
      validateQuery("SELECT pg_advisory_lock(99999)", true),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  it("blocks pg_try_advisory_lock", async () => {
    await expect(
      validateQuery("SELECT pg_try_advisory_lock(99998)", true),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  it("blocks pg_advisory_xact_lock", async () => {
    await expect(
      validateQuery("SELECT pg_advisory_xact_lock(77777)", true),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  // Async messaging
  it("blocks pg_notify", async () => {
    await expect(
      validateQuery("SELECT pg_notify('chan', 'payload')", true),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  // DoS
  it("blocks pg_sleep", async () => {
    await expect(validateQuery("SELECT pg_sleep(30)", true)).rejects.toMatchObject({
      code: "FORBIDDEN_FUNCTION",
    });
  });

  // Sequences
  it("blocks nextval", async () => {
    await expect(
      validateQuery("SELECT nextval('users_id_seq')", true),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  it("blocks setval", async () => {
    await expect(
      validateQuery("SELECT setval('users_id_seq', 1)", true),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  // Session state
  it("blocks set_config", async () => {
    await expect(
      validateQuery(
        "SELECT set_config('session_replication_role', 'replica', false)",
        true,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  // Arbitrary SQL execution
  it("blocks query_to_xml", async () => {
    await expect(
      validateQuery("SELECT query_to_xml('DELETE FROM users', true, true, '')", true),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  // dblink
  it("blocks dblink", async () => {
    await expect(
      validateQuery(
        "SELECT * FROM dblink('dbname=x', 'DROP TABLE users') AS t(r text)",
        true,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  // Large objects
  it("blocks lo_creat", async () => {
    await expect(validateQuery("SELECT lo_creat(-1)", true)).rejects.toMatchObject({
      code: "FORBIDDEN_FUNCTION",
    });
  });

  // Schema-qualified calls
  it("blocks schema-qualified pg_catalog.pg_read_file", async () => {
    await expect(
      validateQuery("SELECT pg_catalog.pg_read_file('/etc/passwd', 0, 100)", true),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  // Placement: inside subquery
  it("blocks dangerous function inside subquery", async () => {
    await expect(
      validateQuery("SELECT * FROM (SELECT pg_read_file('/etc/passwd', 0, 100)) s", true),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  // Placement: inside CTE
  it("blocks dangerous function inside CTE", async () => {
    await expect(
      validateQuery("WITH x AS (SELECT pg_reload_conf()) SELECT * FROM x", true),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  // Allow-list: safe pg_ functions
  it("allows safe pg_ functions (pg_typeof, pg_size_pretty)", async () => {
    await expect(
      validateQuery("SELECT pg_typeof(1), pg_size_pretty(1024)", true),
    ).resolves.toBeUndefined();
  });

  // Allow-list: aggregate functions
  it("allows aggregate functions (count, sum)", async () => {
    await expect(
      validateQuery("SELECT count(*), sum(id) FROM t", true),
    ).resolves.toBeUndefined();
  });

  // Allow-list: currval is read-only
  it("allows currval (read-only sequence function)", async () => {
    await expect(
      validateQuery("SELECT currval('users_id_seq')", true),
    ).resolves.toBeUndefined();
  });
});

describe("validateQuery – expanded function denylist (readOnly=true)", () => {
  // binary_upgrade_*
  it("blocks binary_upgrade_set_next_pg_type_oid", async () => {
    await expect(
      validateQuery("SELECT binary_upgrade_set_next_pg_type_oid(1::oid)", true),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  // GIN/BRIN maintenance
  it("blocks gin_clean_pending_list", async () => {
    await expect(
      validateQuery("SELECT gin_clean_pending_list('myidx'::regclass)", true),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });
  it("blocks brin_summarize_new_values", async () => {
    await expect(
      validateQuery("SELECT brin_summarize_new_values('myidx'::regclass)", true),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  // Bulk XML
  it("blocks database_to_xml", async () => {
    await expect(
      validateQuery("SELECT database_to_xml(true, true, '')", true),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });
  it("blocks schema_to_xml", async () => {
    await expect(
      validateQuery("SELECT schema_to_xml('public', true, true, '')", true),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });
  it("blocks table_to_xml", async () => {
    await expect(
      validateQuery("SELECT table_to_xml('mytable'::regclass, true, true, '')", true),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  // lo writes
  it("blocks lo_from_bytea", async () => {
    await expect(
      validateQuery("SELECT lo_from_bytea(0, '\\xDEAD'::bytea)", true),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });
  it("blocks lo_put", async () => {
    await expect(
      validateQuery("SELECT lo_put(16384, 0, '\\xDEAD'::bytea)", true),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  // WAL replay
  it("blocks pg_wal_replay_pause", async () => {
    await expect(
      validateQuery("SELECT pg_wal_replay_pause()", true),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });
  it("blocks pg_wal_replay_resume", async () => {
    await expect(
      validateQuery("SELECT pg_wal_replay_resume()", true),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  // Stats
  it("blocks pg_stat_clear_snapshot", async () => {
    await expect(
      validateQuery("SELECT pg_stat_clear_snapshot()", true),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });
  it("blocks pg_stat_force_next_flush", async () => {
    await expect(
      validateQuery("SELECT pg_stat_force_next_flush()", true),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });
  it("blocks pg_stat_reset_subscription_stats", async () => {
    await expect(
      validateQuery("SELECT pg_stat_reset_subscription_stats(1::oid)", true),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  // PG15+ backup names
  it("blocks pg_backup_start", async () => {
    await expect(
      validateQuery("SELECT pg_backup_start('label')", true),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });
  it("blocks pg_backup_stop", async () => {
    await expect(
      validateQuery("SELECT pg_backup_stop()", true),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  // Settings / config disclosure
  it("blocks pg_show_all_settings", async () => {
    await expect(
      validateQuery("SELECT * FROM pg_show_all_settings()", true),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });
  it("blocks pg_show_all_file_settings", async () => {
    await expect(
      validateQuery("SELECT * FROM pg_show_all_file_settings()", true),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });
  it("blocks pg_config", async () => {
    await expect(
      validateQuery("SELECT * FROM pg_config()", true),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  // Replication origin
  it("blocks pg_replication_origin_create", async () => {
    await expect(
      validateQuery("SELECT pg_replication_origin_create('my_origin')", true),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });
  it("blocks pg_replication_origin_drop", async () => {
    await expect(
      validateQuery("SELECT pg_replication_origin_drop('my_origin')", true),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });
  it("blocks pg_replication_origin_advance", async () => {
    await expect(
      validateQuery(
        "SELECT pg_replication_origin_advance('my_origin', '0/1'::pg_lsn)",
        true,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  // Memory layout
  it("blocks pg_get_shmem_allocations", async () => {
    await expect(
      validateQuery("SELECT * FROM pg_get_shmem_allocations()", true),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });
  it("blocks pg_get_backend_memory_contexts", async () => {
    await expect(
      validateQuery("SELECT * FROM pg_get_backend_memory_contexts()", true),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  // Extension mutations
  it("blocks pg_extension_config_dump", async () => {
    await expect(
      validateQuery("SELECT pg_extension_config_dump('mytable', '')", true),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  // system
  it("blocks system", async () => {
    await expect(
      validateQuery("SELECT system('ls')", true),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  // Logical slot peek binary (missing from old list)
  it("blocks pg_logical_slot_peek_binary_changes", async () => {
    await expect(
      validateQuery(
        "SELECT * FROM pg_logical_slot_peek_binary_changes('slot', NULL, NULL)",
        true,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  // Legacy file read
  it("blocks pg_read_file_old", async () => {
    await expect(
      validateQuery("SELECT pg_read_file_old('pg_hba.conf', 0, 1000)", true),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  // Additional ls dirs
  it("blocks pg_ls_archive_statusdir", async () => {
    await expect(
      validateQuery("SELECT * FROM pg_ls_archive_statusdir()", true),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  // PostGIS metadata mutation
  it("blocks populate_geometry_columns", async () => {
    await expect(
      validateQuery("SELECT populate_geometry_columns()", true),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  // pg_trgm session-level state mutation
  it("blocks set_limit", async () => {
    await expect(
      validateQuery("SELECT set_limit(0.1)", true),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });

  // PostGIS admin functions (internal DDL/DML via EXECUTE)
  it("blocks addgeometrycolumn", async () => {
    await expect(
      validateQuery("SELECT addgeometrycolumn('public', 'mytable', 'geom', 4326, 'POINT', 2)", true),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });
  it("blocks dropgeometrycolumn", async () => {
    await expect(
      validateQuery("SELECT dropgeometrycolumn('public', 'mytable', 'geom')", true),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });
  it("blocks dropgeometrytable", async () => {
    await expect(
      validateQuery("SELECT dropgeometrytable('public', 'mytable')", true),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });
  it("blocks updategeometrysrid", async () => {
    await expect(
      validateQuery("SELECT updategeometrysrid('public', 'mytable', 'geom', 4326)", true),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });
  it("blocks postgis_extensions_upgrade", async () => {
    await expect(
      validateQuery("SELECT postgis_extensions_upgrade()", true),
    ).rejects.toMatchObject({ code: "FORBIDDEN_FUNCTION" });
  });
});

describe("validateQuery – allowlist skipped (readOnly=false)", () => {
  it("allows DELETE when readOnly=false", async () => {
    await expect(validateQuery("DELETE FROM t", false)).resolves.toBeUndefined();
  });

  it("allows INSERT when readOnly=false", async () => {
    await expect(
      validateQuery("INSERT INTO t(x) VALUES (1)", false),
    ).resolves.toBeUndefined();
  });
});
