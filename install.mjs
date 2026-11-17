#!/usr/bin/env node
// Autopilot for Claude Code - installer.
//
//   node install.mjs                 install or update (idempotent; keeps your config.json)
//   node install.mjs --uninstall     remove hooks, status line, skill, scheduled task and keep-alive rule
//
// Options:
//   --claude-dir <dir>   Claude Code config folder (default: $CLAUDE_CONFIG_DIR or ~/.claude)
//   --enable-push        also turn on "Push when actions required" and "Push when Claude decides"
//   --no-task            do not register the Windows scheduled task (tests, or if you do not want the watchdog)
//   --purge              with --uninstall: also delete config, state and log
//   --force              with --uninstall: even while an autopilot run is active
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const value = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const uninstall = flag("--uninstall");
const noTask = flag("--no-task");

if (process.platform !== "win32") fail("The autopilot supports Windows only (Task Scheduler, Windows Terminal, toasts).");
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 20 || (major === 20 && minor < 10)) fail(`Node.js 20.10 or newer is needed (found ${process.versions.node}).`);

const SRC = path.dirname(fileURLToPath(import.meta.url));
const CLAUDE_DIR = path.resolve(value("--claude-dir") || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"));
const AP = path.join(CLAUDE_DIR, "autopilot");
const AP_FWD = AP.split(path.sep).join("/");
const SETTINGS = path.join(CLAUDE_DIR, "settings.json");
const CLAUDE_MD = path.join(CLAUDE_DIR, "CLAUDE.md");
const SKILL_DIR = path.join(CLAUDE_DIR, "skills", "autopilot");
const TASK = "ClaudeAutopilotWatchdog";
const MARK = "autopilot/hook.mjs";
const STATUS_MARK = "autopilot/statusline.mjs";
const RUNTIME_FILES = ["lib.mjs", "hook.mjs", "statusline.mjs", "autopilot.mjs", "watchdog.mjs", "protocol.md"];
const CLI = `node "${AP_FWD}/autopilot.mjs"`;
const H = (ev) => `node "${AP_FWD}/hook.mjs" ${ev}`;
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");

console.log(`${uninstall ? "Uninstalling" : "Installing"} Autopilot for Claude Code in ${CLAUDE_DIR}\n`);
if (uninstall) doUninstall(); else doInstall();

// ---------------------------------------------------------------------------------------------
function doInstall() {
  // 1. runtime files
  fs.mkdirSync(path.join(AP, "sessions"), { recursive: true });
  for (const f of RUNTIME_FILES) fs.copyFileSync(path.join(SRC, "runtime", f), path.join(AP, f));
  ok(`runtime copied to ${AP}`);

  // 2. config.json: defaults + whatever the user already set
  const cfgFile = path.join(AP, "config.json");
  const defaults = readJson(path.join(SRC, "runtime", "config.default.json"), {});
  const cfg = { ...defaults, ...(readJson(cfgFile, {}) || {}) };
  if (!cfg.claudeExe || !fs.existsSync(cfg.claudeExe)) cfg.claudeExe = findClaude();
  if (!fs.existsSync(cfg.claudeExe)) warn(`claude.exe not found (looked for ${cfg.claudeExe}). Install Claude Code with the native installer, or set "claudeExe" in ${cfgFile}. The watchdog needs it for restarts.`);

  // 3. settings.json: hooks + status line (a status line of your own keeps running, chained)
  const raw = fs.existsSync(SETTINGS) ? fs.readFileSync(SETTINGS, "utf8") : "{}";
  const settings = parseSettings(raw);
  if (fs.existsSync(SETTINGS)) fs.writeFileSync(`${SETTINGS}.bak-autopilot-${stamp}`, raw);
  removeOurHooks(settings);
  const sl = settings.statusLine;
  if (sl && !String(sl.command || "").includes(STATUS_MARK)) {
    cfg.chainStatusLine = sl;
    ok(`your status line stays: it runs first, the autopilot appends its segment ("${String(sl.command).slice(0, 60)}")`);
  }
  settings.statusLine = { type: "command", command: `node "${AP_FWD}/statusline.mjs"`, refreshInterval: 60 };
  settings.hooks = settings.hooks || {};
  const add = (ev, group) => { (settings.hooks[ev] = settings.hooks[ev] || []).push(group); };
  add("SessionStart", { hooks: [{ type: "command", command: H("session-start"), timeout: 30 }] });
  add("PreToolUse", { matcher: "*", hooks: [{ type: "command", command: H("pre-tool"), timeout: 120 }] });
  add("Stop", { hooks: [
    { type: "command", command: H("stop"), timeout: 60 },
    { type: "command", command: H("stop-async"), asyncRewake: true, timeout: 19800 },
  ] });
  add("StopFailure", { hooks: [{ type: "command", command: H("stop-failure"), asyncRewake: true, timeout: 19800 }] });
  if (flag("--enable-push")) { settings.agentPushNotifEnabled = true; settings.inputNeededNotifEnabled = true; ok("push notifications turned on"); }
  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + "\n");
  writeJson(cfgFile, cfg);
  ok(`hooks and status line in ${SETTINGS}${raw !== "{}" ? ` (backup: settings.json.bak-autopilot-${stamp})` : ""}`);

  // 4. skill
  fs.mkdirSync(SKILL_DIR, { recursive: true });
  const skill = fs.readFileSync(path.join(SRC, "skill", "SKILL.md"), "utf8").replaceAll("{{CLI}}", CLI).replaceAll("{{AP_HOME}}", AP_FWD);
  fs.writeFileSync(path.join(SKILL_DIR, "SKILL.md"), skill);
  ok(`skill /autopilot in ${SKILL_DIR}`);

  // 5. keep-alive rule in the global CLAUDE.md
  writeRule(true);
  ok(`keep-alive rule in ${CLAUDE_MD}`);

  // 6. watchdog
  const vbs = path.join(AP, "watchdog.vbs");
  const envLine = CLAUDE_DIR !== path.join(os.homedir(), ".claude") ? `sh.Environment("PROCESS")("CLAUDE_CONFIG_DIR") = "${CLAUDE_DIR}"\r\n` : "";
  fs.writeFileSync(vbs, `' Autopilot for Claude Code - watchdog launcher (hidden window)\r\nSet sh = CreateObject("WScript.Shell")\r\n${envLine}sh.Run """${process.execPath}"" ""${path.join(AP, "watchdog.mjs")}""", 0, False\r\n`);
  if (noTask) ok("scheduled task skipped (--no-task)");
  else {
    const r = ps([
      `$a = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument '"${vbs}"'`,
      `$t1 = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\\$env:USERNAME"`,
      `$t2 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 10)`,
      `$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5)`,
      `$p = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\\$env:USERNAME" -LogonType Interactive -RunLevel Limited`,
      `Register-ScheduledTask -TaskName '${TASK}' -Action $a -Trigger @($t1, $t2) -Settings $s -Principal $p -Description 'Autopilot for Claude Code: restarts autopilot sessions after crashes or hard limit stops (no tokens).' -Force | Out-Null`,
      `(Get-ScheduledTask -TaskName '${TASK}').State`,
    ].join("; "));
    if (/Ready|Running/i.test(r)) ok(`scheduled task ${TASK} (every 10 minutes and at logon)`);
    else warn(`scheduled task ${TASK} could not be registered: ${r.trim() || "see the message above"}`);
  }

  const push = settings.agentPushNotifEnabled === true && settings.inputNeededNotifEnabled === true;
  console.log(`
Done. Next steps:
  1. ${push ? "Push notifications are on." : "For questions on your phone, type once in Claude Code:  /config agentPushNotifEnabled=true inputNeededNotifEnabled=true"}
  2. Open Windows Terminal in your repository and start:  claude --remote-control <name> --permission-mode ${cfg.permissionMode}
  3. Type:  /autopilot <your large task>
Status any time:  ${CLI} status`);
}

// ---------------------------------------------------------------------------------------------
function doUninstall() {
  const active = listStates().filter((s) => s.active && ["running", "paused", "hard_stopped"].includes(s.phase));
  if (active.length && !flag("--force")) fail(`An autopilot run is active (${active.map((s) => path.basename(s.taskDir || "?")).join(", ")}). Finish it, run "${CLI} off", or pass --force.`);
  const cfg = readJson(path.join(AP, "config.json"), {}) || {};

  if (fs.existsSync(SETTINGS)) {
    const raw = fs.readFileSync(SETTINGS, "utf8");
    const settings = parseSettings(raw);
    fs.writeFileSync(`${SETTINGS}.bak-autopilot-${stamp}`, raw);
    removeOurHooks(settings);
    if (settings.statusLine && String(settings.statusLine.command || "").includes(STATUS_MARK)) {
      if (cfg.chainStatusLine) { settings.statusLine = cfg.chainStatusLine; ok("your previous status line is back"); }
      else delete settings.statusLine;
    }
    fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + "\n");
    ok(`hooks and status line removed from ${SETTINGS} (backup: settings.json.bak-autopilot-${stamp}); push settings left as they are`);
  }

  if (!noTask) { ps(`Unregister-ScheduledTask -TaskName '${TASK}' -Confirm:$false -ErrorAction SilentlyContinue`); ok(`scheduled task ${TASK} removed`); }

  writeRule(false);
  ok(`keep-alive rule removed from ${CLAUDE_MD}`);

  const skillFile = path.join(SKILL_DIR, "SKILL.md");
  if (fs.existsSync(skillFile) && fs.readFileSync(skillFile, "utf8").includes("autopilot.mjs")) { fs.rmSync(SKILL_DIR, { recursive: true, force: true }); ok("skill /autopilot removed"); }

  if (flag("--purge")) { fs.rmSync(AP, { recursive: true, force: true }); ok(`${AP} deleted`); }
  else {
    for (const f of [...RUNTIME_FILES, "watchdog.vbs", "watchdog.json", "usage.json", "seen.json", "simulate.json"]) fs.rmSync(path.join(AP, f), { force: true });
    ok(`scripts removed; config.json, sessions/ and log.txt stay in ${AP} (--purge deletes them)`);
  }
  console.log("\nUninstalled.");
}

// ---------------------------------------------------------------------------------------------
function removeOurHooks(settings) {
  if (!settings.hooks) return;
  for (const ev of Object.keys(settings.hooks)) {
    settings.hooks[ev] = (settings.hooks[ev] || [])
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !String(h.command || "").includes(MARK)) }))
      .filter((g) => g.hooks.length > 0);
    if (!settings.hooks[ev].length) delete settings.hooks[ev];
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
}

function writeRule(add) {
  const head = "# Autopilot keep-alive";
  const rule = `${head}\nWhen a hook message starts with "AUTOPILOT KEEPALIVE", reply with exactly "." and nothing else: no tool calls, no recap, minimal thinking. It only refreshes the prompt cache during an autopilot pause. "AUTOPILOT PAUSE" means: call no more tools and reply only "PAUSE". "AUTOPILOT RESUME"/"AUTOPILOT RETRY" means: continue the autopilot task as the message says.\n`;
  let md = fs.existsSync(CLAUDE_MD) ? fs.readFileSync(CLAUDE_MD, "utf8") : "";
  md = md.replace(new RegExp(`\\n?${head}\\n[\\s\\S]*?(?=\\n# |$)`), "").trimEnd();
  if (add) md = md ? `${md}\n\n${rule}` : rule;
  if (!md && !fs.existsSync(CLAUDE_MD)) return;
  fs.writeFileSync(CLAUDE_MD, md ? (md.endsWith("\n") ? md : md + "\n") : "");
}

function findClaude() {
  const r = spawnSync("where.exe", ["claude"], { encoding: "utf8", windowsHide: true });
  const hits = (r.stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return hits.find((h) => /\.exe$/i.test(h)) || hits.find((h) => /\.cmd$/i.test(h)) || path.join(os.homedir(), ".local", "bin", "claude.exe");
}

function listStates() {
  try { return fs.readdirSync(path.join(AP, "sessions")).filter((f) => f.endsWith(".json")).map((f) => readJson(path.join(AP, "sessions", f))).filter(Boolean); } catch { return []; }
}

function parseSettings(raw) {
  try { return JSON.parse(raw); } catch (e) { fail(`${SETTINGS} is not valid JSON (${e.message}). Fix it first; nothing was changed.`); }
}

function ps(command) {
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8", windowsHide: true });
  if (r.stderr && r.stderr.trim()) console.error(r.stderr.trim());
  return r.stdout || "";
}

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function writeJson(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n"); }
function ok(msg) { console.log(`  ok    ${msg}`); }
function warn(msg) { console.log(`  WARN  ${msg}`); }
function fail(msg) { console.error(`Error: ${msg}`); process.exit(1); }
