# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm install          # Install dependencies
pnpm build            # Compile TypeScript (tsc → dist/)
pnpm test             # Run all tests (vitest)
pnpm test -- tests/sql-validator.test.ts  # Run a single test file
pnpm typecheck        # Type-check without emitting
pnpm format           # Check formatting (prettier)
pnpm format:write     # Auto-fix formatting
pnpm dev              # Watch mode with .env loaded (requires .env file)
```

## Architecture

An MCP (Model Context Protocol) server that lets AI tools query PostgreSQL databases, optionally through an SSH tunnel. Runs over stdio transport.

**Entrypoint:** `src/server.ts` — loads env, optionally opens an SSH tunnel, creates a `pg.Pool`, registers MCP tools (`run_query`, `list_schemas`, `list_tables`, `describe_table`), and connects via `StdioServerTransport`.

**Key modules:**

- `config.ts` — Zod schema (`EnvSchema`) for all env vars, SSH config file parser, `resolveSshConfig()` picks connection mode (direct / SSH config alias / explicit SSH)
- `ssh-tunnel.ts` — wraps `tunnel-ssh` to open an SSH tunnel, returns `TunnelInfo` with local port
- `database.ts` — `pg.Pool` creation, query execution helpers. `runQuery` enforces read-only via `BEGIN TRANSACTION READ ONLY` + `ROLLBACK`
- `sql-validator.ts` — AST-level query validation using `pgsql-parser`/`@pgsql/traverse`. In read-only mode: allowlists `SelectStmt`/`ExplainStmt`, walks AST for hidden mutations (CTE DML, `SELECT INTO`, locking clauses). Always enforces single-statement limit
- `util.ts` — reads `package.json` for project name/version

**Three SSH connection modes** (determined by env vars):

1. **Direct** — no SSH vars → connect to Postgres directly
2. **SSH config** — `SSH_HOST` set → parse `~/.ssh/config` for that alias
3. **Explicit SSH** — `SSH_HOSTNAME` + `SSH_USER` → use env vars directly

## Code Style

- Prettier with `printWidth: 90`
- ESM (`"type": "module"`) — use `.js` extensions in imports even for `.ts` files
- TypeScript strict mode with `noUnusedLocals` and `noUnusedParameters`

## Testing

Unit tests go in the `tests/` directory, named `<module>.test.ts` (mirroring `src/<module>.ts`).

## README Maintenance

When adding features configurable via environment variables, update the Environment Variables section in `README.md`.
