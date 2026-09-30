/**
 * The registry proves ownership by comparing two files that live in
 * different places, so they can drift silently and the next publish just
 * fails validation.
 *
 * package.json's mcpName is read from the PUBLISHED npm package; server.json
 * is read from this repo. If they stop matching, the registry refuses the
 * server rather than listing something it cannot verify.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const read = (f: string) => JSON.parse(readFileSync(path.join(ROOT, f), "utf8"));

describe("official MCP registry metadata", () => {
  const pkg = read("package.json");
  const server = read("server.json");

  it("mcpName equals the registry server name", () => {
    expect(pkg.mcpName).toBe(server.name);
  });

  it("uses the GitHub org namespace we can actually prove via OIDC", () => {
    // Publishing under io.github.<org>/* requires an OIDC token from a repo
    // in that org; any other prefix would be refused.
    expect(server.name).toMatch(/^io\.github\.TetraCoreHQ\//);
  });

  it("the npm package it points at is this package, at this version", () => {
    const p = server.packages[0];
    expect(p.registryType).toBe("npm");
    expect(p.registryBaseUrl).toBe("https://registry.npmjs.org");
    expect(p.identifier).toBe(pkg.name);
    expect(p.version).toBe(pkg.version);
    expect(server.version).toBe(pkg.version);
  });

  it("declares the one environment variable the server cannot start without", () => {
    const env = server.packages[0].environmentVariables;
    expect(env).toHaveLength(1);
    expect(env[0].name).toBe("LINKPILOT_API_KEY");
    expect(env[0].isRequired).toBe(true);
    // Marked secret so clients mask it rather than echoing it into a log.
    expect(env[0].isSecret).toBe(true);
  });

  it("is a stdio server, which is what the config in the README describes", () => {
    expect(server.packages[0].transport.type).toBe("stdio");
  });
});
