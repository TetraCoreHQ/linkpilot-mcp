# Directory listings

Where `@uselinkpilot/mcp` is listed, and what each one needs. An MCP server
published to npm but absent from the directories is a product with no shop
window: the directories are where people browse, and each is also a link
from a high-authority domain.

## Done in this repo

| directory | mechanism | file |
|---|---|---|
| [Smithery](https://smithery.ai) | scans the repo for `smithery.yaml` | `smithery.yaml` |
| [Glama](https://glama.ai/mcp/servers) | indexes public GitHub repos automatically; `glama.json` claims ownership | `glama.json` |

Glama already indexes every public MCP repo it can find, so the listing
appears without asking. `glama.json` is what lets us edit the name and
description, set an icon, and see usage reports.

**`maintainers` takes PERSONAL GitHub usernames, never an organisation
name**, including for a repo owned by an org. Glama's own instructions say
`"your-github-username"`, and the claim matches the logged-in user against
that list. `TetraCoreHQ` was tried first and cannot work: no one can log in
as an organisation, so the claim button simply does nothing.

## Still to do, because each needs an account or an auth token

### 1. Official MCP registry — highest value

`registry.modelcontextprotocol.org` is the canonical index, and the one most
clients read. It verifies that the publisher actually controls the npm
package, which we do.

It needs a `server.json` plus the `mcp-publisher` CLI authenticated as
GitHub, so it cannot be done from a script without the owner's login:

```bash
npm i -g @modelcontextprotocol/publisher   # check the current package name in the docs
mcp-publisher login github
mcp-publisher publish
```

The namespace will be `io.github.TetraCoreHQ/linkpilot-mcp`, proven by the
GitHub login. Before writing `server.json`, read the current publishing
guide: the schema has moved more than once, and a guessed file fails
validation rather than publishing something wrong.

### 2. awesome-mcp-servers

`punkpeye/awesome-mcp-servers` is the most-read list in the ecosystem and a
strong link. It takes a pull request adding one line under the right
category. Suggested entry:

```markdown
- [uselinkpilot/mcp](https://github.com/TetraCoreHQ/linkpilot-mcp) - Share passwords and API keys as one-time links that self-destruct. Encrypted client-side; the service stores ciphertext it cannot read.
```

### 3. mcp.so

A web form at [mcp.so/submit](https://mcp.so/submit). Needs the GitHub repo
URL and a description; no repo file required.

## Copy to reuse

**One line:** Share a password, API key or token as a link that opens once
and then destroys itself. Encrypted in the client before it is sent.

**The caveat, which belongs in every listing:** the plaintext passes through
the assistant's context, because a model has to see a secret in order to
create one. This protects it in transit, at rest, and by making the link
open only once. It cannot hide it from the model. Saying so up front is the
difference between a security tool and a security claim.
