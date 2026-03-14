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

| Tool             | Description                                                    |
|------------------|----------------------------------------------------------------|
| `run_query`      | Execute a SQL query (read-only by default; see `DB_READ_ONLY`) |
| `list_schemas`   | List all schemas in the database                               |
| `list_tables`    | List tables in a schema (default: `public`)                    |
| `describe_table` | Show columns, types, and nullability for a table               |

## Environment Variables

These are all environment variables that can be used to configure this MCP server.

### Required

| Variable      | Description                   |
|---------------|-------------------------------|
| `DB_HOST`     | Postgres host or RDS endpoint |
| `DB_NAME`     | Database name                 |
| `DB_USER`     | Database user                 |
| `DB_PASSWORD` | Database password             |

### Optional

| Variable                       | Default | Description                                              |
|--------------------------------|---------|----------------------------------------------------------|
| `DB_PORT`                      | `5432`  | Postgres port                                                    |
| `DB_READ_ONLY`                 | `true`  | Set to `false` to allow write queries (`run_query` only)         |
| `DB_SSL`                       | `false` | Enable TLS for the database connection                           |
| `DB_SSL_CA`                    | —       | Path to a custom CA certificate file (PEM) for SSL verification  |
| `DB_SSL_REJECT_UNAUTHORIZED`   | `true`  | Set to `false` to skip SSL certificate validation (insecure)     |
| `DB_MAX_ROWS`                  | `1000`  | Maximum rows returned per query. Uses cursor-based fetching in read-only mode |
| `DB_CONNECTION_POOL_SIZE`      | `5`     | Maximum number of connections in the pool                         |
| `DB_CONNECTION_TIMEOUT_MS`     | `10000` | Milliseconds to wait for a connection from the pool              |
| `DB_QUERY_TIMEOUT_SECONDS`     | `15`    | How many seconds before a query is forcibly cancelled            |
| `SSH_HOST`                     | —       | SSH config alias (reads `~/.ssh/config`)                         |
| `SSH_HOSTNAME`                 | —       | Bastion hostname or IP                                           |
| `SSH_USER`                     | —       | SSH login user                                                   |
| `SSH_PORT`                     | `22`    | SSH port                                                         |
| `SSH_STRICT_HOST_KEY_CHECKING` | `true`  | Enables or disables strict host checking                         |
| `SSH_IDENTITY_FILE`            | —       | Absolute path or `~/...` to private key file                     |
| `SSH_KEY_PASSPHRASE`           | —       | Passphrase for an encrypted private key                          |
| `SSH_PASSWORD`                 | —       | SSH password (alternative to key-based auth)                     |
| `SSH_KEEPALIVE_INTERVAL_MS`    | `0`     | Milliseconds between SSH keepalive probes (0 to disable)         |
| `SSH_TRUST_ON_FIRST_USE`       | `true`  | Auto-accept and save unknown SSH host keys on first connection   |
| `SSH_KNOWN_HOSTS_PATH`         | —       | Path to custom known_hosts file (default: `~/.ssh/known_hosts`)  |
| `SSH_MAX_RECONNECT_ATTEMPTS`   | `5`     | Max SSH reconnection attempts (-1 for unlimited, 0 to disable)   |
| `POOL_DRAIN_TIMEOUT_MS`        | `5000`  | Milliseconds to wait for old pool to drain during reconnection   |

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
