// Autopilot for Claude Code - shared helpers (state files, usage merge, checkpoints, notifications).
// Everything here runs outside the model: no tokens.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const AP_HOME = path.dirname(fileURLToPath(import.meta.url));
export const SESS_DIR = path.join(AP_HOME, "sessions");
export const USAGE_FILE = path.join(AP_HOME, "usage.json");
export const SEEN_FILE = path.join(AP_HOME, "seen.json");
export const SIM_FILE = path.join(AP_HOME, "simulate.json");
export const LOG_FILE = path.join(AP_HOME, "log.txt");
// Claude Code's own config folder (it honours CLAUDE_CONFIG_DIR, so do we).
export const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR ? path.resolve(process.env.CLAUDE_CONFIG_DIR) : path.join(os.homedir(), ".claude");
export const CLAUDE_SESSIONS = path.join(CLAUDE_HOME, "sessions");
export const ACTIVE_PHASES = ["running", "paused", "hard_stopped"];
// How the model calls the control CLI (used in hook messages and the protocol).
export const CLI = `node "${AP_HOME.split(path.sep).join("/")}/autopilot.mjs"`;

const DEFAULTS = {
  stopAt: 90, weeklyStopAt: 90, pingCeiling: 95, pingLeadMin: 5, cacheTtlMin: 60,
  resumeGraceSec: 90, defaultPingCost: 1.0, maxSleepHours: 5.4, pauseStyle: "deny-then-brake",
  cleanupPorts: null, permissionMode: "auto", claudeExe: path.join(os.homedir(), ".local", "bin", "claude.exe"),
  maxRelaunchesPerWindow: 3, stallMinutes: 20, checkpointsToKeep: 20, maxNoProgress: 3, notify: true, remoteControl: true,
  chainStatusLine: null,
};

export const now = () => Date.now() / 1000;

export function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

// Atomic write: temp file + rename, retried because Windows refuses a rename onto a file someone has open.
export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      if (i >= 20) { try { fs.unlinkSync(tmp); } catch {} throw e; }
      sleepSync(25 + i * 10);
    }
  }
}

export function loadConfig() {
  const cfg = { ...DEFAULTS, ...(readJson(path.join(AP_HOME, "config.json"), {}) || {}) };
  if (!cfg.claudeExe) cfg.claudeExe = DEFAULTS.claudeExe;
  cfg.simulate = readJson(SIM_FILE, null);
  return cfg;
}

export function log(msg) {
  try {
    fs.mkdirSync(AP_HOME, { recursive: true });
    try { if (fs.statSync(LOG_FILE).size > 1_000_000) fs.renameSync(LOG_FILE, LOG_FILE.replace(/\.txt$/, ".1.txt")); } catch {}
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} [${process.pid}] ${msg}\n`);
  } catch {}
}

export const fmtTime = (epochSec) => epochSec ? new Date(epochSec * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "?";
export const fmtDateTime = (epochSec) => epochSec ? new Date(epochSec * 1000).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "?";

// ---------- lock (exclusive create; stale after 20 s) ----------
export function withLock(name, fn) {
  const lock = path.join(SESS_DIR, `${name}.lock`);
  fs.mkdirSync(SESS_DIR, { recursive: true });
  const start = Date.now();
  for (;;) {
    try { fs.closeSync(fs.openSync(lock, "wx")); break; } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 20000) { fs.unlinkSync(lock); continue; } } catch {}
      if (Date.now() - start > 8000) break; // give up waiting; proceed without the lock rather than hang a hook
      sleepSync(30);
    }
  }
  try { return fn(); } finally { try { fs.unlinkSync(lock); } catch {} }
}

// ---------- usage (written by the status line, read by everything else) ----------
// Rate limits are account-wide. Several sessions may report them; within one window the highest
// percentage is the freshest (usage only grows), a later resets_at means a newer window.
export function mergeUsage(rateLimits, sid) {
  if (!rateLimits || typeof rateLimits !== "object") return;
  withLock("usage", () => {
    const cur = readJson(USAGE_FILE, {}) || {};
    let changed = false;
    for (const w of ["five_hour", "seven_day"]) {
      const inc = rateLimits[w];
      if (!inc || typeof inc.used_percentage !== "number" || typeof inc.resets_at !== "number") continue;
      const e = cur[w];
      if (!e || inc.resets_at > e.resets_at + 60) {
        cur[w] = { used: inc.used_percentage, resets_at: inc.resets_at, seenAt: now(), sid };
        changed = true;
      } else if (Math.abs(inc.resets_at - e.resets_at) <= 60 && inc.used_percentage > e.used) {
        cur[w] = { ...e, used: inc.used_percentage, seenAt: now(), sid };
        changed = true;
      }
    }
    if (changed) { cur.updatedAt = now(); writeJson(USAGE_FILE, cur); }
  });
}

export function markSeen(sid, cwd) {
  if (!sid) return;
  const seen = readJson(SEEN_FILE, {}) || {};
  const prev = seen[sid];
  if (prev && now() - prev.at < 30) return;
  const cutoff = now() - 86400;
  for (const k of Object.keys(seen)) if (seen[k].at < cutoff) delete seen[k];
  seen[sid] = { at: now(), cwd };
  try { writeJson(SEEN_FILE, seen); } catch {}
}

// Effective usage right now. A window whose resets_at has passed counts as 0 until fresh data arrives.
export function effectiveUsage(cfg) {
  const u = readJson(USAGE_FILE, {}) || {};
  const t = now();
  const out = {};
  for (const w of ["five_hour", "seven_day"]) {
    const e = u[w];
    out[w] = e && t < e.resets_at
      ? { used: e.used, resets_at: e.resets_at, known: true }
      : { used: 0, resets_at: e ? e.resets_at : null, known: false };
  }
  const sim = cfg.simulate;
  if (sim && sim.resetsAt) {
    out.five_hour = t < sim.resetsAt
      ? { used: sim.used, resets_at: sim.resetsAt, known: true, simulated: true }
      : { used: sim.afterReset ?? 5, resets_at: sim.resetsAt + 5 * 3600, known: true, simulated: true };
  }
  return out;
}

export function limitStatus(cfg) {
  const u = effectiveUsage(cfg);
  if (u.seven_day.used >= cfg.weeklyStopAt) return { over: true, window: "seven_day", used: u.seven_day.used, limit: cfg.weeklyStopAt, resets_at: u.seven_day.resets_at, u };
  if (u.five_hour.used >= cfg.stopAt) return { over: true, window: "five_hour", used: u.five_hour.used, limit: cfg.stopAt, resets_at: u.five_hour.resets_at, u };
  return { over: false, u };
}

export const windowName = (w) => (w === "seven_day" ? "weekly limit" : "5-hour limit");

// ---------- per-session autopilot state ----------
const safeId = (sid) => String(sid).replace(/[^A-Za-z0-9_-]/g, "");
export const statePath = (sid) => path.join(SESS_DIR, `${safeId(sid)}.json`);
export const loadState = (sid) => readJson(statePath(sid));
export function saveState(st) { st.updatedAt = now(); writeJson(statePath(st.sid), st); }

export function updateState(sid, fn) {
  return withLock(safeId(sid), () => {
    const st = loadState(sid);
    if (!st) return null;
    const r = fn(st);
    saveState(st);
    return r === undefined ? st : r;
  });
}

export function listStates() {
  try {
    return fs.readdirSync(SESS_DIR).filter((f) => f.endsWith(".json")).map((f) => readJson(path.join(SESS_DIR, f))).filter(Boolean);
  } catch { return []; }
}

// ---------- Claude Code's own process registry (<config dir>/sessions/<pid>.json, undocumented) ----------
export function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

export function findClaudeProcess(sid) {
  let best = null;
  let files = [];
  try { files = fs.readdirSync(CLAUDE_SESSIONS).filter((f) => f.endsWith(".json")); } catch {}
  for (const f of files) {
    const j = readJson(path.join(CLAUDE_SESSIONS, f));
    if (j && j.sessionId === sid && pidAlive(j.pid) && (!best || (j.updatedAt || 0) > (best.updatedAt || 0))) best = j;
  }
  return best;
}

// The API response (assistant message id) a tool call belongs to, read from the transcript's tail.
// One response can carry several parallel tool calls; they all share this id.
export function assistantMessageOf(transcriptPath, toolUseId) {
  if (!transcriptPath || !toolUseId) return null;
  try {
    const fd = fs.openSync(transcriptPath, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, 1024 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString("utf8").split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes(toolUseId) || !lines[i].includes('"assistant"')) continue;
        try { const e = JSON.parse(lines[i]); if (e.type === "assistant" && e.message?.id) return e.message.id; } catch {}
      }
    } finally { fs.closeSync(fd); }
  } catch {}
  return null;
}

// A claude.exe started with this session id that has not registered (yet): it is still starting or
// waits on a startup dialog (new MCP server, model choice, ...), which only happens before registration.
export function findUnregisteredProcess(sid, exeName = "claude.exe") {
  if (!/^[\w-]+$/.test(sid) || !/^[\w.-]+$/.test(exeName)) return null;
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `Get-CimInstance Win32_Process -Filter "Name='${exeName}'" | Where-Object { $_.CommandLine -match '${sid}' } | ForEach-Object { $_.ProcessId }`],
    { encoding: "utf8", windowsHide: true, timeout: 30000 });
  const pid = Number((r.stdout || "").trim().split(/\s+/)[0]);
  return pid > 0 ? pid : null;
}

// Walk up from this process to the claude.exe that owns it (Bash tool -> bash.exe -> node).
export function findOwnClaudeSession() {
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }"], { encoding: "utf8", windowsHide: true, timeout: 30000 });
  const parent = new Map();
  for (const line of (r.stdout || "").split(/\r?\n/)) {
    const [p, pp] = line.trim().split(/\s+/).map(Number);
    if (p) parent.set(p, pp);
  }
  let pid = process.pid;
  for (let i = 0; i < 12 && pid; i++) {
    const j = readJson(path.join(CLAUDE_SESSIONS, `${pid}.json`));
    if (j && j.sessionId) return j;
    pid = parent.get(pid);
  }
  return null;
}

// ---------- task files ----------
export function countOpenItems(taskDir) {
  try {
    const t = fs.readFileSync(path.join(taskDir, "PLAN.md"), "utf8");
    return { open: (t.match(/^\s*[-*] \[ \]/gm) || []).length, done: (t.match(/^\s*[-*] \[[xX]\]/gm) || []).length };
  } catch { return { open: -1, done: 0 }; }
}

export function progressFingerprint(taskDir, cwd) {
  const h = crypto.createHash("sha1");
  for (const f of ["PLAN.md", "PROGRESS.md"]) { try { h.update(fs.readFileSync(path.join(taskDir, f))); } catch {} }
  const git = (args) => spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, timeout: 20000 }).stdout || "";
  h.update(git(["rev-parse", "-q", "--verify", "HEAD"]));
  h.update(git(["status", "--porcelain"]));
  h.update(git(["diff", "--shortstat"]));
  return h.digest("hex");
}

// ---------- git checkpoint: snapshot of the working tree as a hidden ref ----------
// Uses a temporary index, so the real index, the working tree and the branch stay untouched.
export function gitCheckpoint(cwd, sid, reason, keep = 20) {
  const run = (args, opts = {}) => spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, timeout: 60000, ...opts });
  const top = run(["rev-parse", "--show-toplevel"]);
  if (top.status !== 0) return null;
  const root = top.stdout.trim();
  const gitDir = run(["rev-parse", "--absolute-git-dir"], { cwd: root }).stdout.trim();
  const tmpIdx = path.join(os.tmpdir(), `autopilot-index-${process.pid}-${Date.now()}`);
  try {
    try { fs.copyFileSync(path.join(gitDir, "index"), tmpIdx); } catch {}
    const env = { ...process.env, GIT_INDEX_FILE: tmpIdx, GIT_AUTHOR_NAME: "autopilot", GIT_AUTHOR_EMAIL: "autopilot@localhost", GIT_COMMITTER_NAME: "autopilot", GIT_COMMITTER_EMAIL: "autopilot@localhost" };
    if (run(["add", "-A"], { cwd: root, env }).status !== 0) return null;
    const tree = run(["write-tree"], { cwd: root, env }).stdout.trim();
    if (!tree) return null;
    const head = run(["rev-parse", "-q", "--verify", "HEAD"], { cwd: root }).stdout.trim();
    const args = ["commit-tree", tree, "-m", `autopilot checkpoint (${reason}) ${new Date().toISOString()}`];
    if (head) args.splice(2, 0, "-p", head);
    const commit = run(args, { cwd: root, env }).stdout.trim();
    if (!commit) return null;
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
    const prefix = `refs/autopilot/${safeId(sid).slice(0, 8)}/`;
    run(["update-ref", `${prefix}${stamp}`, commit], { cwd: root });
    const refs = run(["for-each-ref", "--format=%(refname)", "--sort=refname", prefix], { cwd: root }).stdout.split(/\r?\n/).filter(Boolean);
    for (const r of refs.slice(0, Math.max(0, refs.length - keep))) run(["update-ref", "-d", r], { cwd: root });
    return { ref: `${prefix}${stamp}`, commit };
  } finally { try { fs.unlinkSync(tmpIdx); } catch {} }
}

// Optional: stop whatever listens on the configured scratch port range (never anything outside it).
export function cleanupPorts(range) {
  if (!Array.isArray(range) || range.length !== 2) return [];
  const [lo, hi] = range.map(Number);
  if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 1024 || hi < lo) return [];
  const ps = `Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -ge ${lo} -and $_.LocalPort -le ${hi} -and $_.OwningProcess -gt 4 } | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { try { Stop-Process -Id $_ -Force -ErrorAction Stop; \"$_\" } catch {} }`;
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", windowsHide: true, timeout: 30000 });
  return (r.stdout || "").split(/\s+/).filter(Boolean);
}

// Windows toast via PowerShell's registered app id; fire and forget.
export function notify(cfg, title, text) {
  log(`NOTIFY ${title}: ${text}`);
  if (!cfg.notify) return;
  const esc = (s) => String(s).replace(/'/g, "''");
  const ps = [
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
    "$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
    "$t = $x.GetElementsByTagName('text')",
    `$t.Item(0).AppendChild($x.CreateTextNode('${esc(title)}')) > $null`,
    `$t.Item(1).AppendChild($x.CreateTextNode('${esc(text)}')) > $null`,
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($x))",
  ].join("; ");
  try {
    const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", ps], { detached: true, stdio: "ignore", windowsHide: true });
    p.unref();
  } catch {}
}

// ---------- pause transition (shared by PreToolUse, Stop and StopFailure) ----------
export function enterPause(sid, cfg, ls, source, cwd, phase = "paused") {
  const res = updateState(sid, (st) => {
    if (st.phase === "paused" || st.phase === "hard_stopped") {
      st.denyCount = (st.denyCount || 0) + 1;
      if (phase === "hard_stopped") st.phase = "hard_stopped";
      return { transitioned: false, st };
    }
    st.phase = phase;
    st.pausedAt = now();
    st.pauseWindow = ls.window || "five_hour";
    st.pauseUsed = ls.used ?? null;
    st.resumeAt = (ls.resets_at || now() + 5 * 3600) + cfg.resumeGraceSec;
    st.denyCount = 0;
    st.firstDenyAt = null;
    st.denyMsgId = null;
    st.denyPromptId = null;
    st.pingsThisPause = 0;
    st.pingStopped = false;
    st.sleeper = null;
    return { transitioned: true, st };
  });
  if (!res || !res.transitioned) return res;
  const st = res.st;
  log(`PAUSE ${sid} via ${source}: ${st.pauseWindow} ${st.pauseUsed} % -> phase ${phase}, resume ${fmtDateTime(st.resumeAt)}`);
  const cp = gitCheckpoint(cwd || st.cwd, sid, `${phase}:${source}`, cfg.checkpointsToKeep);
  const killed = cleanupPorts(cfg.cleanupPorts);
  updateState(sid, (s) => { s.lastCheckpoint = cp; s.lastCleanup = killed; });
  log(`  checkpoint ${cp ? cp.ref : "skipped (no git repo)"}, stopped pids [${killed.join(", ")}]`);
  notify(cfg, phase === "hard_stopped" ? "Autopilot: hard limit reached" : "Autopilot paused",
    `${windowName(st.pauseWindow)} at ${st.pauseUsed != null ? Number(st.pauseUsed).toFixed(0) : "?"} %. Resumes ${fmtDateTime(st.resumeAt)}.`);
  return res;
}

export function protocolText(st, cfg) {
  let t = "";
  try { t = fs.readFileSync(path.join(AP_HOME, "protocol.md"), "utf8"); } catch {}
  const ports = Array.isArray(cfg?.cleanupPorts) && cfg.cleanupPorts.length === 2
    ? `Run dev servers and other long-running processes only on ports ${cfg.cleanupPorts[0]}-${cfg.cleanupPorts[1]}. A pause stops them; start them again after resuming if needed.`
    : "Stop dev servers and other long-running processes you started once you no longer need them; after a pause or restart, start them again if needed.";
  return t.replaceAll("{{TASK_DIR}}", st.taskDir).replaceAll("{{PHASE}}", st.phase).replaceAll("{{CLI}}", CLI).replaceAll("{{PORTS_RULE}}", ports);
}

export const MSG = {
  keepalive: "AUTOPILOT KEEPALIVE - reply with exactly one period (.) and nothing else: no tool, no summary, no thinking.",
  resume: (st) => `AUTOPILOT RESUME - the usage window has reset. Read ${st.taskDir}/PROGRESS.md and continue with the next open item in PLAN.md (questions as the protocol says).`,
  relaunch: (st) => `AUTOPILOT RESUME - the watchdog restarted this session. Read ${st.taskDir}/PROGRESS.md, check the state with git status and continue with the next open item in PLAN.md (questions as the protocol says).`,
  retry: (st) => `AUTOPILOT RETRY - the last turn ended with an API error. Read ${st.taskDir}/PROGRESS.md and continue with the open item.`,
};
