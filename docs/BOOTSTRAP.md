
This project is a template of an MCP server. Its original purposes doesn't matter, you need to edit @src/server.ts file to create an MCP server that

# Instructions
- Create a new MCP server that connects to a remote postgres database, and exposes a tool that allows LLMs to execute SQL queries against the database and get the results. The tool would be extremely simple: accept a query as a string, execute it, and return the results. If something goes wrong, the tool should return an error message

- The Postgres database is hosted on AWS RDS, and is accessible via a bastion host. The bastion host is accessible via SSH, and the database is accessible via the bastion host, so you'll need to design a solution to connect to the database via the bastion host (ssh tunneling). You're free to ask questions if you need me to clarify anything for you
    - The ssh connection must be completely configurable using environment variables and from the SSH config file.
    - Add some extra optional environment variables that allow manual override of the host configuration, but allow the user to just provide the hostname, and the tool will read the default SSH config file to connect to the host. The options must be either (mutually exclusive):
    1. Provide the host `SSH_HOST` and the tool will read the default SSH config file to connect to the host.
    2. Provide all necessary informations via environment variables:
    - `SSH_HOSTNAME`: The hostname of the host (string) (example: bastion.outfit-qa.com)
    - `SSH_USER`: The user to connect to the host (string)
    - `SSH_PORT`: The port to connect to the host (number) [optional, default: 22]
    - `SSH_STRICT_HOST_KEY_CHECKING`: Whether to check the host key against the known hosts file (true or false) [optional, default: true]
    - `SSH_IDENTITY_FILE`: The identity file to use for the connection (absolute path to the file) [optional, default: undefined]

# Technical requirements
- Use `pg` library to connect to postgres, `zod` to validate environment variables and map them to the `pg` config object
- Add `https://www.npmjs.com/package/dotenv` to the project to load environment variables from .env file
    - The env file should ONLY be loaded when running in development mode (pnpm dev), not when running in production mode (pnpm start)

# Useful documentation
## Guidelines on how to build an MCP server
- @docs/MCP_SERVER_IMPLEMENTATION_GUIDELINES.md

## Example of a working MCP server
- @docs/simpleStatelessStreamableHttp.ts

## Example of how to connect to postgres and use a simple query
```ts
// export interface ClientConfig {
//     user?: string | undefined;
//     database?: string | undefined;
//     password?: string | (() => string | Promise<string>) | undefined;
//     port?: number | undefined;
//     host?: string | undefined;
//     connectionString?: string | undefined;
//     keepAlive?: boolean | undefined;
//     stream?: () => stream.Duplex | undefined;
//     statement_timeout?: false | number | undefined;
//     ssl?: boolean | ConnectionOptions | undefined;
//     query_timeout?: number | undefined;
//     lock_timeout?: number | undefined;
//     keepAliveInitialDelayMillis?: number | undefined;
//     idle_in_transaction_session_timeout?: number | undefined;
//     application_name?: string | undefined;
//     fallback_application_name?: string | undefined;
//     connectionTimeoutMillis?: number | undefined;
//     types?: CustomTypesConfig | undefined;
//     options?: string | undefined;
//     client_encoding?: string | undefined;
// }

// Available environment variables: DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD
const config = {
// Fill in the config here by reading the validated environment variables (validate them using Zod, create a zod type containing all expected env vars, then populate an object with them, validate them with zod, then map it to this pg config object)
};
const client = await (new Client(config)).connect()

try {
    const res = await client.query('SELECT $1::text as message', ['Hello world!'])
    console.log(res.rows[0].message) // Hello world!
} finally {
    await client.end()
}
```

## Example of a SSH config file

```
Host homelab
  Hostname 10.55.50.10
  User user
  Port 22
  PreferredAuthentications publickey
  IdentityFile C:\Users\User\.ssh\debian-docker\debian-docker

Host outfit-dev-bastion
    HostName bastion.outfit-qa.com
    User gabriel
    StrictHostKeyChecking no
    IdentityFile C:\Users\User\.ssh\work\outfitlabs\bastion-dev
```