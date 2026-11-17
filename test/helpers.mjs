// Test harness: every test gets its own temp folder with a fake Claude config dir (CLAUDE_CONFIG_DIR),
// a copy of the runtime, a scratch git repository and a task folder. Nothing touches the real install.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIME = ["lib.mjs", "hook.mjs", "statusline.mjs", "autopilot.mjs", "watchdog.mjs", "protocol.md"];

export const now = () => Math.floor(Date.now() / 1000);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fails = 0;
export function ok(cond, msg) { console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`); if (!cond) fails++; }
export function finish() { console.log(fails ? `${fails} FAILED` : "ALL PASSED"); process.exit(fails ? 1 : 0); }

export function cleanEnv(extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(AUTOPILOT_|CLAUDE_CONFIG_DIR$|CLAUDE_ENV_FILE$)/.test(k)));
  return { ...env, ...extra };
}

export function setup(name, { config = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `autopilot-test-${name}-`));
  const claudeDir = path.join(root, "claude");
  const ap = path.join(claudeDir, "autopilot");
  fs.mkdirSync(path.join(claudeDir, "sessions"), { recursive: true });
  fs.mkdirSync(path.join(ap, "sessions"), { recursive: true });
  for (const f of RUNTIME) fs.copyFileSync(path.join(ROOT, "runtime", f), path.join(ap, f));
  const defaults = JSON.parse(fs.readFileSync(path.join(ROOT, "runtime", "config.default.json"), "utf8"));
  fs.writeFileSync(path.join(ap, "config.json"), JSON.stringify({ ...defaults, notify: false, resumeGraceSec: 5, claudeExe: "C:/nonexistent/claude.exe", ...config }, null, 2));

  const repo = path.join(root, "repo");
  const task = path.join(repo, ".claude", "autopilot", "demo");
  fs.mkdirSync(task, { recursive: true });
  const git = (...a) => spawnSync("git", a, { cwd: repo, encoding: "utf8", windowsHide: true }).stdout.trim();
  git("init", "-q");
  git("config", "user.name", "test");
  git("config", "user.email", "test@localhost");
  fs.writeFileSync(path.join(repo, "README.md"), "test repo\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "init");
  fs.writeFileSync(path.join(task, "PLAN.md"), "# Demo\n- [ ] 1.1 one\n- [ ] 1.2 two\n");
  fs.writeFileSync(path.join(task, "PROGRESS.md"), "# Progress\nCurrent item: 1.1\n");
  fs.writeFileSync(path.join(repo, "wip.txt"), "work in progress\n");

  const env = cleanEnv({ CLAUDE_CONFIG_DIR: claudeDir });
  const run = (script, args = [], input = null, extra = {}) => spawnSync(process.execPath, [path.join(ap, script), ...args], {
    input: input == null ? "" : JSON.stringify(input), encoding: "utf8", cwd: repo, env, timeout: 300000, windowsHide: true, ...extra,
  });
  return {
    root, claudeDir, ap, repo, task, env, git, run,
    state: (sid) => JSON.parse(fs.readFileSync(path.join(ap, "sessions", `${sid}.json`), "utf8")),
    putState: (sid, s) => fs.writeFileSync(path.join(ap, "sessions", `${sid}.json`), JSON.stringify({ sid, active: true, taskDir: task, cwd: repo, phase: "running", ...s })),
    log: () => { try { return fs.readFileSync(path.join(ap, "log.txt"), "utf8"); } catch { return ""; } },
    cleanup: () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} },
  };
}
