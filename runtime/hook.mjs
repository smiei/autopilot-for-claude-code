// Autopilot for Claude Code - one entry point for every hook event.
//   node hook.mjs session-start | pre-tool | stop | stop-async | stop-failure [sync]
// Sessions without an autopilot state file leave after one existsSync (only session-start
// does a little more: it exports AUTOPILOT_SESSION_ID for `autopilot start`).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const event = process.argv[2];
let input = {};
try { input = JSON.parse(fs.readFileSync(0, "utf8")); } catch {}
const sid = input.session_id;
const HERE = path.dirname(fileURLToPath(import.meta.url));

if (event === "session-start" && sid && process.env.CLAUDE_ENV_FILE) {
  try { fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export AUTOPILOT_SESSION_ID=${sid}\n`); } catch {}
}
if (!sid || !fs.existsSync(path.join(HERE, "sessions", `${sid.replace(/[^A-Za-z0-9_-]/g, "")}.json`))) process.exit(0);

const lib = await import("./lib.mjs");
const cfg = lib.loadConfig();
const out = (obj) => { process.stdout.write(JSON.stringify(obj)); };

try {
  const st = lib.loadState(sid);
  if (!st || !st.active) process.exit(0);

  switch (event) {
    case "session-start": {
      const proc = lib.findClaudeProcess(sid);
      const ls = lib.limitStatus(cfg);
      lib.updateState(sid, (s) => {
        if (proc) s.pid = proc.pid;
        s.cwd = input.cwd || s.cwd;
        s.lastSessionStart = { source: input.source, at: lib.now() };
        if (input.source === "startup" || input.source === "resume") s.sleeper = null; // a new process has no sleeper yet
        if (["paused", "hard_stopped"].includes(s.phase) && !ls.over && lib.now() >= (s.resumeAt || 0)) {
          s.phase = "running";
          lib.log(`RESUME ${sid} on session-start (${input.source})`);
        }
      });
      if (["done", "off", "held"].includes(st.phase)) process.exit(0);
      const fresh = lib.loadState(sid);
      out({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: lib.protocolText(fresh, cfg) + `\nCurrent phase: ${fresh.phase}.` } });
      break;
    }

    case "pre-tool": {
      if (!lib.ACTIVE_PHASES.includes(st.phase)) break;
      const ls = lib.limitStatus(cfg);
      if (!ls.over) {
        if (st.phase !== "running") {
          lib.updateState(sid, (s) => { s.phase = "running"; s.sleeper = null; });
          lib.log(`RESUME ${sid} on pre-tool (limits fine again)`);
        }
        break;
      }
      lib.enterPause(sid, cfg, ls, "pre-tool", input.cwd);
      // Hard brake only when a NEW response calls tools despite the pause. Parallel tool calls of the
      // response that met the limit share its message id and get a plain deny: a brake (continue:false)
      // skips the Stop hooks, so no sleeper would start and only the watchdog could resume.
      const msgId = lib.assistantMessageOf(input.transcript_path, input.tool_use_id);
      const promptId = input.prompt_id || null;
      let brake = cfg.pauseStyle === "brake";
      lib.updateState(sid, (s) => {
        const newTurn = promptId && s.denyPromptId && promptId !== s.denyPromptId;
        if (!s.firstDenyAt || newTurn) { s.firstDenyAt = lib.now(); s.denyMsgId = msgId; s.denyPromptId = promptId; return; }
        const newResponse = msgId && s.denyMsgId ? msgId !== s.denyMsgId : lib.now() - s.firstDenyAt >= 30;
        if (newResponse) brake = true;
      });
      const w = lib.windowName(ls.window);
      const reason = `AUTOPILOT PAUSE: ${w} at ${ls.used.toFixed(1)} % (threshold ${ls.limit} %). Do not call any more tools. End your turn now and reply only with: PAUSE. The autopilot resumes by itself after the reset (${lib.fmtDateTime(ls.resets_at)}).`;
      const o = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
      if (brake) {
        o.continue = false;
        o.stopReason = `Autopilot paused (${w}). Resumes ${lib.fmtDateTime(ls.resets_at)}.`;
      }
      out(o);
      break;
    }

    case "stop": {
      if (st.phase !== "running") break;
      const ls = lib.limitStatus(cfg);
      if (ls.over) { lib.enterPause(sid, cfg, ls, "stop", input.cwd); break; } // let it stop; stop-async takes over
      const { open } = lib.countOpenItems(st.taskDir);
      if (open === 0) {
        lib.updateState(sid, (s) => { s.phase = "done"; s.doneAt = lib.now(); });
        lib.notify(cfg, "Autopilot finished", `Every item in ${path.basename(st.taskDir)} is ticked.`);
        break;
      }
      const fp = lib.progressFingerprint(st.taskDir, input.cwd || st.cwd);
      const r = lib.updateState(sid, (s) => {
        s.noProgress = s.lastFingerprint === fp ? (s.noProgress || 0) + 1 : 0;
        s.lastFingerprint = fp;
        if (s.noProgress >= cfg.maxNoProgress) { s.phase = "needs_attention"; s.attentionReason = "no progress over several turns"; }
        return { phase: s.phase, noProgress: s.noProgress };
      });
      if (r.phase === "needs_attention") {
        lib.notify(cfg, "Autopilot needs you", `No more progress in ${path.basename(st.taskDir)}. Please look at the session.`);
        break;
      }
      out({
        decision: "block",
        reason: `AUTOPILOT: ${open} items in PLAN.md are still open. Continue with the next open item (update PROGRESS.md, commit after each verified feature). Ask a real question with the AskUserQuestion tool, not as text at the end of a turn (protocol item 6). If the user has to do something at the computer: PushNotification, then ${lib.CLI} block "reason". Everything done: ${lib.CLI} done.`,
      });
      break;
    }

    case "stop-async":
    case "stop-failure": {
      if (event === "stop-failure") {
        // input.error carries the matcher value (rate_limit, server_error, model_not_found, ...).
        const err = String(input.error || "");
        const isRateLimit = err ? /rate_limit/i.test(err) : /rate_limit/i.test(JSON.stringify(input));
        const permanent = /authentication|billing|model_not_found|invalid_request/i.test(err);
        lib.log(`STOPFAILURE ${sid}: ${err || "?"} ${String(input.last_assistant_message || "").slice(0, 200)}`);
        if (permanent && st.phase === "running") {
          // Waking again would fail the same way; the user has to fix login, credits or the model.
          lib.updateState(sid, (s) => { s.phase = "needs_attention"; s.attentionReason = `API error ${err}`; });
          lib.notify(cfg, "Autopilot needs you", `API error "${err}" - retrying will not help.`);
          break;
        }
        if (isRateLimit) {
          const ls = lib.limitStatus(cfg);
          lib.enterPause(sid, cfg, { ...ls, window: ls.window || "five_hour", used: ls.used ?? 100, resets_at: ls.resets_at || ls.u.five_hour.resets_at }, "stop-failure", input.cwd, "hard_stopped");
        }
        if (process.argv[3] === "sync") break; // registered without asyncRewake: no waking possible, the watchdog resumes
        if (isRateLimit) {
          // fall through to the sleeper below
        } else if (st.phase === "running") {
          // Transient API error: wake the model again after a short wait, at most 3 times in a row.
          const n = lib.updateState(sid, (s) => { s.apiErrors = (s.apiErrors || 0) + 1; return s.apiErrors; });
          if (n > 3) { lib.updateState(sid, (s) => { s.phase = "needs_attention"; s.attentionReason = "repeated API errors"; }); lib.notify(cfg, "Autopilot needs you", "Repeated API errors."); break; }
          await lib.sleep(120_000);
          const s2 = lib.loadState(sid);
          if (s2?.active && s2.phase === "running") { process.stderr.write(lib.MSG.retry(s2)); process.exit(2); }
          break;
        }
      }
      await sleeper();
      break;
    }
  }
} catch (e) {
  lib.log(`ERROR in ${event} for ${sid}: ${e.stack || e.message}`);
}
process.exit(0);

// The pause loop: runs in the background (asyncRewake) and wakes the model with exit code 2,
// either for a keep-alive ping before the prompt cache expires or to resume after the reset.
async function sleeper() {
  await lib.sleep(1500); // let the synchronous stop hook finish its state transition first
  let st = lib.loadState(sid);
  if (!st?.active) return;
  if (st.phase === "running") {
    const ls = lib.limitStatus(cfg);
    if (!ls.over) { lib.updateState(sid, (s) => { s.apiErrors = 0; }); return; }
    lib.enterPause(sid, cfg, ls, "stop-async", input.cwd);
    st = lib.loadState(sid);
  }
  if (!["paused", "hard_stopped"].includes(st.phase)) return;

  const me = process.pid;
  const claimed = lib.updateState(sid, (s) => {
    if (s.sleeper && s.sleeper.pid !== me && lib.pidAlive(s.sleeper.pid) && lib.now() - (s.sleeper.hb || 0) < 120) return false;
    s.sleeper = { pid: me, startedAt: lib.now(), hb: lib.now() };
    return true;
  });
  if (!claimed) { lib.log(`sleeper ${me}: another sleeper is alive, leaving`); return; }

  const t0 = lib.now();
  const sim = cfg.simulate;
  lib.log(`sleeper ${me} for ${sid} started (phase ${st.phase}, resume ${lib.fmtDateTime(st.resumeAt)})`);
  for (;;) {
    st = lib.loadState(sid);
    if (!st || !st.active || !["paused", "hard_stopped"].includes(st.phase) || st.sleeper?.pid !== me) {
      lib.log(`sleeper ${me}: state changed (${st?.phase}), leaving quietly`);
      return;
    }
    const t = lib.now();
    const ls = lib.limitStatus(cfg);
    const resumeAt = st.resumeAt || t;

    // 1. Window has reset -> continue the work in this very process (cache still warm if pings ran).
    if (!ls.over && t >= resumeAt) {
      lib.updateState(sid, (s) => { s.phase = "running"; s.resumedAt = t; s.sleeper = null; s.noProgress = 0; s.apiErrors = 0; });
      lib.log(`RESUME ${sid} by sleeper ${me} after ${((t - st.pausedAt) / 60).toFixed(0)} min pause, ${st.pingsThisPause || 0} pings`);
      lib.notify(cfg, "Autopilot resumes", `New usage window. Work on ${path.basename(st.taskDir)} continues.`);
      process.stderr.write(lib.MSG.resume(st));
      process.exit(2);
    }
    if (ls.over && ls.resets_at && Math.abs(ls.resets_at + cfg.resumeGraceSec - resumeAt) > 120) {
      lib.updateState(sid, (s) => { s.resumeAt = ls.resets_at + cfg.resumeGraceSec; });
      continue;
    }

    // 2. Keep the prompt cache warm while it would expire before the reset.
    const ttl = sim?.cacheTtlMin ?? cfg.cacheTtlMin;
    const lead = sim?.pingLeadMin ?? cfg.pingLeadMin;
    let cacheExp = t0 + ttl * 60;
    if (!sim?.cacheTtlMin && st.cacheExpiresAt && st.cacheExpiresAt > t0 - 60 && st.cacheExpiresAt < cacheExp + 300) cacheExp = st.cacheExpiresAt;
    const pingAt = cacheExp - lead * 60;
    // The resume request itself refreshes the cache, so a ping is only needed if the cache dies before it.
    const needPing = st.phase === "paused" && st.pauseWindow !== "seven_day" && cacheExp < resumeAt + 15;
    const cost = st.pingCost ?? cfg.defaultPingCost;
    const budgetOk = ls.u.five_hour.used + cost <= cfg.pingCeiling;
    if (needPing && !budgetOk && !st.pingStopped) {
      lib.updateState(sid, (s) => { s.pingStopped = true; });
      lib.log(`sleeper ${me}: no more keep-alive pings (5h ${ls.u.five_hour.used} % + ${cost.toFixed(2)} > ${cfg.pingCeiling} %)`);
    }
    if (needPing && budgetOk && t >= pingAt) {
      lib.updateState(sid, (s) => { s.lastPing = { at: t, usedBefore: ls.u.five_hour.used, resetsAt: ls.u.five_hour.resets_at, simulated: !!ls.u.five_hour.simulated, apiMsBefore: s.lastApiMs ?? null }; s.pingsThisPause = (s.pingsThisPause || 0) + 1; s.sleeper = null; s.firstDenyAt = null; });
      lib.log(`KEEPALIVE ${sid} #${(st.pingsThisPause || 0) + 1} (cache expires ${lib.fmtTime(cacheExp)}, resume ${lib.fmtTime(resumeAt)})`);
      process.stderr.write(lib.MSG.keepalive);
      process.exit(2);
    }

    // 3. Longer than this hook may live (weekly limit, hard stop far away): hand over to the watchdog.
    const nextWake = needPing && budgetOk ? Math.min(pingAt, resumeAt) : resumeAt;
    if (nextWake - t0 > cfg.maxSleepHours * 3600) {
      lib.updateState(sid, (s) => { s.sleeper = null; s.handoff = "watchdog"; s.nextWakeAt = resumeAt; s.nextWakeKind = "watchdog-resume"; });
      lib.log(`sleeper ${me}: wait until ${lib.fmtDateTime(resumeAt)} is too long for a hook; watchdog takes over`);
      return;
    }
    lib.updateState(sid, (s) => { if (s.sleeper?.pid === me) s.sleeper.hb = lib.now(); s.nextWakeAt = nextWake; s.nextWakeKind = nextWake === resumeAt ? "resume" : "keepalive"; });
    await lib.sleep(Math.max(5, Math.min(30, nextWake - lib.now())) * 1000);
  }
}
