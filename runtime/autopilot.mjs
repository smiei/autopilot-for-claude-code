#!/usr/bin/env node
// Autopilot for Claude Code - control CLI.  node ~/.claude/autopilot/autopilot.mjs <command>
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as lib from "./lib.mjs";

const HELP = `Autopilot for Claude Code

Usage: node ${lib.AP_HOME.split(path.sep).join("/")}/autopilot.mjs <command> [--sid <session-id>]

  status                    every autopilot session: phase, progress, usage, process, next wake
  start <taskDir>           bind this Claude session to a task (run from inside the session)
  done                      (model) the task is finished
  block "<reason>"          (model) cannot continue without the user
  hold | resume | off       hold the autopilot, let it run again, switch it off
  resume-now                end a pause early (only resumes if the limits allow it)
  checkpoint                write a git snapshot ref now
  log [n]                   last n lines of the autopilot log
  simulate <used%> <resetsInMin> [--ttl <min>] [--lead <min>] [--after <used%>]
  simulate off              test the pause logic with simulated usage

Without --sid a command acts on the session it runs in ($AUTOPILOT_SESSION_ID).`;

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
const sidOpt = opt("--sid");
const cmd = args.shift() || "status";
const cfg = lib.loadConfig();
const die = (msg) => { console.error(msg); process.exit(1); };

function resolveSid({ requireActive = true } = {}) {
  if (sidOpt) return sidOpt;
  if (process.env.AUTOPILOT_SESSION_ID && lib.loadState(process.env.AUTOPILOT_SESSION_ID)) return process.env.AUTOPILOT_SESSION_ID;
  const own = lib.findOwnClaudeSession();
  if (own && lib.loadState(own.sessionId)) return own.sessionId;
  const cands = lib.listStates().filter((s) => !requireActive || s.active);
  if (cands.length === 1) return cands[0].sid;
  die(cands.length ? `Several autopilot sessions, pick one with --sid:\n${cands.map((s) => `  ${s.sid}  ${s.phase}  ${s.taskDir}`).join("\n")}` : "No autopilot session found.");
}

function describe(st) {
  const ls = lib.limitStatus(cfg);
  const { open, done } = lib.countOpenItems(st.taskDir);
  const proc = lib.findClaudeProcess(st.sid);
  const sleeperAlive = st.sleeper && lib.pidAlive(st.sleeper.pid);
  const u = ls.u;
  return [
    `Session   ${st.sid}${st.active ? "" : " (inactive)"}`,
    `Task      ${st.taskDir}  [${done}/${open + done} done]`,
    `Phase     ${st.phase}${st.attentionReason && st.phase === "needs_attention" ? ` - ${st.attentionReason}` : ""}${st.blockReason && st.phase === "needs_attention" ? ` - ${st.blockReason}` : ""}`,
    `Usage     5h ${u.five_hour.known ? `${u.five_hour.used.toFixed(1)} % (reset ${lib.fmtDateTime(u.five_hour.resets_at)})` : "unknown"} · 7d ${u.seven_day.known ? `${u.seven_day.used.toFixed(1)} %` : "unknown"}${u.five_hour.simulated ? "  [SIMULATION]" : ""}`,
    `Process   ${proc ? `claude PID ${proc.pid} (${proc.status || "?"})` : "not running"}`,
    ["paused", "hard_stopped"].includes(st.phase) ? `Pause     since ${lib.fmtDateTime(st.pausedAt)}, resume ${lib.fmtDateTime(st.resumeAt)}, next wake ${st.nextWakeKind || "?"} ${lib.fmtDateTime(st.nextWakeAt)}, sleeper ${sleeperAlive ? "alive" : "none"}, pings ${st.pingsThisPause || 0}${st.pingStopped ? " (stopped: budget)" : ""}, ping cost ${st.pingCost != null ? `${st.pingCost.toFixed(2)} %` : "not measured yet"}` : null,
    st.lastCheckpoint ? `Snapshot  ${st.lastCheckpoint.ref}` : null,
  ].filter(Boolean).join("\n");
}

switch (cmd) {
  case "help":
  case "--help":
  case "-h":
    console.log(HELP);
    break;

  case "start": {
    const dirArg = args[0] || die("Usage: autopilot start <task folder with PLAN.md and PROGRESS.md>");
    const taskDir = path.resolve(dirArg);
    for (const f of ["PLAN.md", "PROGRESS.md"]) if (!fs.existsSync(path.join(taskDir, f))) die(`${f} is missing in ${taskDir}`);
    const sid = sidOpt || process.env.AUTOPILOT_SESSION_ID || lib.findOwnClaudeSession()?.sessionId;
    if (!sid) die("Cannot determine the session id. Is this running inside a Claude Code session with the autopilot hooks installed?");
    const proc = lib.findClaudeProcess(sid);
    if (proc && /vscode|desktop|sdk/i.test(proc.entrypoint || "")) die(`This session runs in "${proc.entrypoint}". The autopilot needs the terminal CLI (only there does the status line receive the rate limits). Start "claude --remote-control <name> --permission-mode ${cfg.permissionMode}" in Windows Terminal instead.`);
    const seen = (lib.readJson(lib.SEEN_FILE, {}) || {})[sid];
    const usage = lib.readJson(lib.USAGE_FILE, {}) || {};
    if (!seen || lib.now() - seen.at > 900) die("The status line has not reported for this session yet. Did install.mjs run, and is this the terminal CLI? (Try again after the model's first answer.)");
    if (!usage.five_hour && !cfg.simulate) die("No rate_limits in the status line data (they need a Pro/Max subscription and arrive after the first API response).");
    const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: taskDir, encoding: "utf8", windowsHide: true });
    const cwd = top.status === 0 ? path.resolve(top.stdout.trim()) : process.cwd();
    if (top.status === 0 && spawnSync("git", ["check-ignore", "-q", path.join(taskDir, "PLAN.md")], { cwd, windowsHide: true }).status !== 0) {
      const gitDir = spawnSync("git", ["rev-parse", "--absolute-git-dir"], { cwd, encoding: "utf8", windowsHide: true }).stdout.trim();
      const rel = path.relative(cwd, taskDir).split(path.sep).join("/");
      fs.mkdirSync(path.join(gitDir, "info"), { recursive: true });
      fs.appendFileSync(path.join(gitDir, "info", "exclude"), `\n/${rel}/\n`);
      console.log(`Task folder added to .git/info/exclude: /${rel}/`);
    }
    const prev = lib.loadState(sid);
    const st = { ...(prev || {}), sid, active: true, phase: "running", taskDir, cwd, pid: proc?.pid ?? null, entrypoint: proc?.entrypoint ?? null, startedAt: prev?.startedAt ?? lib.now(), noProgress: 0, apiErrors: 0, sleeper: null };
    lib.saveState(st);
    const cp = lib.gitCheckpoint(cwd, sid, "start", cfg.checkpointsToKeep);
    if (cp) lib.updateState(sid, (s) => { s.lastCheckpoint = cp; });
    lib.log(`START ${sid} task ${taskDir}`);
    console.log("Autopilot active.\n" + describe(lib.loadState(sid)));
    // Questions reach the user only through Remote Control (Claude app) and its push settings.
    const warn = [];
    if (proc && !proc.bridgeSessionId) warn.push(`Remote Control is not connected in this session: questions will not reach the user's phone. Fix: end the session, start it again with "claude --resume ${sid} --remote-control <name> --permission-mode ${cfg.permissionMode}" and run /autopilot again.`);
    const us = lib.readJson(path.join(lib.CLAUDE_HOME, "settings.json"), {}) || {};
    if (us.inputNeededNotifEnabled !== true) warn.push("Push for questions is off. The user turns it on with: /config inputNeededNotifEnabled=true");
    if (us.agentPushNotifEnabled !== true) warn.push("Push from Claude is off. The user turns it on with: /config agentPushNotifEnabled=true");
    if (warn.length) console.log("\nNOTE (tell the user now, while they are still here):\n- " + warn.join("\n- "));
    break;
  }

  case "status": {
    const all = sidOpt ? [lib.loadState(sidOpt)].filter(Boolean) : lib.listStates();
    if (!all.length) { console.log("No autopilot sessions."); break; }
    console.log(all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).map(describe).join("\n\n"));
    break;
  }

  case "done": {
    const sid = resolveSid();
    lib.updateState(sid, (s) => { s.phase = "done"; s.doneAt = lib.now(); });
    const st = lib.loadState(sid);
    lib.log(`DONE ${sid}`);
    lib.notify(cfg, "Autopilot finished", `${path.basename(st.taskDir)}: every item is done.`);
    console.log("Autopilot: task marked as finished.");
    break;
  }

  case "block": {
    const sid = resolveSid();
    const reason = args.join(" ") || "no reason given";
    lib.updateState(sid, (s) => { s.phase = "needs_attention"; s.blockReason = reason; s.attentionReason = "blocked by the model"; });
    lib.log(`BLOCK ${sid}: ${reason}`);
    lib.notify(cfg, "Autopilot needs you", reason);
    console.log("Autopilot held, the user is notified. End the turn now.");
    break;
  }

  case "hold":
  case "resume":
  case "off": {
    const sid = resolveSid({ requireActive: cmd !== "resume" });
    lib.updateState(sid, (s) => {
      if (cmd === "hold") s.phase = "held";
      if (cmd === "off") { s.active = false; s.phase = "off"; }
      if (cmd === "resume") { s.active = true; s.phase = "running"; s.noProgress = 0; s.apiErrors = 0; s.blockReason = null; s.attentionReason = null; }
      s.sleeper = null;
    });
    lib.log(`${cmd.toUpperCase()} ${sid} (manual)`);
    console.log(describe(lib.loadState(sid)));
    if (cmd === "resume") console.log("\nNote: an idle session does not wake up from this - type \"continue\" in it.");
    break;
  }

  case "resume-now": {
    const sid = resolveSid();
    lib.updateState(sid, (s) => { s.resumeAt = lib.now(); });
    console.log("The pause ends at the sleeper's next check (if the limits allow it).");
    break;
  }

  case "simulate": {
    if (args[0] === "off") { try { fs.unlinkSync(lib.SIM_FILE); } catch {} console.log("Simulation off."); break; }
    const used = Number(args[0]), mins = Number(args[1]);
    if (!Number.isFinite(used) || !Number.isFinite(mins)) die("Usage: autopilot simulate <used%> <resetsInMin> [--ttl <min>] [--lead <min>] [--after <used%>]");
    const sim = { used, resetsAt: lib.now() + mins * 60 };
    const ttl = opt("--ttl"), lead = opt("--lead"), after = opt("--after");
    if (ttl) sim.cacheTtlMin = Number(ttl);
    if (lead) sim.pingLeadMin = Number(lead);
    if (after) sim.afterReset = Number(after);
    lib.writeJson(lib.SIM_FILE, sim);
    console.log(`Simulation: 5h ${used} % until ${lib.fmtTime(sim.resetsAt)}${sim.cacheTtlMin ? `, cache TTL ${sim.cacheTtlMin} min` : ""}.`);
    break;
  }

  case "checkpoint": {
    const sid = resolveSid();
    const st = lib.loadState(sid);
    const cp = lib.gitCheckpoint(st.cwd, sid, "manual", cfg.checkpointsToKeep);
    console.log(cp ? `Snapshot ${cp.ref} (${cp.commit.slice(0, 10)})` : "No git repository, no snapshot.");
    break;
  }

  case "log": {
    const n = Number(args[0]) || 40;
    try { console.log(fs.readFileSync(lib.LOG_FILE, "utf8").trimEnd().split("\n").slice(-n).join("\n")); } catch { console.log("(no log yet)"); }
    break;
  }

  default:
    die(`Unknown command "${cmd}".\n\n${HELP}`);
}
