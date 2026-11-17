# Changelog

## 1.0.0

First public version.

- Pause at 90 % of the 5-hour and the weekly limit, with a git snapshot and an optional port cleanup.
- In-process keep-alive pings while the prompt cache would expire before the reset, with a measured budget check.
- Resume in the same process after the reset; StopFailure wake-up after a hard limit stop.
- Questions through AskUserQuestion and Remote Control, push notifications for questions and the finished run.
- Watchdog (Task Scheduler): restarts with the session's own model and Remote Control, detects idle sessions and startup dialogs.
- Installer with a chained status line, idempotent updates and a clean uninstall.
