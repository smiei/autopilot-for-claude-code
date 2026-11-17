// Installer: install into a fake Claude config folder that already has a status line, a hook and a CLAUDE.md
// of its own; reinstall (idempotent); the chained status line; uninstall restores what was there.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { ROOT, ok, finish, cleanEnv, now } from "./helpers.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-test-install-"));
const dir = path.join(root, "claude");
const ap = path.join(dir, "autopilot");
fs.mkdirSync(dir, { recursive: true });
const theirStatus = { type: "command", command: "echo THEIRS", padding: 1 };
const otherHook = { matcher: "Bash", hooks: [{ type: "command", command: "echo other-hook" }] };
fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ model: "opus", statusLine: theirStatus, hooks: { PreToolUse: [otherHook] } }, null, 2));
fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# Mine\nkeep this\n");

const env = cleanEnv();
const install = (...extra) => spawnSync(process.execPath, [path.join(ROOT, "install.mjs"), "--claude-dir", dir, "--no-task", ...extra], { encoding: "utf8", env, windowsHide: true });
const settings = () => JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
const ours = (s) => JSON.stringify(s.hooks || {}).split("autopilot/hook.mjs").length - 1;
const md = () => fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8");

try {
  let r = install();
  ok(r.status === 0, `install exits 0 ${r.status ? r.stderr || r.stdout : ""}`);
  for (const f of ["lib.mjs", "hook.mjs", "statusline.mjs", "autopilot.mjs", "watchdog.mjs", "protocol.md", "config.json", "watchdog.vbs"]) ok(fs.existsSync(path.join(ap, f)), `${f} installed`);
  let s = settings();
  ok(ours(s) === 5, `5 autopilot hooks registered (${ours(s)})`);
  ok(s.hooks.Stop[0].hooks[1].asyncRewake === true && s.hooks.StopFailure[0].hooks[0].asyncRewake === true, "sleeper hooks use asyncRewake");
  ok(JSON.stringify(s.hooks.PreToolUse).includes("echo other-hook"), "the existing hook is kept");
  ok(/autopilot\/statusline\.mjs/.test(s.statusLine.command), "status line points to the autopilot");
  ok(s.model === "opus", "unrelated settings are kept");
  const cfg = JSON.parse(fs.readFileSync(path.join(ap, "config.json"), "utf8"));
  ok(cfg.chainStatusLine?.command === "echo THEIRS", "the previous status line is chained");
  const skill = fs.readFileSync(path.join(dir, "skills", "autopilot", "SKILL.md"), "utf8");
  ok(!skill.includes("{{") && skill.includes(`${ap.split(path.sep).join("/")}/autopilot.mjs`), "skill installed with real paths");
  ok(md().startsWith("# Mine\nkeep this") && (md().match(/# Autopilot keep-alive/g) || []).length === 1, "keep-alive rule appended once, own content kept");
  ok(fs.readFileSync(path.join(ap, "watchdog.vbs"), "utf8").includes("CLAUDE_CONFIG_DIR"), "watchdog launcher carries the custom config folder");

  // the chained status line: theirs first, then nothing extra (no autopilot run in this session)
  const sl = spawnSync(process.execPath, [path.join(ap, "statusline.mjs")], {
    input: JSON.stringify({ session_id: "x", rate_limits: { five_hour: { used_percentage: 12, resets_at: now() + 3600 } } }),
    encoding: "utf8", env: { ...env, CLAUDE_CONFIG_DIR: dir }, windowsHide: true,
  });
  ok(sl.stdout.startsWith("THEIRS"), `chained status line output: "${sl.stdout}"`);

  // reinstall: idempotent, keeps a changed config value
  cfg.stopAt = 85;
  fs.writeFileSync(path.join(ap, "config.json"), JSON.stringify(cfg));
  r = install();
  s = settings();
  ok(r.status === 0 && ours(s) === 5, `reinstall keeps 5 hooks (${ours(s)})`);
  ok(JSON.parse(fs.readFileSync(path.join(ap, "config.json"), "utf8")).stopAt === 85, "reinstall keeps the user's config values");
  ok(JSON.parse(fs.readFileSync(path.join(ap, "config.json"), "utf8")).chainStatusLine?.command === "echo THEIRS", "reinstall does not chain the autopilot to itself");
  ok((md().match(/# Autopilot keep-alive/g) || []).length === 1, "keep-alive rule still once");

  // uninstall refuses while a run is active
  fs.writeFileSync(path.join(ap, "sessions", "run.json"), JSON.stringify({ sid: "run", active: true, phase: "running", taskDir: "C:/x/task" }));
  r = install("--uninstall");
  ok(r.status === 1 && /active/.test(r.stderr), "uninstall refuses during an active run");
  fs.rmSync(path.join(ap, "sessions", "run.json"));

  r = install("--uninstall");
  s = settings();
  ok(r.status === 0, "uninstall exits 0");
  ok(ours(s) === 0 && JSON.stringify(s.hooks.PreToolUse).includes("echo other-hook"), "autopilot hooks gone, other hook kept");
  ok(JSON.stringify(s.statusLine) === JSON.stringify(theirStatus), "the previous status line is restored exactly");
  ok(md().trim() === "# Mine\nkeep this", "keep-alive rule removed, own content kept");
  ok(!fs.existsSync(path.join(dir, "skills", "autopilot")), "skill removed");
  ok(!fs.existsSync(path.join(ap, "hook.mjs")) && fs.existsSync(path.join(ap, "config.json")), "scripts removed, config kept");

  r = install("--uninstall", "--purge");
  ok(r.status === 0 && !fs.existsSync(ap), "--purge deletes the autopilot folder");
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}
finish();
