# postgres-ssh-mcp

Cross-platform MCP server for PostgreSQL with SSH tunnel support. Works on macOS, Linux, and Windows.

## Overview

`postgres-ssh-mcp` exposes MCP tools that allow AI tools to query and introspect PostgreSQL databases. It supports three connection modes:

## Connection Modes

| Mode             | When it activates                   | How it connects                                                                              |
|------------------|-------------------------------------|----------------------------------------------------------------------------------------------|
| **Direct**       | No SSH vars set                     | Connects to Postgres directly (no tunnel)                                                    |
| **SSH config**   | `SSH_HOST` is set                   | Reads `~/.ssh/config` for the given alias; uses its `HostName`, `User`, `IdentityFile`, etc. |
| **Explicit SSH** | `SSH_HOSTNAME` + `SSH_USER` are set | Opens an SSH tunnel using the values from environment variables                              |

## Using with AI Tools

### Any MCP-Compatible Tool

Tools such as Claude Desktop, Cursor, and Windsurf use a JSON config file. Add an entry under `mcpServers`:

```json5
{
  "mcpServers": {
    "postgres-ssh-mcp": {
      "command": "npx",
      "args": ["-y", "postgres-ssh-mcp"],
      "env": {
        "DB_HOST": "localhost",
        "DB_NAME": "mydb",
        "DB_USER": "dbuser",
        "DB_PASSWORD": "dbpassword",
        
        // If you have an SSH config alias:
        "SSH_HOST": "my-bastion",
        
        // Or if you need explicit SSH:
        "SSH_HOSTNAME": "127.0.0.1",
        "SSH_USER": "mybastionuser",
        "SSH_IDENTITY_FILE": "~/.ssh/mybastionkey", // optional if you use the default key path
        "SSH_KEY_PASSPHRASE": "mypassphrase", // optional, if your private key is encrypted
        "SSH_PORT": "1234", // defaults to 22
      }
    }
  }
}
```

For SSH tunnel connections, add `SSH_HOST` (SSH config alias) or `SSH_HOSTNAME` + `SSH_USER` (explicit credentials) to the `env` block.

### Claude Code

Use `claude mcp add` to register the server. All environment variables must be passed via `--env` flags.

```bash
claude mcp add --transport stdio postgres-ssh-mcp \
  --env DB_HOST=localhost \
  --env DB_NAME=mydb \
  --env DB_USER=dbuser \
  --env DB_PASSWORD=dbpassword \
  -- npx -y postgres-ssh-mcp
```

**Hint:** You can include `--scope project` to add the server only to the current project.

## Tools

| Tool             | Description                                                           |
|------------------|-----------------------------------------------------------------------|
| `run_query`      | Execute a SQL query (read-only by default; see `DB_READ_ONLY`)        |
| `list_schemas`   | List all schemas in the database                                      |
| `list_tables`    | List tables in a schema (default: `public`)                           |
| `describe_table` | Show columns, types, and nullability for a table                      |

## Environment Variables

These are all environment variables that can be used to configure this MCP server. 

| Variable                       | Required | Default | Description                                              |
|--------------------------------|----------|---------|----------------------------------------------------------|
| `DB_HOST`                      | Yes      | —       | Postgres host or RDS endpoint                            |
| `DB_PORT`                      | No       | `5432`  | Postgres port                                            |
| `DB_NAME`                      | Yes      | —       | Database name                                            |
| `DB_USER`                      | Yes      | —       | Database user                                            |
| `DB_PASSWORD`                  | Yes      | —       | Database password                                        |
| `DB_READ_ONLY`                 | No       | `true`  | Set to `false` to allow write queries (`run_query` only) |
| `SSH_HOST`                     | No       | —       | SSH config alias (reads `~/.ssh/config`)                 |
| `SSH_HOSTNAME`                 | No       | —       | Bastion hostname or IP                                   |
| `SSH_USER`                     | No       | —       | SSH login user                                           |
| `SSH_PORT`                     | No       | `22`    | SSH port                                                 |
| `SSH_STRICT_HOST_KEY_CHECKING` | No       | `true`  | Enables or disables strict host checking                 |
| `SSH_IDENTITY_FILE`            | No       | —       | Absolute path or `~/...` to private key file             |
| `SSH_KEY_PASSPHRASE`           | No       | —       | Passphrase for an encrypted private key                  |

## Development

Copy the example env file and fill in your values:

```bash
git clone https://github.com/SecretX33/postgres-ssh-mcp.git
cd postgres-ssh-mcp
npm install
npm run build
```

The compiled server is written to `dist/server.js`.

Copy the example env file and fill in your values:

```bash
cp .env.example .env
# edit .env
```

Then run in watch mode (automatically loads `.env`):

```bash
npm run dev
```

## License
MIT
