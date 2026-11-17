// Watchdog decisions, in --dry-run (nothing is killed or started). Claude Code's process registry is faked:
// an entry for this test process stands for a live claude.exe.
import fs from "node:fs";
import path from "node:path";
import { setup, ok, finish, now } from "./helpers.mjs";

const t = setup("watchdog");
const LIVE = "live-session-0001";
const sessions = path.join(t.ap, "sessions");
const clear = () => { for (const f of fs.readdirSync(sessions)) fs.rmSync(path.join(sessions, f)); };
const setUsage = (used) => fs.writeFileSync(path.join(t.ap, "usage.json"), JSON.stringify({ five_hour: { used, resets_at: now() + 7200 }, seven_day: { used: 20, resets_at: now() + 86400 * 3 } }));
const registry = (status, quietSec = 0) => fs.writeFileSync(path.join(t.claudeDir, "sessions", `${process.pid}.json`), JSON.stringify({
  pid: process.pid, sessionId: LIVE, status, entrypoint: "cli", updatedAt: (now() - quietSec) * 1000, statusUpdatedAt: (now() - quietSec) * 1000,
}));
const wd = () => { const before = t.log().length; t.run("watchdog.mjs", ["--dry-run"]); return t.log().slice(before); };

try {
  setUsage(30);
  t.putState("dead-running", {});
  let out = wd();
  ok(/relaunch dead-running: process is gone/.test(out), "dead process, running, limits ok -> relaunch");

  clear(); setUsage(93);
  t.putState("dead-paused", { phase: "paused", resumeAt: now() + 3600 });
  ok(wd() === "", "dead process, paused, limits over -> wait");

  setUsage(5);
  t.putState("dead-paused", { phase: "paused", resumeAt: now() - 60 });
  ok(/relaunch dead-paused/.test(wd()), "dead process, pause over, limits ok -> relaunch");

  clear(); registry("idle");
  t.putState(LIVE, { phase: "paused", resumeAt: now() - 600, sleeper: null });
  ok(/relaunch live-session-0001: no in-process resume/.test(wd()), "live process, paused, no sleeper, reset long past -> relaunch");

  t.putState(LIVE, { phase: "paused", resumeAt: now() - 600, sleeper: { pid: process.pid, hb: now() } });
  ok(wd() === "", "live process, paused, fresh sleeper -> leave it alone");

  registry("busy");
  t.putState(LIVE, { phase: "running", lastStatusAt: now() });
  ok(wd() === "", "live process, running, busy -> nothing");

  registry("idle", 1800);
  t.putState(LIVE, { phase: "running", lastStatusAt: now() - 1800 });
  ok(/relaunch live-session-0001: session idle/.test(wd()), "live process idle for 30 min with open work -> relaunch");

  registry("waiting", 1800);
  t.putState(LIVE, { phase: "running", lastStatusAt: now() - 1800 });
  out = wd();
  ok(/NOTIFY Autopilot is waiting for you/.test(out) && !/relaunch/.test(out), "live process waiting (question, dialog) -> notify, no relaunch");

  clear();
  t.putState("dead-relaunched", { lastRelaunchAt: now() - 60 });
  ok(wd() === "", "recently relaunched -> wait");

  const windowKey = JSON.parse(fs.readFileSync(path.join(t.ap, "usage.json"), "utf8")).five_hour.resets_at;
  t.putState("dead-limit", { relaunch: { window: windowKey, count: 3 } });
  out = wd();
  ok(/NOTIFY Autopilot needs you/.test(out) && !/relaunch dead-limit/.test(out), "relaunch limit reached -> notify instead of relaunch");

  clear();
  t.putState("finished", { phase: "done" });
  ok(wd() === "", "finished sessions are ignored");
} finally {
  t.cleanup();
}
finish();
