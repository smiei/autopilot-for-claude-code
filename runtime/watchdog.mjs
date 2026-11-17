// Autopilot for Claude Code - watchdog. Runs every 10 minutes from Windows Task Scheduler (and at logon).
// No tokens: it only reads state files and, when the in-process path failed, restarts the session
// with `claude --resume <id>` in a new Windows Terminal window.  --dry-run logs what it would do.
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import * as lib from "./lib.mjs";

const cfg = lib.loadConfig();
const t = lib.now();
const dry = process.argv.includes("--dry-run");
lib.writeJson(path.join(lib.AP_HOME, "watchdog.json"), { lastRun: t });

for (const st of lib.listStates()) {
  if (!st.active || !lib.ACTIVE_PHASES.includes(st.phase)) continue;
  try { check(st); } catch (e) { lib.log(`watchdog ERROR for ${st.sid}: ${e.stack || e.message}`); }
}

function check(st) {
  const proc = lib.findClaudeProcess(st.sid);
  const ls = lib.limitStatus(cfg);
  const limitsOk = !ls.over;
  const pauseOver = t >= (st.resumeAt || 0);
  const sleeperFresh = st.sleeper && lib.pidAlive(st.sleeper.pid) && t - (st.sleeper.hb || 0) < 180;
  const recentlyRelaunched = st.lastRelaunchAt && t - st.lastRelaunchAt < 15 * 60;
  if (recentlyRelaunched) return;

  if (!proc) {
    // Still unregistered 15 min after a relaunch: the window waits on a startup dialog. Another relaunch
    // would only open a second stuck window.
    const starting = lib.findUnregisteredProcess(st.sid, path.basename(cfg.claudeExe));
    if (starting) {
      if (!st.startupStuckNotifiedAt || t - st.startupStuckNotifiedAt > 3600) {
        lib.updateState(st.sid, (s) => { s.startupStuckNotifiedAt = t; });
        lib.log(`WATCHDOG ${st.sid}: PID ${starting} is stuck while starting (dialog?)`);
        lib.notify(cfg, "Autopilot is waiting for you", "The restart waits on a dialog while starting (e.g. a new MCP server). Please look at the \"Claude Autopilot\" window.");
      }
      return;
    }
    // Crash, closed terminal, reboot: restart as soon as work is allowed again.
    if (st.phase === "running" ? limitsOk : limitsOk && pauseOver) return relaunch(st, null, "process is gone");
    return;
  }

  if (st.phase === "paused" || st.phase === "hard_stopped") {
    // In-process resume should have happened by now; if no sleeper is alive, do it from outside.
    if (!sleeperFresh && limitsOk && t > (st.resumeAt || 0) + 300) return relaunch(st, proc, `no in-process resume (${st.phase}, no sleeper)`);
    return;
  }

  // phase === "running": detect a session that silently stopped working.
  const status = String(proc.status || "");
  const since = (proc.statusUpdatedAt || proc.updatedAt || 0) / 1000;
  const quietFor = t - Math.max(since, st.lastStatusAt || 0);
  if (status === "busy" || quietFor < cfg.stallMinutes * 60) return;
  if (status === "idle") return relaunch(st, proc, `session idle for ${Math.round(quietFor / 60)} min although work is open`);
  // Anything else (waiting for a permission answer, a dialog, ...) needs the user.
  if (!st.stallNotifiedAt || t - st.stallNotifiedAt > 3600) {
    lib.updateState(st.sid, (s) => { s.stallNotifiedAt = t; });
    lib.notify(cfg, "Autopilot is waiting for you", `Status "${status}" for ${Math.round(quietFor / 60)} min (e.g. a permission question). Please look at the session.`);
  }
}

function relaunch(st, proc, why) {
  const windowKey = lib.effectiveUsage(cfg).five_hour.resets_at || 0;
  const rl = st.relaunch && st.relaunch.window === windowKey ? st.relaunch : { window: windowKey, count: 0 };
  if (rl.count >= cfg.maxRelaunchesPerWindow) {
    if (!st.relaunchLimitNotified) {
      lib.updateState(st.sid, (s) => { s.relaunchLimitNotified = true; });
      lib.notify(cfg, "Autopilot needs you", `${rl.count} restarts in this window without success (${why}).`);
    }
    return;
  }
  lib.log(`WATCHDOG relaunch ${st.sid}: ${why}${dry ? " [dry-run]" : ""}`);
  if (dry) return;
  if (proc) spawnSync("taskkill.exe", ["/PID", String(proc.pid), "/T", "/F"], { windowsHide: true });
  const prompt = lib.MSG.relaunch(st).replaceAll(";", ","); // wt.exe splits its command line at ";"
  // A watchdog started from inside a Claude session (tests) would hand down its CLAUDE_* markers:
  // CLAUDE_CODE_CHILD_SESSION turns transcript saving off, CLAUDE_CODE_ENTRYPOINT names the parent.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|AUTOPILOT_)/i.test(k) || k === "CLAUDE_CONFIG_DIR"));
  const model = cfg.model || st.model;
  // Remote Control keeps the relaunched session reachable from the phone (questions, pushes).
  // Its name is an optional value, so it must be given, or the prompt would be taken as the name.
  const rc = cfg.remoteControl ? ["--remote-control", `autopilot-${path.basename(st.taskDir)}`.replace(/[^\w.-]/g, "-")] : [];
  const args = ["-w", "new", "--title", "Claude Autopilot", "-d", st.cwd, cfg.claudeExe, "--resume", st.sid, "--permission-mode", cfg.permissionMode, ...(model ? ["--model", model] : []), ...rc, prompt];
  const child = spawn("wt.exe", args, { detached: true, stdio: "ignore", windowsHide: false, env });
  child.unref();
  lib.updateState(st.sid, (s) => {
    s.relaunch = { window: windowKey, count: rl.count + 1 };
    s.relaunchLimitNotified = false;
    s.lastRelaunchAt = t;
    s.sleeper = null;
  });
  lib.notify(cfg, "Autopilot restarted", `${path.basename(st.taskDir)}: ${why}.`);
}
