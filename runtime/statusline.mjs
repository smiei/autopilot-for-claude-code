// Autopilot for Claude Code - status line. Claude Code pipes its session JSON to stdin after every
// assistant message; this is the only token-free source of rate_limits. Always exits 0.
// If the user had a status line of their own, the installer stored it in config.chainStatusLine:
// it is run with the same input and the autopilot segment is appended to its output.
import fs from "node:fs";
import { spawnSync } from "node:child_process";

let raw = "";
let j = {};
try { raw = fs.readFileSync(0, "utf8"); j = JSON.parse(raw); } catch {}

let line = "";
try {
  const lib = await import("./lib.mjs");
  const sid = j.session_id;
  const rl = j.rate_limits;
  if (rl) lib.mergeUsage(rl, sid);
  lib.markSeen(sid, j.workspace?.current_dir || j.cwd);

  const cfg = lib.loadConfig();
  const u = lib.effectiveUsage(cfg);
  let ap = "";
  const st = sid ? lib.loadState(sid) : null;
  if (st && st.active) {
    const pc = j.prompt_cache;
    const fivePct = rl?.five_hour?.used_percentage;
    const apiMs = j.cost?.total_api_duration_ms;
    lib.updateState(sid, (s) => {
      if (pc && pc.warm && typeof pc.expires_at === "number") s.cacheExpiresAt = pc.expires_at;
      s.lastStatusAt = lib.now();
      // Ping cost = how far the 5h percentage moved across the keep-alive turn (includes any other use; conservative).
      // Only measured once the API time has grown, i.e. the ping's own response has arrived.
      const newCall = typeof apiMs === "number" && (s.lastPing?.apiMsBefore == null || apiMs > s.lastPing.apiMsBefore);
      const sameWindow = s.lastPing && !s.lastPing.simulated && (s.lastPing.resetsAt == null || Math.abs((rl?.five_hour?.resets_at ?? 0) - s.lastPing.resetsAt) <= 60);
      if (s.lastPing && !s.lastPing.measured && newCall && sameWindow && typeof fivePct === "number" && lib.now() - s.lastPing.at < 900) {
        s.pingCost = Math.min(10, Math.max(0.05, fivePct - s.lastPing.usedBefore));
        s.lastPing.measured = true;
        lib.log(`ping cost measured for ${sid}: ${s.pingCost.toFixed(2)} %`);
      }
      if (typeof apiMs === "number") s.lastApiMs = apiMs;
      // The watchdog relaunches with this model: the CLI's own default can change under us.
      if (j.model?.id) s.model = j.model.id;
    });
    const { open, done } = lib.countOpenItems(st.taskDir);
    const ph = { running: "running", paused: `paused until ${lib.fmtTime(st.resumeAt)}`, hard_stopped: `limit, resumes ${lib.fmtTime(st.resumeAt)}`, held: "held", needs_attention: "needs you", done: "done", off: "off" }[st.phase] || st.phase;
    ap = ` · AP ${ph}${open >= 0 ? ` (${done}/${open + done})` : ""}`;
  }
  const sim = u.five_hour.simulated ? " · SIM" : "";
  const chained = cfg.chainStatusLine?.command ? runChained(cfg.chainStatusLine.command, raw) : null;
  if (chained) {
    line = `${chained.replace(/\s+$/, "")}${ap}${sim}`;
  } else {
    const f = u.five_hour, w = u.seven_day;
    const five = f.known ? `5h ${Math.round(f.used)}% ↻${lib.fmtTime(f.resets_at)}` : "5h –";
    const week = w.known ? ` · 7d ${Math.round(w.used)}%` : "";
    const ctx = typeof j.context_window?.used_percentage === "number" ? ` · ctx ${Math.round(j.context_window.used_percentage)}%` : "";
    const model = j.model?.display_name ? `${j.model.display_name} · ` : "";
    line = `${model}${five}${week}${ctx}${ap}${sim}`;
  }
} catch (e) {
  line = `statusline error: ${e.message}`;
}
process.stdout.write(line);
process.exit(0);

// Claude Code on Windows runs status line commands in Git Bash, so the chained one runs there too.
function runChained(command, input) {
  const candidates = [process.env.CLAUDE_CODE_GIT_BASH_PATH, "C:/Program Files/Git/bin/bash.exe", "C:/Program Files (x86)/Git/bin/bash.exe"];
  const bash = candidates.find((p) => p && fs.existsSync(p));
  const opts = { input, encoding: "utf8", timeout: 3000, windowsHide: true };
  const r = bash ? spawnSync(bash, ["-c", command], opts) : spawnSync(command, { ...opts, shell: true });
  const text = (r.stdout || "").replace(/\s+$/, "");
  return text || null;
}
