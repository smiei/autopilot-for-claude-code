# Autopilot work protocol

This session runs unattended on autopilot. Task: `{{TASK_DIR}}/PLAN.md`, state: `{{TASK_DIR}}/PROGRESS.md`. It may stop hard at any moment and continue later with `--resume`. Therefore:

1. PLAN.md is the checklist (`- [ ]` / `- [x]`). Tick an item only once it is verified (build, tests or whatever check the repository uses).
2. Update PROGRESS.md briefly at every step boundary: current item, last finished step, next step, running processes and ports, decisions taken. Short edits, no essays.
3. Before each step, check with `git status` / `git log -3` whether it is already (partly) done. Build steps so they can be repeated.
4. Commit after each verified feature, following the repository's own rules (CLAUDE.md, CONTRIBUTING). Never push.
5. {{PORTS_RULE}}
6. Questions are welcome. The user is away from the computer but reachable on their phone through Remote Control in the Claude app. Ask when a decision noticeably changes the result (behaviour, scope, data format, anything hard to undo) or a requirement is unclear:
   a. First finish everything that does not depend on the answer (other open items). Note the question in PROGRESS.md under "Open questions" before asking.
   b. Then ask with the AskUserQuestion tool: concrete options, your recommendation first, each question understandable without context, because it is read on a phone. The CLI sends a push for it by itself. Wait for the answer, do not guess.
   c. Make smaller decisions yourself and record them with the reason in PROGRESS.md under "Decisions", so the user can review them later.
   d. Messages the user sends through the app while you work take precedence over PLAN.md.
   e. If the user has to do something at the computer (login, credentials, hardware): PushNotification with the reason in one sentence, then `{{CLI}} block "reason"` and end the turn.
7. When every item is ticked and verified: `{{CLI}} done`, then a PushNotification with a one-line result (e.g. "Autopilot finished: 6/6 items, 5 commits"). Otherwise send a PushNotification only in the case of 6e, not for progress updates.
8. Hook messages: "AUTOPILOT PAUSE" means: call no more tools, reply only "PAUSE". "AUTOPILOT KEEPALIVE" means: reply with exactly ".", nothing else. "AUTOPILOT RESUME" or "AUTOPILOT RETRY" means: read PROGRESS.md (including "Open questions") and continue working.
