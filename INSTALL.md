# Installing the autopilot (instructions for Claude Code)

The user asked you to install Autopilot for Claude Code. Follow these steps in order. Explain each step's outcome to the user in one line, in their language.

## 1. Check the machine

Run and check:

```bash
node -e "console.log(process.platform, process.versions.node)"   # needs win32 and >= 20.10
git --version
where.exe claude                                                   # expect ...\.local\bin\claude.exe
```

- **Not Windows:** stop and tell the user the autopilot is Windows-only.
- **Node older than 20.10:** stop and ask the user to update Node.js.
- **No `claude.exe`:** Claude Code was installed another way, e.g. with npm. Say that watchdog restarts need `claudeExe` in the config, and continue.

## 2. Get the code

Clone into a folder the user keeps. Default: `~/.claude/autopilot-src`, unless the user names another one.

```bash
git clone https://github.com/smiei/autopilot-for-claude-code ~/.claude/autopilot-src
```

If the folder exists already, run `git -C ~/.claude/autopilot-src pull` instead.

## 3. Ask about push notifications

Ask the user one question: should push notifications to their phone be turned on? They are needed for questions during a run; they change two Claude Code settings, `agentPushNotifEnabled` and `inputNeededNotifEnabled`. Recommend yes.

## 4. Run the installer

```bash
node ~/.claude/autopilot-src/install.mjs            # add --enable-push if the user said yes
```

Read the output.
- **Lines with `WARN`:** pass them on to the user.
- **A note that an existing status line is chained:** this is normal, the user's status line keeps working.

The installer backs up `settings.json` before changing it.

## 5. Tell the user how to use it

Tell the user, in their language:

1. The hooks become active in **new** sessions. This one does not have them yet.
2. Start a run in Windows Terminal, in the repository: `claude --remote-control <name> --permission-mode auto`, then `/autopilot <task>`.
3. Status at any time: `node ~/.claude/autopilot/autopilot.mjs status`.
4. Uninstall: `node ~/.claude/autopilot-src/install.mjs --uninstall`.

Point them to the README's "Terms of service" section once.
