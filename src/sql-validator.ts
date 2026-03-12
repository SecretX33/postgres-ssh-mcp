import { parse } from 'pgsql-parser';
import { walk } from '@pgsql/traverse';

export class ValidationError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
  }
}

const ALLOWED_STATEMENT_TYPES = new Set(['SelectStmt', 'ExplainStmt']);

function deepWalkCheck(ast: unknown): void {
  walk(ast as Parameters<typeof walk>[0], {
    // Mutating statements inside CTEs
    DeleteStmt() {
      throw new ValidationError(
        'FORBIDDEN_NESTED_MUTATION',
        'Mutating statements inside CTEs are not allowed',
      );
    },
    InsertStmt() {
      throw new ValidationError(
        'FORBIDDEN_NESTED_MUTATION',
        'Mutating statements inside CTEs are not allowed',
      );
    },
    UpdateStmt() {
      throw new ValidationError(
        'FORBIDDEN_NESTED_MUTATION',
        'Mutating statements inside CTEs are not allowed',
      );
    },
    // SELECT INTO creates a table
    SelectStmt(path) {
      const node = path.node as Record<string, unknown>;
      if (node['intoClause'] != null) {
        throw new ValidationError(
          'FORBIDDEN_SELECT_INTO',
          'SELECT INTO is not allowed',
        );
      }
      if (
        Array.isArray(node['lockingClause']) &&
        node['lockingClause'].length > 0
      ) {
        throw new ValidationError(
          'FORBIDDEN_LOCKING',
          'FOR UPDATE/SHARE locking clauses are not allowed',
        );
      }
    },
  });
}

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
export async function validateQuery(sql: string): Promise<void> {
  // Stage 2 pre-check — empty before parse
  if (sql.trim() === '') {
    throw new ValidationError('EMPTY_QUERY', 'Query is empty');
  }

  // Stage 1 — parse
  // pgsql-parser returns { version: number, stmts: Array<{ stmt: { <StmtType>: {...} } }> }
  let parsed: Awaited<ReturnType<typeof parse>>;
  try {
    parsed = await parse(sql);
  } catch (err) {
    throw new ValidationError(
      'PARSE_ERROR',
      `SQL syntax error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const stmts = (parsed as unknown as { stmts: Array<{ stmt: Record<string, unknown> }> }).stmts;

  // Stage 2 — multi-statement / empty
  if (!stmts || stmts.length === 0) {
    throw new ValidationError('EMPTY_QUERY', 'Query is empty');
  }
  if (stmts.length > 1) {
    throw new ValidationError(
      'MULTI_STATEMENT',
      'Only single statements are allowed',
    );
  }

  // Stage 3 — allowlist
  const rawStmt = stmts[0];
  const stmtNode = rawStmt.stmt;
  const stmtType = Object.keys(stmtNode)[0];

  if (!ALLOWED_STATEMENT_TYPES.has(stmtType)) {
    throw new ValidationError(
      'FORBIDDEN_STATEMENT',
      `${stmtType.replace('Stmt', '')} statements are not allowed`,
    );
  }

  // Stage 3b — EXPLAIN inner check
  if (stmtType === 'ExplainStmt') {
    const explainNode = stmtNode['ExplainStmt'] as Record<string, unknown>;
    const innerStmt = explainNode['query'] as Record<string, unknown> | undefined;
    const innerType = innerStmt ? Object.keys(innerStmt)[0] : '';
    if (innerType !== 'SelectStmt') {
      throw new ValidationError(
        'FORBIDDEN_EXPLAIN_TARGET',
        'EXPLAIN is only allowed for SELECT statements',
      );
    }
  }

  // Stage 3c — deep walk for hidden mutations
  deepWalkCheck(rawStmt);
}
