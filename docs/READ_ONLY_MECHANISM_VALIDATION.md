# Plan: Read-Only MCP Postgres Defense Validation

## Context

The `postgres-local` MCP server implements a read-only enforcement layer using PostgreSQL transactions. The goal is to exhaustively test every known bypass technique to validate whether the defense is actually airtight or has gaps. The code wraps every user query in `BEGIN TRANSACTION READ ONLY` and always issues a `ROLLBACK` in `finally` — but several bypasses may still exist depending on how the underlying `pg` driver (node-postgres) executes queries.

**Target tables for mutation tests** (real, observable tables):
- `public.echo`
- `public.audit_log`
- `public.config`
- `public.deployment_tag`
- `ai.chat_memory`

---

## Defense Architecture

Two layers operate in sequence for every `run_query` call:

**Layer 1 — `src/sql-validator.ts` (AST-based, always-on)**
- Always blocks: multi-statement SQL (`MULTI_STATEMENT`) — covers all COMMIT-bypass patterns
- In `readOnly=true` mode: allowlist-blocks any non-`SELECT`/`EXPLAIN` top-level statement
- Deep AST walk: blocks DML/MERGE inside CTEs, `SELECT INTO`, locking clauses, denylisted functions

**Layer 2 — `src/database.ts` (transaction-based)**
- Wraps every query in `BEGIN TRANSACTION READ ONLY` + unconditional `ROLLBACK` in `finally`
- Catches DML that Layer 1 misses (e.g., UDF wrappers calling mutations)

The table below notes which layer catches each attack. Attacks marked **Layer 1** never reach
the database. Attacks that reach Layer 2 but are still blocked are marked accordingly.

---

## Critical Vulnerability to Test First

### The COMMIT Bypass (highest severity)

node-postgres `client.query(sql)` uses the PostgreSQL **simple query protocol** when given a plain string. The simple query protocol natively supports **multiple semicolon-separated statements in a single call**. This means:

```
COMMIT; INSERT INTO public.echo VALUES (...);
```

Execution path:
1. Server: `BEGIN TRANSACTION READ ONLY` ✓
2. User sends: `COMMIT; INSERT INTO public.echo ...`
3. `COMMIT` runs → ends the read-only transaction (no changes to roll back)
4. `INSERT` runs → executes in auto-commit mode (new implicit transaction, commits immediately)
5. `finally`: `ROLLBACK` → **fails silently** (no active transaction), `.catch(() => {})` eats the error
6. **Result: INSERT is permanently committed**

This was a **real vulnerability** in the original implementation. It is now fully blocked by Layer 1
(`MULTI_STATEMENT` check) before the query reaches the database.

---

## Attack Categories

### Category 1 — Direct DML (Baseline, Expected to Fail)
These establish the baseline. They SHOULD be blocked by the READ ONLY transaction.

| # | SQL | Expected |
|---|-----|----------|
| 1a | `INSERT INTO public.echo VALUES (...)` | BLOCKED |
| 1b | `UPDATE public.config SET value = 'pwned' WHERE 1=0` | BLOCKED |
| 1c | `DELETE FROM public.deployment_tag WHERE 1=0` | BLOCKED |
| 1d | `TRUNCATE public.deployment_tag` | BLOCKED |

---

### Category 2 — COMMIT Bypass (Expected to Succeed = Critical Vulnerability)
Escape the read-only transaction by explicitly committing it, then running DML outside of it.

| # | SQL | Expected |
|---|-----|----------|
| 2a | `COMMIT; INSERT INTO public.echo VALUES (...)` | **BLOCKED (Layer 1: MULTI_STATEMENT)** |
| 2b | `COMMIT; UPDATE public.config SET value = 'pwned' WHERE 1=0` | **BLOCKED (Layer 1: MULTI_STATEMENT)** |
| 2c | `COMMIT; CREATE TABLE public.pwned_test (id int)` | **BLOCKED (Layer 1: MULTI_STATEMENT)** |
| 2d | `COMMIT; DROP TABLE IF EXISTS public.pwned_test` | **BLOCKED (Layer 1: MULTI_STATEMENT)** |

---

### Category 3 — ROLLBACK + Fresh BEGIN Escape
Similar to COMMIT bypass but uses a full new transaction.

| # | SQL | Expected |
|---|-----|----------|
| 3a | `ROLLBACK; BEGIN; INSERT INTO public.echo VALUES (...); COMMIT;` | **BLOCKED (Layer 1: MULTI_STATEMENT)** |
| 3b | `ROLLBACK; BEGIN TRANSACTION READ WRITE; INSERT INTO public.echo VALUES (...); COMMIT;` | **BLOCKED (Layer 1: MULTI_STATEMENT)** |

---

### Category 4 — SET TRANSACTION Upgrade
Attempt to change the current transaction from READ ONLY to READ WRITE mid-flight.

| # | SQL | Expected |
|---|-----|----------|
| 4a | `SET TRANSACTION READ WRITE` | BLOCKED (error: must set before any query) |
| 4b | `SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE` | Might succeed (sets default for *future* transactions, not current) |
| 4c | `SET LOCAL transaction_read_only = off` | BLOCKED |

---

### Category 5 — DDL via Multi-Statement
DDL that creates persistent schema objects.

| # | SQL | Expected |
|---|-----|----------|
| 5a | `COMMIT; CREATE SCHEMA evil_test` | **BLOCKED (Layer 1: MULTI_STATEMENT)** |
| 5b | `COMMIT; CREATE OR REPLACE FUNCTION public.evil_fn() RETURNS void LANGUAGE sql AS $$ INSERT INTO public.echo VALUES(gen_random_uuid(),'x',now()) $$` | **BLOCKED (Layer 1: MULTI_STATEMENT)** |
| 5c | `COMMIT; CREATE SEQUENCE public.evil_seq` | **BLOCKED (Layer 1: MULTI_STATEMENT)** |
| 5d | `COMMIT; DROP SCHEMA IF EXISTS evil_test CASCADE` | **BLOCKED (Layer 1: MULTI_STATEMENT)** |

---

### Category 6 — Comment / Obfuscation Tricks
Test whether there is any keyword-based string filter being applied before the transaction, and whether it can be bypassed with comments.

| # | SQL | Expected |
|---|-----|----------|
| 6a | `/* comment */ INSERT INTO public.echo VALUES (...)` | BLOCKED (tx enforces it) |
| 6b | `--\nINSERT INTO public.echo VALUES (...)` | BLOCKED |
| 6c | `INSE/**/RT INTO public.echo VALUES (...)` | Parse error or blocked |
| 6d | `CO/**/MMIT; INSERT INTO public.echo VALUES (...)` | Interesting: is `CO/**/MMIT` a valid COMMIT? |
| 6e | `COMMIT /* sneaky */; INSERT INTO public.echo VALUES (...)` | **SUCCEEDS IF multi-stmt works** |
| 6f | Unicode whitespace between keywords (e.g. `INSERT\u00A0INTO ...`) | Blocked or parse error |

---

### Category 7 — Empty / Malformed / Edge-Case Queries
Test server stability and error handling.

| # | SQL | Expected |
|---|-----|----------|
| 7a | `''` (empty string) | Error or no-op |
| 7b | `'   '` (whitespace only) | Error or no-op |
| 7c | `'-- just a comment'` | No-op |
| 7d | `';'` (just semicolons) | No-op |
| 7e | `';;;'` (multiple empty statements) | No-op |
| 7f | Very long string (10,000+ chars of garbage) | Error, no crash |
| 7g | `'\x00SELECT 1'` (null byte injection) | Error |
| 7h | `SELECT` (incomplete statement) | Parse error |

---

### Category 8 — Sequences (State Mutation Outside Data)
In PostgreSQL, sequence functions are blocked in READ ONLY transactions. Test this, and test bypass.

| # | SQL | Expected |
|---|-----|----------|
| 8a | `SELECT nextval('public.some_sequence')` | BLOCKED (Layer 1: FORBIDDEN_FUNCTION, also Layer 2: READ ONLY) |
| 8b | `SELECT setval('public.some_sequence', 9999)` | BLOCKED (Layer 1: FORBIDDEN_FUNCTION, also Layer 2: READ ONLY) |
| 8c | `COMMIT; SELECT setval('public.some_sequence', 9999)` | **BLOCKED (Layer 1: MULTI_STATEMENT)** |
| 8d | `SELECT currval('public.some_sequence')` | Allowed (no state change) |

*Note: need to discover a real sequence name from `pg_sequences`.*

---

### Category 9 — Advisory Locks (Session-Level Side Effects)
Session-level advisory locks persist beyond transaction rollback — a form of state mutation that survives ROLLBACK.

| # | SQL | Expected |
|---|-----|----------|
| 9a | `SELECT pg_advisory_lock(99999)` | **BLOCKED (Layer 1: FORBIDDEN_FUNCTION)** |
| 9b | `SELECT pg_advisory_xact_lock(99999)` | **BLOCKED (Layer 1: FORBIDDEN_FUNCTION)** |
| 9c | `SELECT pg_try_advisory_lock(99999)` | **BLOCKED (Layer 1: FORBIDDEN_FUNCTION)** |
| 9d | `SELECT pg_advisory_unlock(99999)` | Moot — lock can never be acquired |

---

### Category 10 — COPY Command
Test file read/write and stdin behaviors.

| # | SQL | Expected |
|---|-----|----------|
| 10a | `COPY public.echo FROM '/etc/passwd'` | Blocked (READ ONLY + privilege) |
| 10b | `COPY (SELECT 1) TO '/tmp/pwned_mcp'` | Blocked (privilege, possibly READ ONLY) |
| 10c | `COMMIT; COPY public.echo FROM '/etc/passwd'` | Blocked by privilege (not by READ ONLY after COMMIT) |

---

### Category 11 — System Functions with Side Effects
Test PostgreSQL admin functions. Most require superuser, but worth verifying the actual privilege level.

| # | SQL | Expected |
|---|-----|----------|
| 11a | `SELECT pg_reload_conf()` | **BLOCKED (Layer 1: FORBIDDEN_FUNCTION)** |
| 11b | `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid <> pg_backend_pid() LIMIT 1` | **BLOCKED (Layer 1: FORBIDDEN_FUNCTION)** |
| 11c | `SELECT pg_cancel_backend(pg_backend_pid())` | **BLOCKED (Layer 1: FORBIDDEN_FUNCTION)** |
| 11d | `SELECT pg_read_file('/etc/passwd', 0, 500)` | **BLOCKED (Layer 1: FORBIDDEN_FUNCTION)** |
| 11e | `SELECT pg_ls_dir('.')` | **BLOCKED (Layer 1: FORBIDDEN_FUNCTION)** |
| 11f | `SELECT pg_notify('test_channel', 'pwned')` | **BLOCKED (Layer 1: FORBIDDEN_FUNCTION)** |
| 11g | `COMMIT; SELECT pg_notify('test_channel', 'pwned')` | **BLOCKED (Layer 1: MULTI_STATEMENT)** |

---

### Category 12 — Large Objects
Large object functions can mutate data even in unusual ways.

| # | SQL | Expected |
|---|-----|----------|
| 12a | `SELECT lo_creat(-1)` | BLOCKED (Layer 1: FORBIDDEN_FUNCTION, also Layer 2: READ ONLY) |
| 12b | `COMMIT; SELECT lo_creat(-1)` | **BLOCKED (Layer 1: MULTI_STATEMENT)** |
| 12c | `SELECT lo_list()` | Allowed (read only) |

---

### Category 13 — dblink (Out-of-Band Mutation)
If the `dblink` extension is installed, it establishes a *separate connection* to PostgreSQL that operates completely outside the current transaction's read-only scope.

| # | SQL | Expected |
|---|-----|----------|
| 13a | `SELECT * FROM pg_extension WHERE extname = 'dblink'` | Check if installed |
| 13b | `SELECT dblink_exec('dbname=outfit user=outfit', 'INSERT INTO public.echo VALUES (...)')` | **BLOCKED (Layer 1: FORBIDDEN_FUNCTION)** |
| 13c | `SELECT dblink('dbname=outfit user=outfit', 'SELECT 1')` | **BLOCKED (Layer 1: FORBIDDEN_FUNCTION)** |

*Note: all `dblink_*` variants are in the function denylist.*

---

### Category 14 — Prepared Statements Abuse
Test if `PREPARE` is blocked in READ ONLY, and test multi-statement bypass.

| # | SQL | Expected |
|---|-----|----------|
| 14a | `PREPARE evil AS INSERT INTO public.echo VALUES ($1)` | BLOCKED — `PrepareStmt` is not in `ALLOWED_STATEMENT_TYPES` (Layer 1), also blocked by READ ONLY (Layer 2) |
| 14b | `COMMIT; PREPARE evil AS INSERT INTO public.echo VALUES ($1); EXECUTE evil('pwned_prepared')` | **BLOCKED (Layer 1: MULTI_STATEMENT)** |
| 14c | `DEALLOCATE ALL` | Probably allowed (no data change) |

---

### Category 15 — LISTEN/NOTIFY
Test whether notifications can be sent and whether they survive the ROLLBACK.

| # | SQL | Expected |
|---|-----|----------|
| 15a | `LISTEN test_channel` | Allowed |
| 15b | `SELECT pg_notify('test_channel', 'payload')` | BLOCKED (Layer 1: FORBIDDEN_FUNCTION) |
| 15c | `COMMIT; SELECT pg_notify('test_channel', 'fired_after_bypass')` | **BLOCKED (Layer 1: MULTI_STATEMENT)** |

---

### Category 16 — Dollar-Quoting & String Encoding Edge Cases
Test whether any filter can be bypassed using alternative SQL encoding.

| # | SQL | Expected |
|---|-----|----------|
| 16a | `DO $$ BEGIN INSERT INTO public.echo VALUES (...); END $$` | BLOCKED — `DoStmt` is not in `ALLOWED_STATEMENT_TYPES` (Layer 1), also blocked by READ ONLY (Layer 2) |
| 16b | `DO $$ BEGIN EXECUTE 'INSERT INTO public.echo VALUES (...)'; END $$` | BLOCKED — same as 16a |
| 16c | `COMMIT; DO $$ BEGIN INSERT INTO public.echo VALUES (...); END $$` | **BLOCKED (Layer 1: MULTI_STATEMENT)** |
| 16d | Dollar-quoted COMMIT: `$x$COMMIT$x$` (not valid SQL — just checking) | Parse error |

---

### Category 17 — ALTER SYSTEM / Configuration Mutation
High-privilege configuration mutations.

| # | SQL | Expected |
|---|-----|----------|
| 17a | `ALTER SYSTEM SET log_statement = 'all'` | Blocked (privilege) |
| 17b | `COMMIT; ALTER SYSTEM SET log_statement = 'all'` | Blocked (privilege) |

---

### Category 18 — EXPLAIN ANALYZE (executes the inner query)
`EXPLAIN ANALYZE` actually runs the query to collect runtime statistics. Any denylisted function
can be fully executed this way if EXPLAIN ANALYZE is not blocked separately.

| # | SQL | Expected |
|---|-----|----------|
| 18a | `EXPLAIN ANALYZE SELECT 1` | BLOCKED (Layer 1: FORBIDDEN_EXPLAIN_ANALYZE) |
| 18b | `EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM t` | BLOCKED (Layer 1: FORBIDDEN_EXPLAIN_ANALYZE) |
| 18c | `EXPLAIN (ANALYZE TRUE) SELECT * FROM t` | BLOCKED (Layer 1: FORBIDDEN_EXPLAIN_ANALYZE) |
| 18d | `EXPLAIN (ANALYZE FALSE) SELECT * FROM t` | ALLOWED — FALSE disables execution, harmless |
| 18e | `EXPLAIN (ANALYZE OFF) SELECT * FROM t` | ALLOWED — OFF disables execution, harmless |
| 18f | `EXPLAIN SELECT pg_read_file('/etc/passwd', 0, 100)` | BLOCKED (Layer 1: FORBIDDEN_FUNCTION via deep walk into EXPLAIN target) |

*Note: The parser represents `ANALYZE FALSE`/`ANALYZE OFF` as a `DefElem` with
`arg: { String: { sval: "false" } }`. The validator reads the arg value to avoid this
false positive.*

---

### Category 19 — MERGE in Writeable CTE
A `MERGE` statement inside a CTE body passes the top-level `SelectStmt` allowlist check.
The deep-walk handler must explicitly visit `MergeStmt` nodes.

| # | SQL | Expected |
|---|-----|----------|
| 19a | `WITH m AS (MERGE INTO t USING src ON t.id=s.id WHEN MATCHED THEN DELETE RETURNING t.id) SELECT * FROM m` | BLOCKED (Layer 1: FORBIDDEN_NESTED_MUTATION) |
| 19b | `WITH m AS (MERGE INTO t USING src ON t.id=s.id WHEN NOT MATCHED THEN INSERT VALUES (1) RETURNING t.id) SELECT * FROM m` | BLOCKED (Layer 1: FORBIDDEN_NESTED_MUTATION) |

---

### Category 20 — Function Denylist (Layer 1 FORBIDDEN_FUNCTION)
Layer 1 maintains a denylist of ~60 dangerous functions across 10 risk categories. Tests below
verify both denylist coverage and that bypass techniques are caught.

**Direct calls (sample per category):**
| # | SQL | Expected |
|---|-----|----------|
| 20a | `SELECT pg_read_file('/etc/passwd', 0, 200)` | BLOCKED (Layer 1: FORBIDDEN_FUNCTION) |
| 20b | `SELECT pg_read_binary_file('pg_hba.conf', 0, 500)` | BLOCKED (Layer 1: FORBIDDEN_FUNCTION) |
| 20c | `SELECT pg_ls_dir('.')` | BLOCKED (Layer 1: FORBIDDEN_FUNCTION) |
| 20d | `SELECT pg_file_write('/tmp/evil.sh', 'data', false)` | BLOCKED (Layer 1: FORBIDDEN_FUNCTION) |
| 20e | `SELECT pg_reload_conf()` | BLOCKED (Layer 1: FORBIDDEN_FUNCTION) |
| 20f | `SELECT pg_terminate_backend(1234)` | BLOCKED (Layer 1: FORBIDDEN_FUNCTION) |
| 20g | `SELECT pg_sleep(30)` | BLOCKED (Layer 1: FORBIDDEN_FUNCTION) — DoS |
| 20h | `SELECT nextval('my_seq')` | BLOCKED (Layer 1: FORBIDDEN_FUNCTION) |
| 20i | `SELECT set_config('session_replication_role', 'replica', false)` | BLOCKED (Layer 1: FORBIDDEN_FUNCTION) |
| 20j | `SELECT pg_stat_reset()` | BLOCKED (Layer 1: FORBIDDEN_FUNCTION) |
| 20k | `SELECT query_to_xml('DELETE FROM t', true, true, '')` | BLOCKED (Layer 1: FORBIDDEN_FUNCTION) |
| 20l | `SELECT lo_creat(-1)` | BLOCKED (Layer 1: FORBIDDEN_FUNCTION) |
| 20m | `SELECT pg_notify('chan', 'payload')` | BLOCKED (Layer 1: FORBIDDEN_FUNCTION) |
| 20n | `SELECT pg_create_logical_replication_slot('s', 'pgoutput')` | BLOCKED (Layer 1: FORBIDDEN_FUNCTION) |
| 20o | `SELECT pg_start_backup('label')` | BLOCKED (Layer 1: FORBIDDEN_FUNCTION) |

**Bypass attempts (must all be BLOCKED):**
| # | SQL | Expected |
|---|-----|----------|
| 20p | Schema-qualified: `SELECT pg_catalog.pg_read_file('/etc/passwd', 0, 100)` | BLOCKED — validator strips schema prefix, checks last name component |
| 20q | Inside subquery: `SELECT * FROM (SELECT pg_read_file('/etc/passwd', 0, 100)) s` | BLOCKED — walk() recurses into subquery |
| 20r | Inside CTE: `WITH x AS (SELECT pg_reload_conf()) SELECT * FROM x` | BLOCKED — walk() recurses into CTE body |
| 20s | Nested call: `SELECT pg_cancel_backend(pg_backend_pid())` | BLOCKED — both FuncCall nodes visited |
| 20t | Inside EXPLAIN target: `EXPLAIN SELECT pg_ls_dir('.')` | BLOCKED — walk() recurses into ExplainStmt.query |
| 20u | SRF in FROM: `SELECT * FROM pg_ls_dir('.') AS f` | BLOCKED — RangeFunction wraps a FuncCall that walk() visits |

**Intentionally ALLOWED (must not false-positive):**
| # | SQL | Expected |
|---|-----|----------|
| 20v | `SELECT pg_typeof(1), pg_size_pretty(1024)` | ALLOWED — informational pg_ functions not in denylist |
| 20w | `SELECT count(*), sum(id) FROM t` | ALLOWED — aggregate functions |
| 20x | `SELECT currval('my_seq')` | ALLOWED — read-only sequence inspection |
| 20y | `SELECT pg_backend_pid()` | ALLOWED — informational only |

**Remaining gap (documented limitation):**
| # | SQL | Expected |
|---|-----|----------|
| 20z | `SELECT my_udf_that_calls_pg_read_file()` | **NOT BLOCKED by Layer 1** — UDF body invisible to parser. Requires non-superuser DB role (Layer 2 enforcement). |

---

### Category 21 — EXPLAIN ANALYZE Integer/Boolean Arg Bypass

**Root cause:** The `hasAnalyze` check in `sql-validator.ts` read only `elem.arg?.String?.sval`.
`pgsql-parser` represents `ANALYZE 1` as an `Integer` AST node, not a `String` node — so
`sval` was `undefined`, `val === "true"` was false, and `hasAnalyze` returned `false`.
The validator passed the query and EXPLAIN executed the inner SELECT.

**Status: FIXED** — `hasAnalyze` now also checks `Integer.ival !== 0` and `Boolean.boolval === true`,
and falls back to blocking on any unrecognized arg node type.

| # | SQL | Actual Result | Fixed Result |
|---|-----|---------------|-------------|
| 21a | `EXPLAIN (ANALYZE 1) SELECT 1` | **EXECUTED** — `actual time=...` returned | BLOCKED |
| 21b | `EXPLAIN (ANALYZE 0) SELECT 1` | ALLOWED — no execution (0 = false) | ALLOWED |
| 21c | `EXPLAIN (ANALYZE true) SELECT 1` | BLOCKED (Layer 1) ✓ | BLOCKED |
| 21d | `EXPLAIN (ANALYZE on) SELECT 1` | BLOCKED (Layer 1) ✓ | BLOCKED |
| 21e | `EXPLAIN (ANALYZE off) SELECT 1` | ALLOWED ✓ | ALLOWED |
| 21f | `EXPLAIN (ANALYZE false) SELECT 1` | ALLOWED ✓ | ALLOWED |
| 21g | `EXPLAIN (ANALYZE 1) SELECT pg_backend_pid()` | **EXECUTED** — inner SELECT ran | BLOCKED |

---

### Category 22 — Functions Missing from the Denylist

Functions with side effects that were absent from `DANGEROUS_FUNCTIONS`. All passed Layer 1's
FuncCall check and were tested against Layer 2.

**Status: FIXED** — All functions below added to `DANGEROUS_FUNCTIONS` in `src/sql-validator.ts`.

| # | SQL | Layer 1 (before fix) | Layer 2 | Severity |
|---|-----|----------------------|---------|----------|
| 22a | `SELECT pg_logical_emit_message(false, 'mcp_pwned', 'content')` | **PASSED** | **PASSED** — non-tx WAL write bypasses ROLLBACK | **CRITICAL** |
| 22b | `SELECT pg_logical_emit_message(true, 'mcp_pwned', 'content')` | **PASSED** | **PASSED** — transactional, but ROLLBACK didn't block it either | **CRITICAL** |
| 22c | `SELECT lo_open(1, 131072)` | **PASSED** | BLOCKED — `cannot execute lo_open(INV_WRITE) in a read-only transaction` | Medium |
| 22d | `SELECT lo_open(1, 262144)` | **PASSED** | Error — `large object 1 does not exist` (INV_READ, no write blocked) | Low |
| 22e | `SELECT pg_export_snapshot()` | **PASSED** | **PASSED** — returned snapshot ID `00000003-00000330-1` | High |
| 22f | `SELECT pg_relation_filepath('public.echo')` | **PASSED** | **PASSED** — returned `base/16384/16844` | Medium (info disclosure) |
| 22g | `SELECT pg_replication_origin_session_setup('my_origin')` | **PASSED** | BLOCKED — origin does not exist (privilege error) | Low |
| 22h | `SELECT pg_filenode_relation(0, 'public.echo'::regclass::oid)` | **PASSED** | **PASSED** — returned relation name | Low (info disclosure) |

**Combination attacks (Cat 21 bypass + Cat 22 gap):**

| # | SQL | Result |
|---|-----|--------|
| 22i | `EXPLAIN (ANALYZE 1) SELECT pg_logical_emit_message(false, 'mcp_pwned', 'combo')` | **CRITICAL — EXECUTED** (both gaps combined) |
| 22j | `EXPLAIN (ANALYZE 1) SELECT pg_export_snapshot()` | **EXECUTED** (both gaps combined) |

*Note: `pg_logical_emit_message(false, ...)` with `transactional=false` writes directly to WAL
and cannot be undone by ROLLBACK, making it the only function in this batch that fully bypasses
both defense layers.*

---

### Category 23 — AST Walker Node Coverage Gaps

Tests whether `@pgsql/traverse walk()` visits `FuncCall` nodes embedded in less common AST
container types. Uses `pg_read_file` as probe (in denylist — any pass means the walk works).

**Status: All BLOCKED. ✓** The walker has complete AST coverage.

| # | SQL | Result |
|---|-----|--------|
| 23a | `SELECT ROW(pg_read_file('/etc/passwd', 0, 100))` | BLOCKED (Layer 1) |
| 23b | `SELECT ARRAY[pg_read_file('/etc/passwd', 0, 100)]` | BLOCKED (Layer 1) |
| 23c | `SELECT pg_read_file('/etc/passwd', 0, 100)::text` | BLOCKED (Layer 1) |
| 23d | `SELECT COALESCE(pg_read_file('/etc/passwd', 0, 100), 'fallback')` | BLOCKED (Layer 1) |
| 23e | `SELECT NULLIF(pg_read_file('/etc/passwd', 0, 100), '')` | BLOCKED (Layer 1) |
| 23f | `SELECT GREATEST(pg_read_file('/etc/passwd', 0, 100), '')` | BLOCKED (Layer 1) |
| 23g | `SELECT CASE WHEN 1=1 THEN pg_read_file('/etc/passwd', 0, 100) ELSE '' END` | BLOCKED (Layer 1) |
| 23h | `SELECT 1 WHERE pg_read_file('/etc/passwd', 0, 100) IS NOT NULL` | BLOCKED (Layer 1) |
| 23i | `SELECT 1 ORDER BY pg_read_file('/etc/passwd', 0, 100)` | BLOCKED (Layer 1) |
| 23j | `SELECT 1 GROUP BY pg_read_file('/etc/passwd', 0, 100)` | BLOCKED (Layer 1) |
| 23k | `SELECT * FROM (VALUES (pg_read_file('/etc/passwd', 0, 100))) AS v(c)` | BLOCKED (Layer 1) |
| 23l | `SELECT pg_read_file('/etc/passwd', 0, 100) UNION SELECT 'safe'` | BLOCKED (Layer 1) |
| 23m | `SELECT * FROM LATERAL (SELECT pg_read_file('/etc/passwd', 0, 100)) AS sub(v)` | BLOCKED (Layer 1) |
| 23n | `SELECT (SELECT pg_read_file('/etc/passwd', 0, 100))` | BLOCKED (Layer 1) |

---

### Category 24 — FOR UPDATE / FOR SHARE in Nested Selects

`SelectStmt.lockingClause` is checked inside `deepWalkCheck`. The walk recurses into all
`SelectStmt` nodes, including those inside subqueries and scalar subqueries.

**Status: All BLOCKED. ✓**

| # | SQL | Result |
|---|-----|--------|
| 24a | `SELECT id FROM public.echo FOR UPDATE` | BLOCKED (Layer 1: FORBIDDEN_LOCKING) |
| 24b | `SELECT id FROM public.echo FOR SHARE` | BLOCKED (Layer 1: FORBIDDEN_LOCKING) |
| 24c | `SELECT * FROM (SELECT id FROM public.echo FOR UPDATE) AS sub` | BLOCKED (Layer 1: FORBIDDEN_LOCKING) |
| 24d | `SELECT (SELECT id FROM public.echo FOR UPDATE LIMIT 1)` | BLOCKED (Layer 1: FORBIDDEN_LOCKING) |
| 24e | `SELECT id FROM public.echo FOR UPDATE SKIP LOCKED` | BLOCKED (Layer 1: FORBIDDEN_LOCKING) |
| 24f | `SELECT id FROM public.echo FOR UPDATE NOWAIT` | BLOCKED (Layer 1: FORBIDDEN_LOCKING) |

---

### Category 25 — FuncCall Name Matching Edge Cases

Tests alternative naming and quoting that might bypass the `funcname` last-segment extraction
and `.toLowerCase()` comparison.

**Status: All handled correctly. ✓**

| # | SQL | Result |
|---|-----|--------|
| 25a | `SELECT pg_read_file(filename => '/etc/passwd', offset => 0, length => 100)` | BLOCKED — parse error (`offset` is reserved keyword) |
| 25b | `SELECT "pg_read_file"('/etc/passwd', 0, 100)` | BLOCKED (Layer 1) — double-quoted lowercase preserved as `pg_read_file` |
| 25c | `SELECT "PG_READ_FILE"('/etc/passwd', 0, 100)` | BLOCKED (Layer 1) — `.toLowerCase()` maps to denylist entry |
| 25d | `SELECT pg_catalog.pg_read_file('/etc/passwd', 0, 100)` | BLOCKED (Layer 1) — schema prefix stripped, last segment checked |
| 25e | `SELECT information_schema._pg_truetypid(NULL::pg_attribute, NULL::pg_type)` | ALLOWED ✓ — internal catalog fn not in denylist |
| 25f | `SELECT pg_read_file(E'/etc/passwd', 0, 100)` | BLOCKED (Layer 1) — E-string is a string literal arg, FuncCall node unchanged |
| 25g | `SELECT pg_read_file($$/etc/passwd$$, 0, 100)` | BLOCKED (Layer 1) — dollar-quoted arg, FuncCall node unchanged |

---

### Category 26 — Re-verification of Round 1 Vulnerabilities

All of the following succeeded in Round 1 (before the refactor). Verified that they are now
caught by **Layer 1**, not Layer 2. Error messages read `"Function 'X' is not allowed in
read-only mode"` — confirming the AST validator intercepts them before DB contact.

| # | SQL | Round 1 Result | Round 2 Result |
|---|-----|----------------|----------------|
| 26a | `SELECT pg_advisory_lock(99999)` | SUCCEEDED | BLOCKED — Layer 1 ✓ |
| 26b | `SELECT pg_try_advisory_lock(99998)` | SUCCEEDED | BLOCKED — Layer 1 ✓ |
| 26c | `SELECT pg_read_file('/etc/passwd', 0, 200)` | SUCCEEDED | BLOCKED — Layer 1 ✓ |
| 26d | `SELECT pg_read_file('pg_hba.conf', 0, 500)` | SUCCEEDED | BLOCKED — Layer 1 ✓ |
| 26e | `SELECT pg_reload_conf()` | SUCCEEDED | BLOCKED — Layer 1 ✓ |
| 26f | `SELECT pg_ls_dir('.')` | SUCCEEDED | BLOCKED — Layer 1 ✓ |
| 26g | `SELECT pg_notify('test_channel', 'pwned')` | SUCCEEDED | BLOCKED — Layer 1 ✓ |
| 26h | `SELECT pg_cancel_backend(pg_backend_pid())` | SUCCEEDED | BLOCKED — Layer 1 ✓ |

---

### Category 27 — New Statement Types / PG17 Edge Cases

| # | SQL | Result |
|---|-----|--------|
| 27a | `TABLE public.echo` | ALLOWED — shorthand for `SELECT * FROM`, parsed as `SelectStmt` |
| 27b | `VALUES (1, 2), (3, 4)` | ALLOWED — standalone VALUES, parsed as `SelectStmt` with `valuesLists` |
| 27c | `SELECT 1 INTERSECT SELECT 2` | ALLOWED — set operation |
| 27d | `SELECT 1 EXCEPT SELECT 2` | ALLOWED — set operation |
| 27e | `CALL some_procedure()` | BLOCKED — `CallStmt` not in `ALLOWED_STATEMENT_TYPES` |
| 27f | `EXPLAIN (GENERIC_PLAN) SELECT $1` | ALLOWED — no execution, no ANALYZE |
| 27g | `EXPLAIN (MEMORY) SELECT 1` | DB error — `unrecognized EXPLAIN option "memory"` (PG version does not support it; not a security concern) |
| 27h | `EXPLAIN (ANALYZE false, MEMORY true) SELECT 1` | DB error — same as 27g; `ANALYZE false` was correctly passed by validator |

---

## Execution Plan (5 Parallel Agent Groups)

Each agent receives a specific set of attack categories and runs them against the MCP server, recording: query sent, response received, whether mutation succeeded, and any error messages.

**Agent 1** — Baseline + COMMIT Bypass (Categories 1, 2, 3)
- The most critical tests. Establish baseline DML blocking, then test COMMIT/ROLLBACK escape.
- Verify by checking table contents after alleged mutations.

**Agent 2** — Transaction Mode + DDL + Functions (Categories 4, 5, 16)
- Test SET TRANSACTION upgrades, DDL creation, DO blocks.
- Check `pg_tables` and `pg_proc` for evidence of created objects.

**Agent 3** — Comment Obfuscation + Malformed Queries (Categories 6, 7)
- Test all comment/encoding tricks and edge cases.
- Focus on stability — ensure server doesn't crash on bad input.

**Agent 4** — Sequences + Advisory Locks + Large Objects + Prepared Statements (Categories 8, 9, 12, 14)
- Discover real sequence names first via `pg_sequences`.
- Test session-level side effects of advisory locks.
- Test large object creation bypass.

**Agent 5** — System Functions + COPY + dblink + LISTEN/NOTIFY + ALTER SYSTEM (Categories 10, 11, 13, 15, 17)
- Check if dblink is installed; if so, attempt out-of-band mutation.
- Test COPY file access.
- Test notification delivery.

---

## Verification

After each agent run, a **post-check query** is issued to verify whether any mutation actually landed:

```sql
-- Check for injected rows
SELECT * FROM public.echo WHERE created_at > now() - interval '10 minutes' ORDER BY created_at DESC;

-- Check for created objects
SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'pwned%' OR table_name LIKE 'evil%';

-- Check for created functions
SELECT proname FROM pg_proc WHERE proname LIKE 'evil%' OR proname LIKE 'pwned%';

-- Check for created schemas
SELECT schema_name FROM information_schema.schemata WHERE schema_name IN ('evil_test', 'evil_schema');

-- Check advisory locks held by session
SELECT * FROM pg_locks WHERE locktype = 'advisory';
```

**Round 2 post-session verification results (2026-03-12):**
- `SELECT id, message FROM public.echo ORDER BY id DESC LIMIT 5` → max id = 100 ✓ (unchanged)
- `SELECT locktype, objid FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()` → no rows ✓
- Evil/pwned table check → no rows ✓
- `SELECT last_value FROM public.echo_id_seq` → 100 ✓ (unchanged)

---

## Expected Findings Summary

| Attack | Layer 1 result | Layer 2 result |
|--------|----------------|----------------|
| Direct DML | Blocked (FORBIDDEN_STATEMENT) | Blocked (READ ONLY) |
| `COMMIT; DML` multi-statement | **Blocked (MULTI_STATEMENT)** | N/A |
| `ROLLBACK; BEGIN; DML; COMMIT` | **Blocked (MULTI_STATEMENT)** | N/A |
| `SET TRANSACTION READ WRITE` | Blocked (FORBIDDEN_STATEMENT in readOnly) | Blocked (error) |
| DDL via COMMIT bypass | **Blocked (MULTI_STATEMENT)** | N/A |
| Comment obfuscation | Pass-through (tx enforces, not string filter) | Blocked (READ ONLY) |
| `nextval()` / `setval()` | **Blocked (FORBIDDEN_FUNCTION)** | Blocked (READ ONLY) |
| `pg_advisory_lock()` session-level | **Blocked (FORBIDDEN_FUNCTION)** | Would survive ROLLBACK |
| `pg_notify()` | **Blocked (FORBIDDEN_FUNCTION)** | Fires only on COMMIT |
| `pg_read_file()` | **Blocked (FORBIDDEN_FUNCTION)** | Blocked (privilege) |
| `lo_creat()` | **Blocked (FORBIDDEN_FUNCTION)** | Blocked (READ ONLY) |
| `dblink` out-of-band mutation | **Blocked (FORBIDDEN_FUNCTION)** | Not blocked (separate connection) |
| `EXPLAIN ANALYZE` (string args) | **Blocked (FORBIDDEN_EXPLAIN_ANALYZE)** | Would execute inner query |
| `EXPLAIN (ANALYZE 1)` integer arg | ~~**VULNERABLE** (Round 2 Cat 21)~~ → **Fixed** | Would execute inner query |
| `MERGE` in writeable CTE | **Blocked (FORBIDDEN_NESTED_MUTATION)** | Blocked (READ ONLY) |
| Schema-qualified dangerous fn | **Blocked (FORBIDDEN_FUNCTION, schema stripped)** | Blocked (privilege/READ ONLY) |
| FuncCall in any AST container | **Blocked (FORBIDDEN_FUNCTION)** — walk() has full coverage | N/A |
| FOR UPDATE in nested subquery | **Blocked (FORBIDDEN_LOCKING)** — walk() visits all SelectStmt | N/A |
| `pg_logical_emit_message(false,...)` | ~~**VULNERABLE** (Round 2 Cat 22)~~ → **Fixed** | **NOT BLOCKED** — non-tx WAL write bypasses ROLLBACK |
| `pg_export_snapshot()` | ~~**VULNERABLE** (Round 2 Cat 22)~~ → **Fixed** | Allowed in READ ONLY tx |
| `pg_relation_filepath()` | ~~**VULNERABLE** (Round 2 Cat 22)~~ → **Fixed** | Allowed — info disclosure |
| `lo_open(INV_WRITE)` | ~~**VULNERABLE** (Round 2 Cat 22)~~ → **Fixed** | Blocked (READ ONLY) |
| UDF wrapping dangerous fn | **NOT BLOCKED — known gap** | Blocked only if non-superuser role |

---

## Implementation Status

1. **Multi-statement blocking** (Layer 1): The AST validator always enforces single-statement
   SQL. This neutralizes all COMMIT-bypass, ROLLBACK-escape, and chained-DDL attacks.
2. **Statement allowlist** (Layer 1, readOnly mode): Only `SELECT` and `EXPLAIN SELECT`
   are permitted.
3. **Function denylist** (Layer 1): Dangerous built-in functions blocked by name at the AST
   level, including schema-qualified variants (schema prefix stripped, last segment checked).
4. **EXPLAIN ANALYZE block** (Layer 1): Prevents using EXPLAIN to execute functions.
5. **MERGE in CTE block** (Layer 1): `MergeStmt` nodes inside CTEs are rejected.
6. **READ ONLY transaction + ROLLBACK** (Layer 2): Catches DML not caught by Layer 1.

7. **EXPLAIN ANALYZE integer/boolean arg** (Layer 1): `hasAnalyze` now checks all three
   AST node types for the `ANALYZE` option arg: `String.sval` (`"true"`, `"on"`),
   `Integer.ival` (non-zero), `Boolean.boolval` (`true`). Unknown node types are blocked
   conservatively.

8. **Expanded function denylist** (Layer 1): Added 8 previously missing functions:
   - `pg_logical_emit_message` — non-transactional WAL writes bypass ROLLBACK entirely
   - `lo_open` — INV_WRITE mode (131072) writes to a large object
   - `pg_export_snapshot` — creates an exportable snapshot (persistent side-effect)
   - `pg_relation_filepath` — discloses the on-disk path of any relation
   - `pg_filenode_relation` — reverse-maps filenode OID to relation name (info disclosure)
   - `pg_replication_origin_session_setup` — sets persistent session-level replication origin
   - `pg_replication_origin_xact_setup` — sets transaction-level replication origin
   - `pg_replication_origin_session_reset` / `pg_replication_origin_xact_reset` — resets same

### Remaining known gaps

- **User-defined functions (UDFs)**: `SELECT my_evil_wrapper()` cannot be caught by the
  AST validator — function bodies are opaque at parse time. Mitigation: run the database
  user with only `SELECT` privileges (non-superuser role). This is the recommended
  defense-in-depth configuration.
- **`pg_logical_emit_message(false, ...)` note**: Even with the denylist fix in place, this
  function is uniquely dangerous because its non-transactional WAL write mode (`transactional=false`)
  is the only known vector that bypasses Layer 2 entirely. The Layer 1 fix is therefore
  load-bearing for this specific function.
