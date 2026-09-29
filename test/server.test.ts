/**
 * Tests drive the REAL SDK and a REAL MCP client, with only the network faked.
 *
 * That distinction is not pedantry. The CLI in this family shipped two bugs
 * its unit tests could not see, because the fakes were built from shapes I
 * had invented rather than the ones the API returns. So here: every response
 * below is the literal JSON the API sends, the SDK's own encryption runs for
 * real, and calls go through an actual Client over an in-memory pipe, which
 * exercises the input schemas and the result envelope the way a real MCP
 * host does.
 */
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LinkPilot, API_KEY_PREFIX } from "@uselinkpilot/sdk";
import * as crypto from "@uselinkpilot/sdk/crypto";
import { createServer, parseTtl } from "../src/server.js";
import { describeError } from "../src/errors.js";

const KEY = `${API_KEY_PREFIX}0123456789abcdef0123456789abcdef`;

interface Captured {
  url: string;
  method: string;
  rawBody?: string;
  body?: Record<string, unknown>;
}

type Script = (req: Captured) => {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
};

async function harness(script: Script) {
  const calls: Captured[] = [];
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const raw = typeof init?.body === "string" ? init.body : undefined;
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      rawBody: raw,
      body: raw ? JSON.parse(raw) : undefined,
    });
    const out = script(calls[calls.length - 1] as Captured);
    const status = out.status ?? 200;
    return new Response(status === 204 ? null : JSON.stringify(out.body ?? {}), {
      status,
      headers: { "Content-Type": "application/json", ...(out.headers ?? {}) },
    });
  }) as unknown as typeof globalThis.fetch;

  const server = createServer(new LinkPilot({ apiKey: KEY, fetch }));
  const client = new Client({ name: "test", version: "0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

  async function call(name: string, args: Record<string, unknown> = {}) {
    const res = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    const text = res.content.map((c) => c.text ?? "").join("\n");
    return { isError: res.isError === true, text };
  }

  return { calls, client, call };
}

const SECRET_RESPONSE = {
  id: "sec_1",
  secret_url: "https://shrd.link/s/abcdefghij",
  expires_at: null,
  burn_after_read: true,
};

/** Pull the share URL out of a tool result the way a reader would. */
const urlIn = (text: string) => text.split("\n").find((l) => l.startsWith("https://")) ?? "";

describe("the tool surface a client actually sees", () => {
  it("advertises exactly the intended tools", async () => {
    const { client } = await harness(() => ({ body: {} }));
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "create_secret_link",
      "create_short_link",
      "list_links",
      "list_secrets",
      "revoke_secret",
      "whoami",
    ]);
  });

  it("marks revoke_secret destructive and the read tools read-only", async () => {
    // These annotations are how a host decides what to confirm with a human.
    // Wrong here means either nagging on reads or destroying without asking.
    const { client } = await harness(() => ({ body: {} }));
    const by = new Map((await client.listTools()).tools.map((t) => [t.name, t.annotations]));
    expect(by.get("revoke_secret")?.destructiveHint).toBe(true);
    expect(by.get("list_links")?.readOnlyHint).toBe(true);
    expect(by.get("list_secrets")?.readOnlyHint).toBe(true);
    expect(by.get("whoami")?.readOnlyHint).toBe(true);
    expect(by.get("create_secret_link")?.readOnlyHint).toBe(false);
  });

  it("warns in create_secret_link's own description that the plaintext is visible here", async () => {
    // The caveat has to reach the model that calls the tool, not only the
    // humans reading the source.
    const { client } = await harness(() => ({ body: {} }));
    const t = (await client.listTools()).tools.find((x) => x.name === "create_secret_link");
    expect(t?.description).toMatch(/passes through this conversation/i);
  });
});

describe("create_secret_link: the plaintext must never reach the wire", () => {
  const SECRET = "hunter2-UNIQUE-MARKER-9f3a";

  it("sends ciphertext and enc_version, and no payload field", async () => {
    const { calls, call } = await harness(() => ({ status: 201, body: SECRET_RESPONSE }));
    const res = await call("create_secret_link", { secret: SECRET });

    const req = calls[0] as Captured;
    expect(req.rawBody).not.toContain(SECRET);
    expect(req.body?.payload).toBeUndefined();
    expect(String(req.body?.ciphertext).startsWith("v1.")).toBe(true);
    expect(req.body?.enc_version).toBe(1);
    expect(res.isError).toBe(false);
  });

  it("never puts the plaintext in the text handed back to the model", async () => {
    const { call } = await harness(() => ({ status: 201, body: SECRET_RESPONSE }));
    expect((await call("create_secret_link", { secret: SECRET })).text).not.toContain(SECRET);
  });

  it("returns a share URL whose key really decrypts what was sent", async () => {
    const { calls, call } = await harness(() => ({ status: 201, body: SECRET_RESPONSE }));
    const url = urlIn((await call("create_secret_link", { secret: SECRET })).text);
    expect(url.startsWith("https://shrd.link/s/abcdefghij#k=")).toBe(true);

    const sent = String((calls[0] as Captured).body?.ciphertext);
    const key = crypto.readFragmentKey(url.slice(url.indexOf("#")));
    expect(await crypto.decryptPayload(sent, key)).toBe(SECRET);
  });

  it("sends a passphrase only as a hash, and needs both halves to open", async () => {
    const { calls, call } = await harness(() => ({ status: 201, body: SECRET_RESPONSE }));
    const res = await call("create_secret_link", { secret: SECRET, passphrase: "open sesame" });

    const req = calls[0] as Captured;
    expect(req.rawBody).not.toContain("open sesame");
    expect(req.body?.passphrase).toBeUndefined();
    expect(String(req.body?.passphrase_hash)).toMatch(/^[0-9a-f]{64}$/);
    expect(String(req.body?.ciphertext).startsWith("v1p.")).toBe(true);

    const url = urlIn(res.text);
    const key = crypto.readFragmentKey(url.slice(url.indexOf("#")));
    const stored = String(req.body?.ciphertext);
    await expect(crypto.decryptPayload(stored, key)).rejects.toThrow();
    expect(await crypto.decryptPayload(stored, key, "open sesame")).toBe(SECRET);
  });

  it("tells the model not to truncate the fragment", async () => {
    // The likeliest way for an assistant to destroy a secret is to tidy the
    // URL. Say so in the result, every time.
    const { call } = await harness(() => ({ status: 201, body: SECRET_RESPONSE }));
    expect((await call("create_secret_link", { secret: SECRET })).text).toMatch(/do not trim/i);
  });

  it("rejects an empty secret at the schema, before any request", async () => {
    const { calls, call } = await harness(() => ({ status: 201, body: SECRET_RESPONSE }));
    const res = await call("create_secret_link", { secret: "" });
    expect(res.isError).toBe(true);
    expect(calls.length).toBe(0);
  });
});

describe("expires_in accepts what a model will actually produce", () => {
  it("reads units and bare seconds", () => {
    expect(parseTtl("30m")).toBe(1800);
    expect(parseTtl("2h")).toBe(7200);
    expect(parseTtl("7d")).toBe(604800);
    expect(parseTtl("45s")).toBe(45);
    expect(parseTtl("90")).toBe(90);
    expect(parseTtl("  2 h ")).toBe(7200);
    expect(parseTtl(undefined)).toBeUndefined();
    expect(parseTtl("")).toBeUndefined();
  });

  it("refuses nonsense rather than silently picking a duration", () => {
    // Guessing here means a secret expiring at a time nobody chose.
    expect(() => parseTtl("soon")).toThrow(/could not read/i);
    expect(() => parseTtl("0")).toThrow();
    expect(() => parseTtl("-5")).toThrow();
    expect(() => parseTtl("2 weeks")).toThrow();
  });

  it("converts before sending", async () => {
    const { calls, call } = await harness(() => ({ status: 201, body: SECRET_RESPONSE }));
    await call("create_secret_link", { secret: "x", expires_in: "2h" });
    expect((calls[0] as Captured).body?.ttl_seconds).toBe(7200);
  });

  it("reports a bad duration as a tool error and sends nothing", async () => {
    const { calls, call } = await harness(() => ({ status: 201, body: SECRET_RESPONSE }));
    const res = await call("create_secret_link", { secret: "x", expires_in: "soon" });
    expect(res.isError).toBe(true);
    expect(calls.length).toBe(0);
  });
});

describe("the other tools hit the right routes", () => {
  it("creates a short link", async () => {
    const { calls, call } = await harness(() => ({
      body: {
        id: "l1",
        short_url: "https://shrd.link/abc",
        url: "https://example.com",
        slug: "abc",
        title: null,
        tags: [],
        total_clicks: 0,
        expires_at: null,
        created_at: "2026-09-29T00:00:00Z",
      },
    }));
    const res = await call("create_short_link", { url: "https://example.com" });
    expect((calls[0] as Captured).method).toBe("POST");
    expect(res.text).toContain("https://shrd.link/abc");
  });

  it("lists links with click counts and a next cursor", async () => {
    const { call } = await harness(() => ({
      body: {
        data: [
          {
            id: "l1",
            short_url: "https://shrd.link/abc",
            url: "https://example.com",
            slug: "abc",
            title: "Launch",
            tags: [],
            total_clicks: 7,
            expires_at: null,
            created_at: "2026-09-29T00:00:00Z",
          },
        ],
        next_cursor: "c2",
      },
    }));
    const text = (await call("list_links", {})).text;
    expect(text).toContain("7 clicks");
    expect(text).toContain("Launch");
    expect(text).toContain("Next cursor: c2");
  });

  it("lists secrets as metadata only, never a payload or a key", async () => {
    const { call } = await harness(() => ({
      body: {
        data: [
          {
            id: "s1",
            secret_url: "https://shrd.link/s/aaa",
            status: "active",
            expires_at: null,
            burn_after_read: true,
            burn_after_views: null,
            view_count: 0,
            passphrase_protected: false,
            created_at: "2026-09-29T00:00:00Z",
          },
        ],
        next_cursor: null,
      },
    }));
    const text = (await call("list_secrets", {})).text;
    expect(text).toContain("s1");
    expect(text).toContain("burn after read");
    expect(text).not.toMatch(/ciphertext|payload|#k=/);
  });

  it("says so plainly when there is nothing to list", async () => {
    const { call } = await harness(() => ({ body: { data: [], next_cursor: null } }));
    expect((await call("list_links", {})).text).toMatch(/no short links/i);
  });

  it("revokes by id", async () => {
    const { calls, call } = await harness(() => ({ status: 204 }));
    const res = await call("revoke_secret", { id: "sec_1" });
    expect((calls[0] as Captured).method).toBe("DELETE");
    expect(res.text).toContain("revoked");
  });

  it("reports plan and limits from the real /me shape", async () => {
    // This body is copied from a live /me response, not invented. An earlier
    // guess at this shape is exactly what the CLI got wrong.
    const { call } = await harness(() => ({
      body: {
        tenant: { id: "t1", name: "Acme Inc" },
        plan: { slug: "pro", name: "Pro" },
        limits: {
          max_links: null,
          max_domains: 5,
          max_active_secrets: 100,
          secret_passphrase_enabled: true,
          analytics_history_days: null,
        },
        usage: { links: 12, secrets: 11, domains: 3 },
        rate_limit: {
          limit_per_hour: 1000,
          remaining: 998,
          reset_at: "2026-09-29T16:34:02.000Z",
        },
      },
    }));
    const text = (await call("whoami", {})).text;
    expect(text).toContain("Acme Inc");
    expect(text).toContain("Pro");
    expect(text).toContain("unlimited"); // max_links null must not print "null"
    expect(text).toContain("998 of 1000");
    expect(text).not.toContain("null");
  });
});

describe("errors tell the assistant what to do next", () => {
  it("does not invite a retry of a plan limit", async () => {
    const { call } = await harness(() => ({
      status: 402,
      body: {
        error: {
          code: "plan_limit",
          message: "Too many active secrets.",
          upgrade_url: "https://uselinkpilot.com/pricing",
        },
      },
    }));
    const res = await call("create_secret_link", { secret: "x" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/will fail the same way/i);
    expect(res.text).toContain("https://uselinkpilot.com/pricing");
  });

  it("passes on Retry-After rather than an unbounded 'try again'", async () => {
    const { call } = await harness(() => ({
      status: 429,
      body: { error: { code: "rate_limited", message: "Slow down." } },
      headers: { "Retry-After": "42" },
    }));
    expect((await call("whoami", {})).text).toContain("42s");
  });

  it("distinguishes a switched-off API from a broken one", async () => {
    const { call } = await harness(() => ({
      status: 503,
      body: { error: { code: "disabled", message: "Off." } },
    }));
    expect((await call("whoami", {})).text).toMatch(/will not help/i);
  });

  it("points an auth failure at the key, not at a retry", async () => {
    const { call } = await harness(() => ({
      status: 401,
      body: { error: { code: "unauthorized", message: "Bad key." } },
    }));
    const text = (await call("whoami", {})).text;
    expect(text).toContain("LINKPILOT_API_KEY");
    expect(text).toMatch(/do not retry/i);
  });

  it("does not paste an HTML error page into the result", async () => {
    const { call } = await harness(() => ({
      status: 502,
      body: "<html>502 Bad Gateway</html>",
      headers: { "Content-Type": "text/html" },
    }));
    const text = (await call("whoami", {})).text;
    expect(text).not.toContain("<html>");
    expect(text).toContain("502");
  });

  it("never leaks the API key into an error result", async () => {
    const { call } = await harness(() => ({
      status: 401,
      body: { error: { code: "unauthorized", message: "Bad key." } },
    }));
    expect((await call("whoami", {})).text).not.toContain(KEY);
  });

  it("describes a non-Error throw without producing [object Object]", () => {
    // An assistant handed "[object Object]" has nothing to report to anyone.
    expect(describeError({ weird: true })).not.toContain("[object Object]");
    expect(describeError({ weird: true })).toContain("weird");
  });
});
