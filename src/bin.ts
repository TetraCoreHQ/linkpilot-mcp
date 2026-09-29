#!/usr/bin/env node
/**
 * stdio entry point.
 *
 * TWO RULES THIS FILE EXISTS TO ENFORCE:
 *
 * 1. NOTHING MAY BE WRITTEN TO STDOUT except MCP protocol frames. stdout is
 *    the transport. A stray console.log corrupts the stream and the client
 *    reports a confusing parse error rather than the message you printed.
 *    Diagnostics go to stderr, always.
 *
 * 2. THE API KEY IS NEVER ECHOED. Not on success, not in an error, not
 *    truncated. A key that reaches a log file outlives the process it leaked
 *    from, and this server exists to keep credentials out of exactly those
 *    places.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LinkPilot, API_KEY_PREFIX } from "@uselinkpilot/sdk";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

const ENV_KEY = "LINKPILOT_API_KEY";

function readApiKey(env: NodeJS.ProcessEnv): string {
  const key = env[ENV_KEY]?.trim();

  if (!key) {
    throw new Error(
      `${ENV_KEY} is not set.\n\n` +
        "Create a key at https://uselinkpilot.com/app/api-keys, then add this " +
        "server to your MCP client configuration:\n\n" +
        '  "linkpilot": {\n' +
        '    "command": "npx",\n' +
        '    "args": ["-y", "@uselinkpilot/mcp"],\n' +
        `    "env": { "${ENV_KEY}": "${API_KEY_PREFIX}your-key-here" }\n` +
        "  }\n",
    );
  }

  // Caught here rather than as a 401 on the first tool call, where the
  // assistant would have to guess whether the key is wrong or the account is.
  if (!key.startsWith(API_KEY_PREFIX)) {
    throw new Error(
      `${ENV_KEY} does not look like a LinkPilot API key: they begin with ` +
        `"${API_KEY_PREFIX}". The value is not shown here on purpose. Check it at ` +
        "https://uselinkpilot.com/app/api-keys.",
    );
  }
  return key;
}

async function main(): Promise<void> {
  const client = new LinkPilot({ apiKey: readApiKey(process.env) });
  const server = createServer(client);

  await server.connect(new StdioServerTransport());

  // stderr, not stdout. See rule 1.
  process.stderr.write(`${SERVER_NAME} MCP server ${SERVER_VERSION} ready on stdio\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
