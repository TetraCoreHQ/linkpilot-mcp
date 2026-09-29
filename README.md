# LinkPilot MCP server

Give an AI assistant a safe way to hand someone a credential.

[LinkPilot](https://uselinkpilot.com) secret links open **once** and then
destroy themselves, and the text is encrypted before it leaves this process.
This is an [MCP](https://modelcontextprotocol.io) server that exposes them as
tools, alongside short links.

```
npx -y @uselinkpilot/mcp
```

## The problem it solves

Assistants hand people credentials constantly: a generated password, an API
key, a database connection string. Every ordinary way of delivering one is
bad. Pasted into chat, it lives in the history. Emailed, it lives forever.
Dropped in a ticket, it is indexed.

`create_secret_link` returns a URL that works exactly once:

> Here is the database password: https://shrd.link/s/p8mcaiitig#k=0hoNIO96aDJFoLsxaYPsP3_FeqUjb6t_w5lnSTcxkO0
>
> It opens once and then it is gone.

## Read this before you install it

**The plaintext passes through the assistant's context.** For the model to
create the secret, it has to see the secret.

This server protects the credential *in transit*, *at rest*, and *over time* —
it is encrypted before it is sent, LinkPilot cannot read it, and it survives a
single view. It does **not** hide the value from the model that is calling the
tool, and nothing built this way could.

So: use it to deliver a credential the assistant is already handling — one it
just generated, or one you have pasted in deliberately. If a secret must never
be seen by the assistant at all, create it yourself at
[uselinkpilot.com](https://uselinkpilot.com) or with the
[`linkpilot` CLI](https://www.npmjs.com/package/linkpilot) instead.

A security tool that oversells itself is worse than no tool, so that is stated
up front rather than in a footnote.

## What the encryption actually means

The API **will not accept a plaintext secret.** `POST /secrets` takes
ciphertext and an `enc_version`, and rejects a `payload` field outright.

Encryption happens in this process, via
[`@uselinkpilot/sdk`](https://www.npmjs.com/package/@uselinkpilot/sdk):
AES-GCM-256, with the key generated locally. The key travels in the URL's `#`
fragment, which browsers never send to a server. LinkPilot stores a blob it
holds no key for, and so cannot read it — nor can anyone who reaches its
database or its edge.

The corollary is not a caveat, it is the guarantee working: **there is no
recovery.** Lose the share URL and the secret is gone, including to us.

## Setup

Create an API key at
[uselinkpilot.com/app/api-keys](https://uselinkpilot.com/app/api-keys). Keys
begin with `lp_live_`. API access is available on every plan, including Free.

### Claude Code

```bash
claude mcp add linkpilot --env LINKPILOT_API_KEY=lp_live_your_key -- npx -y @uselinkpilot/mcp
```

### Claude Desktop, and other MCP clients

In `claude_desktop_config.json` (or your client's equivalent):

```json
{
  "mcpServers": {
    "linkpilot": {
      "command": "npx",
      "args": ["-y", "@uselinkpilot/mcp"],
      "env": { "LINKPILOT_API_KEY": "lp_live_your_key" }
    }
  }
}
```

The key is read from the environment only. It is never written to disk by this
server, and never echoed — not in a log line, not in an error, not truncated.

## Tools

| tool | what it does |
|---|---|
| `create_secret_link` | Encrypt text locally and return a one-time URL |
| `create_short_link` | Shorten a URL, with click tracking |
| `list_links` | List short links and their click counts |
| `list_secrets` | Secret **metadata** only: status, views, expiry |
| `revoke_secret` | Destroy a secret link immediately |
| `whoami` | Plan, limits, usage and remaining rate budget |

`list_secrets` cannot return a secret's contents. No API route can — there is
no route that returns a payload or a key, which is what makes the guarantee
above structural rather than a promise.

`revoke_secret` is annotated `destructiveHint`, so a well-behaved client will
confirm before calling it. The three read-only tools are annotated as such, so
it will not nag about those.

### `create_secret_link`

| argument | |
|---|---|
| `secret` | The text to protect. Required. |
| `expires_in` | `"30m"`, `"2h"`, `"7d"`, or seconds. Optional. |
| `burn_after_read` | Default true. |
| `passphrase` | Pro plans. A second factor the recipient must type. |

A passphrase is mixed into the key *and* sent as a SHA-256 hash, so the server
can refuse to hand over the ciphertext at all. The passphrase itself is never
transmitted. Send it over a different channel from the link, or it adds
nothing.

## Verifying the encryption

You do not have to take any of this on trust.

The wire format is specified at
[uselinkpilot.com/developers](https://uselinkpilot.com/developers), and the
SDK's test suite runs the **same committed known-answer vectors** as the
LinkPilot web application and the reveal page served at the edge. Three
independent implementations, one set of vectors. If any of them disagreed
about a single byte, those tests would fail.

This server's own tests assert the negative directly: for every secret path,
the plaintext and the key must not appear anywhere in the request, and the key
taken from the returned share URL must decrypt exactly what was sent.

## Development

```bash
npm ci
npm run build
npm run typecheck
npm test
```

Tests run a real MCP `Client` against a real server over an in-memory
transport, with only the network stubbed, so the input schemas and the result
envelope are exercised the way a real host exercises them.

## Licence

MIT
