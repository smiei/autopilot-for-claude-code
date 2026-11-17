// End-to-end logic of one autopilot session, driven through the real scripts (about 2 minutes:
// the sleeper really waits for the simulated keep-alive and reset).
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { setup, ok, finish, now, sleep } from "./helpers.mjs";

const t = setup("core");
const SID = "test-0000-1111";
const hook = (ev, extra = {}) => t.run("hook.mjs", [ev], { session_id: SID, cwd: t.repo, hook_event_name: ev, ...extra });
const status = (used, resetsIn) => t.run("statusline.mjs", [], {
  session_id: SID, cwd: t.repo, model: { display_name: "Test", id: "claude-test" }, context_window: { used_percentage: 12 },
  cost: { total_api_duration_ms: Date.now() },
  rate_limits: { five_hour: { used_percentage: used, resets_at: now() + resetsIn }, seven_day: { used_percentage: 20, resets_at: now() + 86400 * 3 } },
  prompt_cache: { warm: true, ttl: "1h", expires_at: now() + 3600 },
});
const usage = () => JSON.parse(fs.readFileSync(path.join(t.ap, "usage.json"), "utf8"));

try {
  // a. status line and usage merge
  let r = status(50, 600);
  ok(r.status === 0 && /5h 50%/.test(r.stdout), `status line prints usage: "${r.stdout}"`);
  ok(usage().five_hour.used === 50, "usage.json written");
  status(40, 600);
  ok(usage().five_hour.used === 50, "a lower value in the same window is ignored");

  // b. start
  r = t.run("autopilot.mjs", ["start", t.task, "--sid", SID]);
  ok(r.status === 0 && t.state(SID).phase === "running", `autopilot start -> running ${r.status ? r.stderr : ""}`);
  ok(/^\/\.claude\/autopilot\/demo\/$/m.test(fs.readFileSync(path.join(t.repo, ".git", "info", "exclude"), "utf8")), "task folder excluded from git");
  ok(/NOTE/.test(r.stdout) && /inputNeededNotifEnabled/.test(r.stdout), "start warns about missing push settings");
  status(50, 600);
  ok(t.state(SID).model === "claude-test", "the session's model is remembered for relaunches");

  // c. under the limit nothing happens; session start injects the protocol; stop with open items blocks
  r = hook("pre-tool", { tool_name: "Bash" });
  ok(r.status === 0 && r.stdout === "", "pre-tool under the limit: no output");
  r = hook("session-start", { source: "compact" });
  ok(/Autopilot work protocol/.test(r.stdout) && /additionalContext/.test(r.stdout) && !/\{\{/.test(r.stdout), "session start injects the filled-in protocol");
  r = hook("stop", { stop_hook_active: false });
  ok(/"decision":"block"/.test(r.stdout), "stop with open items -> block");

  // d. over the limit -> pause, checkpoint, plain deny
  status(91, 600);
  const headBefore = t.git("rev-parse", "HEAD"), statusBefore = t.git("status", "--porcelain");
  const TR = path.join(t.root, "transcript.jsonl");
  fs.writeFileSync(TR, [
    { type: "assistant", message: { id: "msg_A", content: [{ type: "tool_use", id: "tu_1" }] } },
    { type: "assistant", message: { id: "msg_A", content: [{ type: "tool_use", id: "tu_2" }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_1" }] } },
    { type: "assistant", message: { id: "msg_B", content: [{ type: "tool_use", id: "tu_3" }] } },
  ].map((e) => JSON.stringify(e)).join("\n") + "\n");
  r = hook("pre-tool", { tool_name: "Bash", transcript_path: TR, tool_use_id: "tu_1" });
  let o = JSON.parse(r.stdout || "{}");
  ok(o.hookSpecificOutput?.permissionDecision === "deny" && o.continue === undefined, "first deny without brake");
  ok(/AUTOPILOT PAUSE/.test(o.hookSpecificOutput?.permissionDecisionReason || ""), "deny reason starts with AUTOPILOT PAUSE");
  ok(t.state(SID).phase === "paused", "phase paused");
  const refs = t.git("for-each-ref", "--format=%(refname)", "refs/autopilot/");
  ok(/refs\/autopilot\//.test(refs), "checkpoint ref exists");
  ok(t.git("rev-parse", "HEAD") === headBefore && t.git("status", "--porcelain") === statusBefore, "HEAD, index and working tree unchanged");
  const snap = t.git("for-each-ref", "--format=%(objectname)", "refs/autopilot/").split("\n").pop();
  ok(t.git("show", `${snap}:wip.txt`).includes("work in progress"), "the snapshot holds the untracked file");

  // e. parallel call of the same response -> plain deny; call from a NEW response -> hard brake
  r = hook("pre-tool", { tool_name: "Read", transcript_path: TR, tool_use_id: "tu_2" });
  o = JSON.parse(r.stdout || "{}");
  ok(o.continue === undefined && o.hookSpecificOutput?.permissionDecision === "deny", "parallel call of the same response: deny without brake");
  r = hook("pre-tool", { tool_name: "Read", transcript_path: TR, tool_use_id: "tu_3" });
  o = JSON.parse(r.stdout || "{}");
  ok(o.continue === false && o.hookSpecificOutput?.permissionDecision === "deny", "call from a new response despite the pause: continue:false");

  // f. sync stop while paused -> allowed
  r = hook("stop", {});
  ok(r.stdout === "", "stop while paused: allowed");

  // g. sleeper: simulated window resets in 60 s, cache TTL 1 min with 0.5 min lead -> one ping first
  t.run("autopilot.mjs", ["simulate", "91", "1.0", "--ttl", "1", "--lead", "0.5", "--after", "3"]);
  let t0 = Date.now();
  r = hook("stop-async", {});
  let secs = (Date.now() - t0) / 1000;
  ok(r.status === 2 && /AUTOPILOT KEEPALIVE/.test(r.stderr), `sleeper #1 -> KEEPALIVE after ${secs.toFixed(0)} s`);
  ok(secs > 25 && secs < 45, "keep-alive timing ~30 s (cache TTL 1 min minus 0.5 min lead)");
  status(91.4, 600);
  ok(t.state(SID).lastPing && t.state(SID).pingCost === undefined, "a simulated ping is recorded, its cost not measured");

  // h. second sleeper -> resume once the simulated window has reset (+5 s grace)
  t0 = Date.now();
  r = hook("stop-async", {});
  secs = (Date.now() - t0) / 1000;
  ok(r.status === 2 && /AUTOPILOT RESUME/.test(r.stderr), `sleeper #2 -> RESUME after ${secs.toFixed(0)} s`);
  ok(t.state(SID).phase === "running", "phase running after resume");
  t.run("autopilot.mjs", ["simulate", "off"]);

  // i. only one sleeper at a time; "hold" makes it leave quietly
  status(92, 30000);
  hook("pre-tool", { tool_name: "Bash" });
  const bg = spawn(process.execPath, [path.join(t.ap, "hook.mjs"), "stop-async"], { cwd: t.repo, env: t.env, stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
  bg.stdin.end(JSON.stringify({ session_id: SID, cwd: t.repo }));
  await sleep(4000);
  t0 = Date.now();
  r = hook("stop-async", {});
  ok(r.status === 0 && Date.now() - t0 < 4000, "a second sleeper leaves at once");
  t.run("autopilot.mjs", ["--sid", SID, "hold"]);
  await sleep(32000);
  ok(bg.exitCode === 0, `the sleeper leaves quietly after "hold" (exit ${bg.exitCode})`);
  t.run("autopilot.mjs", ["--sid", SID, "resume"]);
  status(10, 40000); // a later window

  // j. three stops without progress -> needs_attention
  for (let i = 0; i < 3; i++) hook("stop", {});
  ok(t.state(SID).phase === "needs_attention", `three stops without progress -> needs_attention (${t.state(SID).phase})`);
  t.run("autopilot.mjs", ["--sid", SID, "resume"]);

  // k. real ping cost measurement: a non-simulated ping in the current window, then a status update after it
  {
    const s = t.state(SID);
    const u = usage();
    s.lastPing = { at: now() - 10, usedBefore: 10, resetsAt: u.five_hour.resets_at, simulated: false, apiMsBefore: 1 };
    fs.writeFileSync(path.join(t.ap, "sessions", `${SID}.json`), JSON.stringify(s));
    t.run("statusline.mjs", [], { session_id: SID, cost: { total_api_duration_ms: 5 }, rate_limits: { five_hour: { used_percentage: 10.6, resets_at: u.five_hour.resets_at } } });
    ok(Math.abs((t.state(SID).pingCost ?? 0) - 0.6) < 0.01, `real ping cost measured: ${t.state(SID).pingCost?.toFixed(2)}`);
  }

  // l. everything ticked -> done
  fs.writeFileSync(path.join(t.task, "PLAN.md"), "# Demo\n- [x] 1.1 one\n- [x] 1.2 two\n");
  r = hook("stop", {});
  ok(r.stdout === "" && t.state(SID).phase === "done", `all ticked -> done (${t.state(SID).phase})`);

  // m. sessions without a state file are left alone
  r = t.run("hook.mjs", ["pre-tool"], { session_id: "someone-else", tool_name: "Bash" });
  ok(r.status === 0 && r.stdout === "", "other sessions: no output");
} finally {
  t.cleanup();
}
finish();
