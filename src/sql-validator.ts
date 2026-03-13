import { parse } from "pgsql-parser";
import { walk } from "@pgsql/traverse";

export class ValidationError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ValidationError";
    this.code = code;
  }
}

/**
 * All machine-readable error codes produced by {@link validateQuery}.
 *
 * - `EMPTY_QUERY` — the SQL string is empty or whitespace-only
 * - `PARSE_ERROR` — the SQL has a syntax error
 * - `MULTI_STATEMENT` — more than one statement was provided
 * - `FORBIDDEN_STATEMENT` — statement type is not SELECT or EXPLAIN
 * - `FORBIDDEN_EXPLAIN_TARGET` — EXPLAIN wraps a non-SELECT statement
 * - `FORBIDDEN_EXPLAIN_ANALYZE` — EXPLAIN ANALYZE actually executes the query
 * - `FORBIDDEN_NESTED_MUTATION` — DML/MERGE hidden inside a CTE
 * - `FORBIDDEN_SELECT_INTO` — SELECT INTO creates a table
 * - `FORBIDDEN_LOCKING` — FOR UPDATE/SHARE locking clause
 * - `FORBIDDEN_FUNCTION` — call to a denylisted superuser / side-effect function
 */
export type ValidationErrorCode =
  | "EMPTY_QUERY"
  | "PARSE_ERROR"
  | "MULTI_STATEMENT"
  | "FORBIDDEN_STATEMENT"
  | "FORBIDDEN_EXPLAIN_TARGET"
  | "FORBIDDEN_EXPLAIN_ANALYZE"
  | "FORBIDDEN_NESTED_MUTATION"
  | "FORBIDDEN_SELECT_INTO"
  | "FORBIDDEN_LOCKING"
  | "FORBIDDEN_FUNCTION";

const ALLOWED_STATEMENT_TYPES = new Set(["SelectStmt", "ExplainStmt"]);

/**
 * Functions that must never be callable in read-only mode, grouped by risk category.
 *
 * ## Known limitations (out-of-scope for Layer 1 — rely on Layer 2 + DB role)
 * 1. **User-defined functions (UDFs)**: `SELECT my_evil_wrapper()` — the validator cannot
 *    know a UDF's body. Mitigation: use a non-superuser DB role.
 * 2. **Operator calls mapped to dangerous functions**: All built-in operators are safe;
 *    UDF operators have the same limitation as UDFs.
 * 3. **New PG versions / extensions**: The denylist is a point-in-time snapshot. New
 *    superuser functions added in future PG versions are not automatically covered.
 */
const DANGEROUS_FUNCTIONS = new Set([
  // --- File system (data exfiltration; superuser-only in stock PG) ---
  "pg_read_file",
  "pg_read_binary_file",
  "pg_read_file_old", // adminpack legacy alias for pg_read_file
  "pg_ls_dir",
  "pg_ls_logdir",
  "pg_ls_waldir",
  "pg_ls_tmpdir",
  "pg_ls_archive_statusdir", // lists WAL archive status dir
  "pg_ls_logicalmapdir", // lists logical replication map dir
  "pg_ls_logicalsnapdir", // lists logical replication snapshot dir
  "pg_ls_replslotdir", // lists replication slot dir
  "pg_stat_file",
  // adminpack extension (bundled with PG): file write/rename/delete
  "pg_file_write",
  "pg_file_rename",
  "pg_file_unlink",

  // --- Server administration (service disruption / config mutation) ---
  "pg_reload_conf",
  "pg_rotate_logfile",
  "pg_rotate_logfile_old", // legacy alias for pg_rotate_logfile
  "pg_terminate_backend",
  "pg_cancel_backend",
  "pg_promote",
  "pg_log_backend_memory_contexts",
  "pg_show_all_settings", // exposes GUC values incl. FDW connection strings
  "pg_show_all_file_settings", // exposes pending config file settings
  "pg_log_standby_snapshot", // forces standby to write a snapshot
  "pg_stop_making_pinned_objects", // internal test-only: corrupts catalog state
  "pg_import_system_collations", // mutates pg_collation catalog
  "pg_nextoid", // advances OID counter (internal/test-only)
  "pg_config", // exposes compile-time paths (--bindir, --libdir, etc.)

  // --- WAL / backup control ---
  "pg_start_backup",
  "pg_stop_backup",
  "pg_backup_start", // PG15+ rename of pg_start_backup
  "pg_backup_stop", // PG15+ rename of pg_stop_backup
  "pg_switch_wal",
  "pg_create_restore_point",
  "pg_wal_replay_pause", // pauses WAL replay on standby
  "pg_wal_replay_resume", // resumes WAL replay on standby

  // --- Replication slots (persistent; survive ROLLBACK; can exhaust disk) ---
  "pg_create_logical_replication_slot",
  "pg_create_physical_replication_slot",
  "pg_copy_logical_replication_slot",
  "pg_copy_physical_replication_slot",
  "pg_change_replication_slot_name", // PG17+
  "pg_drop_replication_slot",
  "pg_logical_slot_get_changes",
  "pg_logical_slot_peek_changes",
  "pg_logical_slot_get_binary_changes",
  "pg_logical_slot_peek_binary_changes",
  "pg_replication_slot_advance",

  // --- Sequences (side effects survive ROLLBACK) ---
  "nextval",
  "setval",

  // --- Session state mutation (persists beyond rolled-back transaction) ---
  "set_config",

  // --- Statistics reset (destroys monitoring data; persistent) ---
  "pg_stat_reset",
  "pg_stat_reset_shared",
  "pg_stat_reset_slru",
  "pg_stat_reset_single_table_counters",
  "pg_stat_reset_single_function_counters",
  "pg_stat_reset_replication_slot",
  "pg_stat_clear_snapshot",
  "pg_stat_force_next_flush",
  "pg_stat_reset_subscription_stats",

  // --- Advisory locks (session-level variants survive ROLLBACK → DoS) ---
  "pg_advisory_lock",
  "pg_advisory_lock_shared",
  "pg_try_advisory_lock",
  "pg_try_advisory_lock_shared",
  "pg_advisory_xact_lock",
  "pg_advisory_xact_lock_shared",
  "pg_try_advisory_xact_lock",
  "pg_try_advisory_xact_lock_shared",

  // --- Async messaging (side effect escapes transaction boundary) ---
  "pg_notify",

  // --- Arbitrary SQL execution (executes the query string argument) ---
  "query_to_xml",
  "query_to_xml_and_xmlschema",
  "query_to_xmlschema",
  "cursor_to_xml",
  "cursor_to_xmlschema",

  // --- dblink (executes SQL on a connection outside this transaction) ---
  "dblink",
  "dblink_exec",
  "dblink_connect",
  "dblink_disconnect",
  "dblink_send_query",
  "dblink_get_result",
  "dblink_open",
  "dblink_fetch",
  "dblink_close",
  "dblink_connect_u",

  // --- Large object mutations ---
  "lo_creat",
  "lo_create",
  "lo_import",
  "lo_export",
  "lo_unlink",
  "lo_truncate",
  "lo_truncate64",
  "lo_write",
  "lowrite",

  // --- DoS (unbounded sleep) ---
  "pg_sleep",
  "pg_sleep_for",
  "pg_sleep_until",

  // --- WAL logical messaging (non-transactional mode bypasses READ ONLY + ROLLBACK) ---
  "pg_logical_emit_message",

  // --- Large object open for write (INV_WRITE bypasses READ ONLY at app level) ---
  "lo_open",

  // --- Snapshot export (creates importable snapshot; persistent side-effect) ---
  "pg_export_snapshot",

  // --- Physical path disclosure (reveals on-disk file location of relations) ---
  "pg_relation_filepath",
  "pg_filenode_relation",

  // --- Auth config / filesystem path disclosure (superuser-only info) ---
  "pg_hba_file_rules", // returns full pg_hba.conf: auth methods, addresses, file path
  "pg_ident_file_mappings", // returns pg_ident.conf: OS-to-DB user mapping
  "pg_tablespace_location", // reveals tablespace filesystem path
  "pg_current_logfile", // reveals current server log file path

  // --- Control file disclosure (WAL state, system identity, compile-time config) ---
  "pg_control_checkpoint", // WAL LSN, timeline, XID, checkpoint time
  "pg_control_system", // system identifier, catalog version, PG control version
  "pg_control_recovery", // backup start LSN, recovery target state
  "pg_control_init", // block size, WAL segment size, max identifier length

  // --- Replication origin session state (persists beyond transaction) ---
  "pg_replication_origin_session_setup",
  "pg_replication_origin_xact_setup",
  "pg_replication_origin_session_reset",
  "pg_replication_origin_xact_reset",
  "pg_replication_origin_advance",
  "pg_replication_origin_create",
  "pg_replication_origin_drop",

  // --- Large object mutations ---
  "lo_from_bytea", // creates large object from bytea
  "lo_put", // writes bytes into large object at offset

  // --- Physical path / info disclosure ---
  "pg_relation_filenode", // OID→filenode (inverse of pg_filenode_relation)
  "pg_get_shmem_allocations", // discloses shared memory layout
  "pg_get_backend_memory_contexts", // discloses backend memory layout

  // --- Extension catalog mutations ---
  "pg_extension_config_dump",
  "pg_extension_update_paths",

  // --- Binary upgrade internals (pg_upgrade use only; corrupt if called directly) ---
  "binary_upgrade_create_empty_extension",
  "binary_upgrade_set_missing_value",
  "binary_upgrade_set_next_array_pg_type_oid",
  "binary_upgrade_set_next_heap_pg_class_oid",
  "binary_upgrade_set_next_heap_relfilenode",
  "binary_upgrade_set_next_index_pg_class_oid",
  "binary_upgrade_set_next_index_relfilenode",
  "binary_upgrade_set_next_multirange_array_pg_type_oid",
  "binary_upgrade_set_next_multirange_pg_type_oid",
  "binary_upgrade_set_next_pg_authid_oid",
  "binary_upgrade_set_next_pg_enum_oid",
  "binary_upgrade_set_next_pg_tablespace_oid",
  "binary_upgrade_set_next_pg_type_oid",
  "binary_upgrade_set_next_toast_pg_class_oid",
  "binary_upgrade_set_next_toast_relfilenode",
  "binary_upgrade_set_record_init_privs",

  // --- GIN/BRIN index write maintenance ---
  "gin_clean_pending_list",
  "brin_summarize_new_values",
  "brin_summarize_range",
  "brin_desummarize_range",

  // --- Bulk XML export (executes schema-level queries under the hood) ---
  "database_to_xml",
  "database_to_xml_and_xmlschema",
  "database_to_xmlschema",
  "schema_to_xml",
  "schema_to_xml_and_xmlschema",
  "schema_to_xmlschema",
  "table_to_xml",
  "table_to_xml_and_xmlschema",
  "table_to_xmlschema",

  // --- Non-standard / suspicious ---
  "system", // not a standard PG catalog function; can appear via extensions
  "set_limit", // pg_trgm: sets session-level similarity threshold (state mutation)

  // --- PostGIS admin functions (execute internal DDL/DML via EXECUTE) ---
  "populate_geometry_columns", // ALTER TABLE ... ALTER COLUMN (silently blocked by READ ONLY)
  "addgeometrycolumn", // ALTER TABLE ... ADD COLUMN
  "dropgeometrycolumn", // ALTER TABLE ... DROP COLUMN
  "dropgeometrytable", // DROP TABLE IF EXISTS
  "updategeometrysrid", // ALTER TABLE ... DROP CONSTRAINT + UPDATE
  "postgis_extensions_upgrade", // CREATE/ALTER EXTENSION
]);

/**
 * Validates that `sql` is a read-only query (SELECT or EXPLAIN SELECT).
 * Throws {@link ValidationError} with a machine-readable `code` on rejection.
 *
 * ## Known limitations
 * - **Mutating function calls** (`SELECT my_delete_fn()`) are NOT detectable
 *   at parse level. The parser only sees a FuncCall node, not what the
 *   function body does. Mitigation: use a read-only DB role in addition to
 *   this validator.
 * - **Pre-existing prepared statements**: `EXECUTE stmt` is blocked via the
 *   allowlist, but functions that internally invoke prepared statements bypass
 *   this check.
 *
 * ## Defense in depth
 * Always pair this validator with a PostgreSQL role that has only SELECT
 * privileges (e.g. `pg_read_all_data`). The parser is the application-level
 * gate; the DB role is the enforcement layer.
 */
export async function validateQuery(sql: string, readOnly: boolean): Promise<void> {
  // Stage 2 pre-check — empty before parse
  if (sql.trim() === "") {
    throw new ValidationError("EMPTY_QUERY", "Query is empty");
  }

  // Stage 1 — parse
  // pgsql-parser returns { version: number, stmts: Array<{ stmt: { <StmtType>: {...} } }> }
  let parsed: Awaited<ReturnType<typeof parse>>;
  try {
    parsed = await parse(sql);
  } catch (err) {
    throw new ValidationError(
      "PARSE_ERROR",
      `SQL syntax error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const stmts = (parsed as unknown as { stmts: Array<{ stmt: Record<string, unknown> }> })
    .stmts;

  // Stage 2 — multi-statement / empty
  if (!stmts || stmts.length === 0) {
    throw new ValidationError("EMPTY_QUERY", "Query is empty");
  }
  if (stmts.length > 1) {
    throw new ValidationError("MULTI_STATEMENT", "Only single statements are allowed");
  }

  // If read-only mode is disabled, skip allowlist validation
  if (!readOnly) return;

  // Stage 3 — allowlist
  const rawStmt = stmts[0];
  const stmtNode = rawStmt.stmt;
  const stmtType = Object.keys(stmtNode)[0];

  if (!ALLOWED_STATEMENT_TYPES.has(stmtType)) {
    throw new ValidationError(
      "FORBIDDEN_STATEMENT",
      `${stmtType.replace("Stmt", "")} statements are not allowed`,
    );
  }

  // Stage 3b — EXPLAIN inner check
  if (stmtType === "ExplainStmt") {
    const explainNode = stmtNode["ExplainStmt"] as Record<string, unknown>;
    const innerStmt = explainNode["query"] as Record<string, unknown> | undefined;
    const innerType = innerStmt ? Object.keys(innerStmt)[0] : "";
    if (innerType !== "SelectStmt") {
      throw new ValidationError(
        "FORBIDDEN_EXPLAIN_TARGET",
        "EXPLAIN is only allowed for SELECT statements",
      );
    }

    // EXPLAIN ANALYZE actually executes the query — block it.
    // EXPLAIN (ANALYZE FALSE) / EXPLAIN (ANALYZE OFF) do NOT execute; only block
    // when the arg is absent (bare ANALYZE = implicit TRUE) or explicitly true/on.
    const options = (explainNode["options"] as unknown[] | undefined) ?? [];
    const hasAnalyze = options.some((opt) => {
      const elem = (
        opt as {
          DefElem?: {
            defname?: string;
            arg?: {
              String?: { sval?: string };
              Integer?: { ival?: number };
              Boolean?: { boolval?: boolean };
            };
          };
        }
      ).DefElem;
      if (elem?.defname !== "analyze") return false;
      if (!elem.arg) return true; // bare EXPLAIN ANALYZE — implicit TRUE
      const sval = elem.arg.String?.sval?.toLowerCase();
      if (sval === "true" || sval === "on") return true;
      if (sval === "false" || sval === "off") return false;
      const ival = elem.arg.Integer?.ival;
      if (ival !== undefined) return ival !== 0;
      const bval = elem.arg.Boolean?.boolval;
      if (bval !== undefined) return bval === true;
      // Unknown arg node type — block conservatively
      return true;
    });
    if (hasAnalyze) {
      throw new ValidationError(
        "FORBIDDEN_EXPLAIN_ANALYZE",
        "EXPLAIN ANALYZE is not allowed in read-only mode (it executes the query)",
      );
    }
  }

  // Stage 3c — deep walk for hidden mutations
  deepWalkCheck(rawStmt);
}

function deepWalkCheck(ast: unknown): void {
  walk(ast as Parameters<typeof walk>[0], {
    // Mutating statements inside CTEs
    DeleteStmt() {
      throw new ValidationError(
        "FORBIDDEN_NESTED_MUTATION",
        "Mutating statements inside CTEs are not allowed in read-only mode",
      );
    },
    InsertStmt() {
      throw new ValidationError(
        "FORBIDDEN_NESTED_MUTATION",
        "Mutating statements inside CTEs are not allowed in read-only mode",
      );
    },
    UpdateStmt() {
      throw new ValidationError(
        "FORBIDDEN_NESTED_MUTATION",
        "Mutating statements inside CTEs are not allowed in read-only mode",
      );
    },
    MergeStmt() {
      throw new ValidationError(
        "FORBIDDEN_NESTED_MUTATION",
        "Merge statements are not allowed in read-only mode",
      );
    },
    // SELECT INTO creates a table
    SelectStmt(path) {
      const node = path.node as Record<string, unknown>;
      if (node["intoClause"] != null) {
        throw new ValidationError(
          "FORBIDDEN_SELECT_INTO",
          "SELECT INTO is not allowed in read-only mode",
        );
      }
      if (Array.isArray(node["lockingClause"]) && node["lockingClause"].length > 0) {
        throw new ValidationError(
          "FORBIDDEN_LOCKING",
          "FOR UPDATE/SHARE locking clauses are not allowed in read-only mode",
        );
      }
    },
    // Denylisted superuser / side-effect functions
    FuncCall(path) {
      const node = path.node as { funcname?: unknown[] };
      const parts = node.funcname ?? [];
      // funcname is an array of String nodes; take the last element (strips schema qualifier)
      // e.g. pg_catalog.pg_read_file → ["pg_catalog", "pg_read_file"] → "pg_read_file"
      const last = parts[parts.length - 1];
      const sval =
        (last as { String?: { sval?: string } })?.String?.sval ??
        (last as { str?: string })?.str ??
        "";
      const name = sval.toLowerCase();
      if (DANGEROUS_FUNCTIONS.has(name)) {
        throw new ValidationError(
          "FORBIDDEN_FUNCTION",
          `Function '${sval}' is not allowed in read-only mode`,
        );
      }
    },
  });
}
