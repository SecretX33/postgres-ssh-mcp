# postgres-ssh-mcp

Cross-platform MCP server for PostgreSQL with SSH tunnel support. Works on macOS, Linux, and Windows.

## Overview

`postgres-ssh-mcp` exposes MCP tools that allow AI tools to query and introspect PostgreSQL databases. It supports three connection modes:

- **Direct** — connect to Postgres without any SSH tunnel
- **SSH config** — tunnel through a bastion using an alias from `~/.ssh/config`
- **Explicit SSH** — tunnel through a bastion using credentials passed as environment variables

## Tools

| Tool             | Description                                                           |
|------------------|-----------------------------------------------------------------------|
| `run_query`      | Execute a read-only SQL query (runs inside a `READ ONLY` transaction) |
| `list_schemas`   | List all schemas in the database                                      |
| `list_tables`    | List tables in a schema (default: `public`)                           |
| `describe_table` | Show columns, types, and nullability for a table                      |

## Connection Modes

| Mode             | When it activates                   | How it connects                                                                              |
|------------------|-------------------------------------|----------------------------------------------------------------------------------------------|
| **Direct**       | No SSH vars set                     | Connects to Postgres directly (no tunnel)                                                    |
| **SSH config**   | `SSH_HOST` is set                   | Reads `~/.ssh/config` for the given alias; uses its `HostName`, `User`, `IdentityFile`, etc. |
| **Explicit SSH** | `SSH_HOSTNAME` + `SSH_USER` are set | Opens an SSH tunnel using the values from environment variables                              |

## Environment Variables

| Variable                       | Required | Default | Description                                  |
|--------------------------------|----------|---------|----------------------------------------------|
| `DB_HOST`                      | Yes      | —       | Postgres host or RDS endpoint                |
| `DB_PORT`                      | No       | `5432`  | Postgres port                                |
| `DB_NAME`                      | Yes      | —       | Database name                                |
| `DB_USER`                      | Yes      | —       | Database user                                |
| `DB_PASSWORD`                  | Yes      | —       | Database password                            |
| `SSH_HOST`                     | No       | —       | SSH config alias (reads `~/.ssh/config`)     |
| `SSH_HOSTNAME`                 | No       | —       | Bastion hostname or IP                       |
| `SSH_USER`                     | No       | —       | SSH login user                               |
| `SSH_PORT`                     | No       | `22`    | SSH port                                     |
| `SSH_STRICT_HOST_KEY_CHECKING` | No       | `true`  | Accept `true`/`false`/`yes`/`no`             |
| `SSH_IDENTITY_FILE`            | No       | —       | Absolute path or `~/...` to private key file |

## Prerequisites

- Node.js ≥ 18
- pnpm

## Installation & Build

```bash
git clone https://github.com/your-org/postgres-ssh-mcp.git
cd postgres-ssh-mcp
pnpm install
pnpm build
```

The compiled server is written to `build/server.js`.

## Using with AI Tools

### Claude Code

Use `claude mcp add` to register the server. All environment variables must be passed via `--env` flags.

```bash
claude mcp add --transport stdio postgres-ssh-mcp \
  --env DB_HOST=localhost \
  --env DB_NAME=mydb \
  --env DB_USER=dbuser \
  --env DB_PASSWORD=secret \
  -- node /absolute/path/to/postgres-ssh-mcp/build/server.js
```

**Hint:** You can include `--scope project` to add the server only to the current project. 

### Any MCP-Compatible Tool

Tools such as Claude Desktop, Cursor, and Windsurf use a JSON config file. Add an entry under `mcpServers`:

```json
{
  "mcpServers": {
    "postgres-ssh-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/postgres-ssh-mcp/build/server.js"],
      "env": {
        "DB_HOST": "localhost",
        "DB_NAME": "mydb",
        "DB_USER": "dbuser",
        "DB_PASSWORD": "secret"
      }
    }
  }
}
```

For SSH tunnel connections, add `SSH_HOST` (SSH config alias) or `SSH_HOSTNAME` + `SSH_USER` (explicit credentials) to the `env` block.

## Development

Copy the example env file and fill in your values:

```bash
cp .env.example .env
# edit .env
```

Then run in watch mode (automatically loads `.env`):

```bash
pnpm dev
```

## License
MIT
