/**
 * The LinkPilot MCP server.
 *
 * WHY THIS EXISTS, AND THE ONE CAVEAT THAT MATTERS
 *
 * Assistants hand people credentials constantly: a generated password, an
 * API key, a connection string. The usual ways of doing it are all bad. In
 * chat it persists in the history; in an email it persists forever.
 *
 * `create_secret_link` instead returns a URL that opens exactly once. The
 * plaintext is encrypted HERE, in this process, by the LinkPilot SDK. The
 * API is handed ciphertext and refuses plaintext outright. The key rides in
 * the URL's `#` fragment, which browsers never transmit, so LinkPilot stores
 * a blob it holds no key for.
 *
 * THE CAVEAT, stated plainly because a security tool that oversells itself
 * is worse than no tool: for the assistant to create the secret, the
 * plaintext must pass through the assistant's context. This server protects
 * the secret in transit and at rest, and shortens its life to a single view.
 * It does not and cannot hide it from the model that is calling it. If a
 * secret must never be seen by the assistant at all, the user should create
 * it themselves on the website or with the CLI.
 *
 * Everything else in this file is arrangement. That paragraph is the product.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LinkPilot } from "@uselinkpilot/sdk";
import { z } from "zod";
import { describeError } from "./errors.js";

export const SERVER_NAME = "linkpilot";
export const SERVER_VERSION = "0.1.0";

/** A tool result. `isError` is what tells the assistant not to trust the text. */
type Result = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const ok = (text: string): Result => ({ content: [{ type: "text", text }] });
const fail = (text: string): Result => ({ content: [{ type: "text", text }], isError: true });

/** Run a call and turn any failure into an actionable message, never a throw. */
async function attempt(fn: () => Promise<string>): Promise<Result> {
  try {
    return ok(await fn());
  } catch (err) {
    return fail(describeError(err));
  }
}

const TTL_UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

/**
 * Accepts "30m", "2h", "7d" or a bare number of seconds.
 *
 * Models reliably produce human durations and unreliably produce seconds, so
 * taking both removes a whole class of "expired in 2 minutes" surprises.
 */
export function parseTtl(input: string | undefined): number | undefined {
  if (input === undefined || input.trim() === "") return undefined;
  const text = input.trim().toLowerCase();

  const withUnit = /^(\d+)\s*([smhd])$/.exec(text);
  if (withUnit) {
    const n = Number(withUnit[1]);
    const unit = TTL_UNITS[withUnit[2] as string];
    if (!Number.isFinite(n) || n <= 0 || unit === undefined) {
      throw new Error(`Could not read "${input}" as a duration.`);
    }
    return n * unit;
  }

  if (/^\d+$/.test(text)) {
    const n = Number(text);
    if (n <= 0) throw new Error("A time to live must be greater than zero.");
    return n;
  }

  throw new Error(
    `Could not read "${input}" as a duration. Use 30m, 2h, 7d, or a number of seconds.`,
  );
}

export function createServer(client: LinkPilot): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    "create_secret_link",
    {
      title: "Create a one-time secret link",
      description:
        "Share a password, API key, token or private note as a link that self-destructs " +
        "after it is opened once. The text is encrypted in this process before it is sent; " +
        "LinkPilot receives ciphertext and cannot read it. Use this instead of putting a " +
        "credential in a chat message or an email. Returns a share URL that must be sent " +
        "to the recipient EXACTLY as given: the part after '#' is the decryption key, and " +
        "the link opens nothing without it. Nobody, including LinkPilot, can recover the " +
        "secret if the URL is lost. Note that the plaintext passes through this " +
        "conversation; if it must never be seen here, tell the user to create it " +
        "themselves at uselinkpilot.com instead.",
      inputSchema: {
        secret: z
          .string()
          .min(1)
          .describe("The text to protect. Encrypted here; never sent in the clear."),
        expires_in: z
          .string()
          .optional()
          .describe('How long until it expires: "30m", "2h", "7d", or a number of seconds.'),
        burn_after_read: z
          .boolean()
          .optional()
          .describe("Destroy it after the first view. Default true. Set false only if asked."),
        passphrase: z
          .string()
          .optional()
          .describe(
            "Optional second factor, Pro plans only. The recipient must type it to decrypt. " +
              "Send it over a DIFFERENT channel than the link, or it adds nothing.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) =>
      attempt(async () => {
        const ttl = parseTtl(args.expires_in);
        const created = await client.secrets.create({
          secret: args.secret,
          ...(ttl !== undefined ? { ttlSeconds: ttl } : {}),
          ...(args.burn_after_read !== undefined
            ? { burnAfterRead: args.burn_after_read }
            : {}),
          ...(args.passphrase !== undefined ? { passphrase: args.passphrase } : {}),
        });

        const lines = [
          "Secret link created. Send this URL, complete and unaltered:",
          "",
          created.shareUrl,
          "",
          `id: ${created.id}  (use it to revoke; it cannot reveal the secret)`,
          created.burnAfterRead
            ? "Destroyed after the first view."
            : "Not burn-after-read: it can be opened more than once until it expires.",
          created.expiresAt ? `Expires ${created.expiresAt}.` : "No expiry set.",
        ];
        if (args.passphrase !== undefined) {
          lines.push("Passphrase required. Send it over a different channel than the link.");
        }
        lines.push(
          "",
          "Do not trim anything after the '#': that is the decryption key, and it is not " +
            "recoverable. Do not post this link anywhere it may be opened by someone other " +
            "than the recipient, because the first viewer consumes it.",
        );
        return lines.join("\n");
      }),
  );

  server.registerTool(
    "create_short_link",
    {
      title: "Create a short link",
      description:
        "Shorten a URL to a branded LinkPilot short link with click tracking. " +
        "For public URLs. To share something private, use create_secret_link instead.",
      inputSchema: {
        url: z.string().url().describe("The destination URL, including https://."),
        slug: z
          .string()
          .optional()
          .describe("Custom path, for example 'launch'. Omit for a generated one."),
        domain: z
          .string()
          .optional()
          .describe("A custom domain on the account. Omit for the default."),
        title: z.string().optional().describe("A label, shown in the dashboard only."),
        tags: z.array(z.string()).optional().describe("Tags for filtering in the dashboard."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) =>
      attempt(async () => {
        const link = await client.links.create({
          url: args.url,
          ...(args.slug !== undefined ? { slug: args.slug } : {}),
          ...(args.domain !== undefined ? { domain: args.domain } : {}),
          ...(args.title !== undefined ? { title: args.title } : {}),
          ...(args.tags !== undefined ? { tags: args.tags } : {}),
        });
        return `Short link created:\n\n${link.short_url}\n\n-> ${link.url}\nid: ${link.id}`;
      }),
  );

  server.registerTool(
    "list_links",
    {
      title: "List short links",
      description: "List short links on the account, newest first, with click counts.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("How many to return. Default 20."),
        cursor: z
          .string()
          .optional()
          .describe("Cursor from a previous call, to fetch the next page."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) =>
      attempt(async () => {
        const page = await client.links.list({
          limit: args.limit ?? 20,
          ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
        });
        if (page.data.length === 0) return "No short links on this account yet.";
        const rows = page.data.map((l) => {
          const extra = l.title ? ` | ${l.title}` : "";
          return `${l.short_url}  ->  ${l.url}\n  ${l.total_clicks} clicks | id ${l.id}${extra}`;
        });
        const more = page.next_cursor
          ? `\n\nMore available. Next cursor: ${page.next_cursor}`
          : "";
        return rows.join("\n\n") + more;
      }),
  );

  server.registerTool(
    "list_secrets",
    {
      title: "List secret links",
      description:
        "List secret links on the account. METADATA ONLY: status, view count and expiry. " +
        "No route can return the secret text or the key, by design, so this cannot be used " +
        "to read a secret back. Use it to check whether one has been opened yet.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("How many to return. Default 20."),
        cursor: z
          .string()
          .optional()
          .describe("Cursor from a previous call, to fetch the next page."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) =>
      attempt(async () => {
        const page = await client.secrets.list({
          limit: args.limit ?? 20,
          ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
        });
        if (page.data.length === 0) return "No secret links on this account yet.";
        const rows = page.data.map((s) => {
          const bits = [
            `status ${s.status}`,
            `${s.view_count} view${s.view_count === 1 ? "" : "s"}`,
            s.burn_after_read ? "burn after read" : "multi-view",
          ];
          if (s.passphrase_protected) bits.push("passphrase");
          if (s.expires_at) bits.push(`expires ${s.expires_at}`);
          return `id ${s.id}\n  ${bits.join(" | ")}`;
        });
        const more = page.next_cursor
          ? `\n\nMore available. Next cursor: ${page.next_cursor}`
          : "";
        return rows.join("\n\n") + more;
      }),
  );

  server.registerTool(
    "revoke_secret",
    {
      title: "Revoke a secret link",
      description:
        "Destroy a secret link immediately so it can never be opened. Irreversible. " +
        "Use it when a secret was shared by mistake or is no longer needed.",
      inputSchema: {
        id: z
          .string()
          .min(1)
          .describe("The secret's id, from create_secret_link or list_secrets."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) =>
      attempt(async () => {
        await client.secrets.revoke(args.id);
        return `Secret ${args.id} revoked. The link is dead and the ciphertext is gone.`;
      }),
  );

  server.registerTool(
    "whoami",
    {
      title: "Show the LinkPilot account",
      description:
        "Show the workspace, plan, limits, usage and remaining rate budget for the " +
        "configured API key. Useful for checking a limit before a bulk operation, or for " +
        "confirming which account is connected.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () =>
      attempt(async () => {
        const me = await client.me();
        const cap = (v: number | null) => (v === null ? "unlimited" : String(v));
        return [
          `Workspace: ${me.tenant.name}`,
          `Plan: ${me.plan.name}`,
          "",
          `Links:   ${me.usage.links} of ${cap(me.limits.max_links)}`,
          `Secrets: ${me.usage.secrets} active of ${cap(me.limits.max_active_secrets)}`,
          `Domains: ${me.usage.domains} of ${cap(me.limits.max_domains)}`,
          `Passphrase-protected secrets: ${
            me.limits.secret_passphrase_enabled ? "available" : "a Pro feature, not on this plan"
          }`,
          "",
          `Rate limit: ${me.rate_limit.remaining} of ${me.rate_limit.limit_per_hour} left ` +
            `this hour (resets ${me.rate_limit.reset_at}).`,
        ].join("\n");
      }),
  );

  return server;
}
