# Autopilot for Claude Code

Run a very large coding task with Claude Code unattended, across several 5-hour usage windows of a Pro or Max subscription.

- **Stops at 90 %** of the 5-hour limit (and of the weekly limit), so 10 % stay free for the Claude app and chat.
- **Pauses cleanly:** git snapshot, the model answers a single word, nothing breaks.
- **Keeps the prompt cache warm** during the pause with tiny keep-alive pings, so resuming does not rebuild a huge context from scratch.
- **Resumes by itself** in the same process right after the reset, until every item of the plan is done.
- **Asks you questions on your phone** through Remote Control in the Claude app, with a push notification.
- **Restarts crashed or stuck sessions** with a watchdog (Windows Task Scheduler, no tokens).

> Not affiliated with or endorsed by Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic.

## What a pause looks like

A run starts at 13:00 in a window that resets at 18:00. At 15:30 the 5-hour usage reaches 90 %:

| Time | What happens |
|---|---|
| 15:30 | The next tool call is denied, the model answers `PAUSE`. A git snapshot is written. A background hook starts sleeping. |
| 16:25 | Keep-alive: the model answers `.` - the 1-hour prompt cache is fresh again. |
| 17:20 | Second keep-alive. |
| 18:01 | The window has reset: `AUTOPILOT RESUME`, the model reads its progress file and continues, with a warm cache. |

A keep-alive in a test with an 84k-token context: 3 output tokens, 83,804 tokens read from the cache, 321 written. Pings happen only if the cache would expire before the reset, and only while the 5-hour usage stays below 95 % (the cost of the first ping is measured and used for the check).

## Requirements

- Windows 10/11 with Windows Terminal (the watchdog, toasts and process checks are Windows-only)
- Claude Code installed with the [native installer](https://code.claude.com/docs/en/setup) (`claude.exe`), logged in with a **Pro or Max** subscription (rate limits are reported only to subscribers)
- Node.js 20.10 or newer, git
- Runs in the **terminal CLI** only. The VS Code extension and the desktop app do not hand the rate limits to the status line.

## Install

**Easiest:** open Claude Code and say

> Install the autopilot from https://github.com/smiei/autopilot-for-claude-code - follow INSTALL.md.

**By hand:**

```
git clone https://github.com/smiei/autopilot-for-claude-code
cd autopilot-for-claude-code
node install.mjs
```

The installer:
- copies the scripts to `~/.claude/autopilot/`
- adds the hooks and the status line to `~/.claude/settings.json` (backup first). A status line of your own keeps running: the autopilot appends its segment to it.
- installs the skill `/autopilot`
- adds a three-line rule to `~/.claude/CLAUDE.md`
- registers the scheduled task `ClaudeAutopilotWatchdog`

It is idempotent: run it again after `git pull` to update; your `config.json` is kept.

For questions on your phone, turn on push once (in any Claude Code session):

```
/config agentPushNotifEnabled=true inputNeededNotifEnabled=true
```

or install with `node install.mjs --enable-push`.

## Use

1. Open Windows Terminal in your repository and start Claude Code with Remote Control:
   ```
   claude --remote-control <name> --permission-mode auto
   ```
2. Type `/autopilot <your large task>`.

   Claude settles open questions with you, writes `PLAN.md` (a checklist) and `PROGRESS.md` under `<repo>/.claude/autopilot/<slug>/` (excluded from git) and starts working.
3. Leave. In the Claude app the session shows up under `<name>`: watch it, answer questions, send messages - they take precedence over the plan.

**Scope of one run:** one `/autopilot` covers one plan. When every item is ticked the autopilot switches itself off and pushes "finished"; a follow-up prompt without `/autopilot` is ordinary Claude Code. Put everything into one plan rather than several small ones - spanning usage windows is the point.

**Continuing an existing chat:** `claude --resume <session-id> --remote-control <name> --permission-mode auto`, then `/autopilot ...`. Do not keep the same chat open in VS Code at the same time.

## Commands

`node ~/.claude/autopilot/autopilot.mjs <command>`

| Command | Effect |
|---|---|
| `status` | phase, progress, usage, process and next wake of every autopilot session |
| `hold` / `resume` | hold the autopilot / let it run again |
| `off` | switch the autopilot off for a session |
| `resume-now` | end a pause early (only if the limits allow it) |
| `log [n]` | last lines of the log (`~/.claude/autopilot/log.txt`) |
| `checkpoint` | git snapshot to `refs/autopilot/...` now (working tree, index and branch stay untouched) |
| `simulate <used%> <min> [--ttl <min> --lead <min>]` / `simulate off` | test the pause logic with simulated usage |
| `help` | all commands |

The status line shows the same in one line: `5h 42% ↻14:30 · 7d 18% · ctx 35% · AP running (3/12)`.

## How it works

| Piece | Job |
|---|---|
| **status line** | The only token-free source of `rate_limits` and `prompt_cache.expires_at`. Writes them to `usage.json`. |
| **SessionStart hook** | Exports the session id. Injects the work protocol into autopilot sessions, also after every compaction. |
| **PreToolUse hook** | Checks the limits before every tool call. Over the threshold it pauses: snapshot, toast, deny with "reply only PAUSE". Parallel tool calls of the same response get a plain deny. Only a new response that ignores the pause gets the hard brake (`continue: false`), because that skips the Stop hooks and leaves the resume to the watchdog. |
| **Stop hook (sync)** | Sends the model on while PLAN.md has open items. Three stops without progress set `needs_attention`. |
| **Stop / StopFailure hook (`asyncRewake`)** | The sleeper. Wakes the same process with `AUTOPILOT KEEPALIVE` five minutes before the cache expires and with `AUTOPILOT RESUME` after the reset. After a hard 100 % stop, StopFailure wakes the session too. |
| **watchdog** | Task Scheduler, every 10 minutes, no tokens. Restarts the session with `claude --resume <id> --model <its model> --remote-control ...` when the process is gone, a pause has no sleeper, or the session sits idle with open work. When a session waits on a question or a startup dialog, it sends a toast. |

Only sessions that ran `/autopilot` are affected: in every other session the hooks exit after a single file check.

## Configuration

`~/.claude/autopilot/config.json`:

| Key | Default | Meaning |
|---|---|---|
| `stopAt` / `weeklyStopAt` | 90 | pause threshold in % of the 5-hour / weekly limit |
| `pingCeiling` | 95 | no keep-alive pings once usage plus the measured ping cost would exceed this |
| `pingLeadMin` / `cacheTtlMin` | 5 / 60 | ping this many minutes before the cache expires / cache TTL (subscriptions get 1 h) |
| `resumeGraceSec` | 90 | wait this long after the reset before resuming |
| `permissionMode` | `auto` | permission mode for watchdog restarts |
| `remoteControl` | `true` | restart with `--remote-control` so the session stays reachable from the phone |
| `model` | `null` | force a model for restarts (default: the model the session used) |
| `cleanupPorts` | `null` | e.g. `[3100, 3199]`: processes listening there are stopped when a pause starts. The model is told to run dev servers only in that range. |
| `stallMinutes` | 20 | an idle session with open work is restarted after this long |
| `maxRelaunchesPerWindow` | 3 | then the watchdog stops and notifies you |
| `checkpointsToKeep` | 20 | snapshot refs per session |
| `notify` | `true` | Windows toasts |
| `claudeExe` | detected | path to `claude.exe`, used for restarts |

## Limits and caveats

- **The threshold is approximate.** Limits are checked before each tool call, so one long answer can overshoot by a point or two.
- **Startup dialogs block restarts.** A new project MCP server, a model choice or a trust prompt stops a restarted session. The watchdog only notifies you. Start every new repository once yourself.
- **Undocumented internals.** The autopilot relies on Claude Code behaviour that is not formally documented: the session registry in `~/.claude/sessions/`, `asyncRewake` waking an idle session, the status line's `rate_limits` / `prompt_cache` fields. A Claude Code update may break it. Run `npm test` after updates of this repository; watch the first pause after Claude Code updates.
- **Tested:** in-process pause, keep-alive and resume against simulated limits, watchdog restart after a killed process, questions answered on the phone, StopFailure wake-ups with provoked API errors. A real 100 % hard stop could not be provoked on demand.

## Terms of service

Read this before you use it; it is not legal advice.

- **What it uses:** only official Claude Code features - hooks, the status line, `--resume`, Remote Control and push notifications - in Anthropic's own client. It does not bypass usage limits; it stops below them.
- **The automation clause:** Anthropic's [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) forbid access "through automated or non-human means, whether through a bot, script, or otherwise", except with an API key or "where we otherwise explicitly permit it". Claude Code itself offers unattended features (auto mode, `/loop`, scheduled tasks). Whether a hook-driven unattended run counts as permitted is not spelled out.
- **Interactive vs. programmatic use:** since June 2026, `claude -p` and the Agent SDK draw from a separate monthly credit, while subscription limits are meant for interactive use ([Help Center](https://support.claude.com/en/articles/15036540-use-the-claude-plan-usage-limits)). The autopilot runs in the interactive client, but unattended.
- **Use it moderately:** one session per account, no loops without real work. Never share accounts.

Anthropic can change its terms and limits at any time.

## Uninstall

```
node install.mjs --uninstall          # keeps config, state and log
node install.mjs --uninstall --purge  # deletes ~/.claude/autopilot completely
```

Your previous status line is restored. Push settings stay as they are.

## Development

```
npm test        # about 3 minutes; runs in temp folders with a fake Claude config dir
```

`runtime/` holds the scripts that end up in `~/.claude/autopilot/`, `skill/` the `/autopilot` skill, `install.mjs` the installer. Simulate a pause in a real session: `autopilot simulate 91 3 --ttl 3 --lead 1`.

## License

[MIT](LICENSE)
