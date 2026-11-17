// StopFailure handling: errors a retry cannot fix stop at once, rate limits pause, other text does not fool it.
import { setup, ok, finish, now } from "./helpers.mjs";
import fs from "node:fs";
import path from "node:path";

const t = setup("stopfailure");
const SID = "test-sf-2222";
const hook = (args, input) => t.run("hook.mjs", args, { session_id: SID, cwd: t.repo, hook_event_name: "StopFailure", ...input }, { timeout: 20000 });
fs.writeFileSync(path.join(t.ap, "usage.json"), JSON.stringify({ five_hour: { used: 40, resets_at: now() + 7200 }, seven_day: { used: 20, resets_at: now() + 86400 * 3 } }));

try {
  t.putState(SID, {});
  const t0 = Date.now();
  let r = hook(["stop-failure"], { error: "model_not_found", last_assistant_message: "There's an issue with the selected model" });
  ok(r.status === 0 && Date.now() - t0 < 5000, "a permanent error returns at once");
  ok(t.state(SID).phase === "needs_attention" && /model_not_found/.test(t.state(SID).attentionReason), "model_not_found -> needs_attention");

  t.putState(SID, {});
  hook(["stop-failure", "sync"], { error: "rate_limit", last_assistant_message: "You've hit your limit" });
  ok(t.state(SID).phase === "hard_stopped", "rate_limit -> hard_stopped");

  t.putState(SID, {});
  hook(["stop-failure", "sync"], { error: "server_error", last_assistant_message: "mentions rate_limit in passing" });
  ok(t.state(SID).phase === "running", "a server_error whose text mentions rate_limit is no rate limit");
} finally {
  t.cleanup();
}
finish();
