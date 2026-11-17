---
name: autopilot
description: Run a very large coding task unattended across several 5-hour usage windows. Pauses at 90 % of the limit, keeps the prompt cache warm during the pause, continues by itself after the reset and asks questions through the Claude app. Only when the user types /autopilot.
argument-hint: <description of the large task>
disable-model-invocation: true
---

# /autopilot - work through a large task unattended

The user's task: $ARGUMENTS

The mechanics (stop at 90 %, keep-alive pings, resume after the reset, watchdog) run in hooks and scripts in `{{AP_HOME}}`. Your job is the plan and the work, not the mechanics.

## 1. Check the preconditions (Bash)

```bash
echo "session=$AUTOPILOT_SESSION_ID"; {{CLI}} status
```

If `session=` is empty, the hooks are not active: tell the user to run the installer (see the autopilot README) and stop. If the session runs in the VS Code extension or the desktop app, `autopilot start` will refuse later, because only the terminal CLI receives the rate limits. In that case tell the user to start `claude --remote-control <name> --permission-mode auto` in Windows Terminal and stop.

## 2. Clarify while the user is still here

Settle now, in one bundled question, whatever can be settled now: at the computer it is most convenient. Questions during the run are still welcome. They go to the Claude app on the user's phone through AskUserQuestion, with a push (protocol item 6). For that the session must run with `--remote-control`. `autopilot start` warns if that or the push settings are missing.

## 3. Write the plan

Folder: `<git root>/.claude/autopilot/<short-slug>/`.

**PLAN.md**: the single source of "done".
- Goal and scope in two or three sentences.
- One heading per feature with acceptance criteria and small steps as a checklist `- [ ]`.
- Each step fits in one go, at most about 30 to 60 minutes of work.
- The last step of each feature is "verified and committed".
- Order the features so that every finished feature leaves a working state.

**PROGRESS.md** with this skeleton:

```markdown
# Progress
Current item: 1.1
Last finished step: -
Next step: <concrete>
Running processes/ports: none
## Open questions
## Decisions
## Notes
```

## 4. Activate

```bash
{{CLI}} start "<folder>"
```

If this fails with a message (for example no status line data yet), pass the message on to the user and stop. If it only prints a `NOTE` (Remote Control, push settings), tell the user right away: they can fix it while they are still here.

## 5. Work

Read `{{AP_HOME}}/protocol.md` and follow it. It is also injected at every session start and after every compaction.

Then start with item 1 and work through the plan. Ask questions as protocol item 6 says, not as text at the end of a turn. A Stop hook sends you on while items are open. Follow hook messages that start with `AUTOPILOT` exactly.
