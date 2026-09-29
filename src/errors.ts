/**
 * Turning a LinkPilot API failure into something a model can act on.
 *
 * An MCP tool result is read by an assistant, not a person, and the useful
 * question is almost always "what should I do now": try again, tell the user
 * to upgrade, or stop. A bare status code answers none of those, so the
 * SDK's typed error is translated into an instruction.
 */
import { LinkPilotApiError } from "@uselinkpilot/sdk";

export function describeError(err: unknown): string {
  if (err instanceof LinkPilotApiError) {
    const lines = [`LinkPilot API error (${err.code}, HTTP ${err.status}): ${err.message}`];

    if (err.code === "unauthorized") {
      lines.push(
        "The API key is missing, malformed or revoked. Keys start with `lp_live_` " +
          "and are created at https://uselinkpilot.com/app/api-keys, then set as " +
          "the LINKPILOT_API_KEY environment variable of this MCP server. " +
          "Ask the user to check it; do not retry.",
      );
    } else if (err.needsUpgrade) {
      lines.push(
        "This is a plan limit, not a bad request. Retrying the same call will " +
          "fail the same way." +
          (err.upgradeUrl ? ` Upgrade: ${err.upgradeUrl}` : ""),
      );
    } else if (err.code === "rate_limited") {
      lines.push(
        err.retryAfterSeconds !== undefined
          ? `Rate limited. Wait ${err.retryAfterSeconds}s before trying again.`
          : "Rate limited. Wait before trying again.",
      );
    } else if (err.isDisabled) {
      lines.push(
        "The LinkPilot API is deployed but switched off. Retrying will not help " +
          "until it is enabled; tell the user rather than looping.",
      );
    } else if (err.isRetryable) {
      lines.push("Transient server fault. Retrying once is reasonable.");
    } else {
      lines.push("Fix the request; retrying it unchanged will not help.");
    }
    return lines.join(" ");
  }

  if (err instanceof Error) return `${err.name}: ${err.message}`;

  // Never let an unexpected object stringify to "[object Object]". An
  // assistant handed that has nothing to report to anyone, and the one
  // moment it happens is the moment something unforeseen went wrong.
  try {
    const json = JSON.stringify(err);
    if (json !== undefined && json !== "{}") return `Unexpected failure: ${json}`;
  } catch {
    // Circular or otherwise unserialisable; fall through.
  }
  return `Unexpected failure of type ${typeof err}: ${Object.prototype.toString.call(err)}`;
}
