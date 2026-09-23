# Overcode for Android Studio

This standalone IntelliJ Platform plugin adds a small native Android Studio surface for configuring Overcode through
JetBrains AI Assistant's Agent Client Protocol (ACP) support.

## Current Features

- **Overcode tool window**: Open it from the **Tools** menu to see the current project and integration guidance.
- **Install ACP config**: Creates `~/.jetbrains/acp.json` when it does not exist.
- **Copy config**: Copies the ACP entry without changing an existing configuration.
- **Tools actions**: Both opening the tool window and installing the configuration are available from the **Tools** menu.

The plugin intentionally does not add a second chat UI, custom project prompts, FTC generators, robot lookup, or hardware
assumptions. Overcode remains responsible for its normal agent behavior, including goal loops, `goal_control`, and queued
messages.

If `acp.json` already exists, the plugin never overwrites it. The **Copy config** action provides the Overcode entry for
manual merging.

## Target

The build targets Android Studio Quail 3 `2026.1.3.7` on IntelliJ Platform build `261`. Use the matching Android Studio
release for `runIde` and manual verification. The plugin is restricted to the `261.*` build line because IntelliJ API
compatibility follows the IDE build.

## Build And Test

From this directory:

```powershell
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
.\gradlew.bat clean check verifyPlugin buildPlugin --no-daemon
```

The installable ZIP is written to `build/distributions`. To launch a sandbox IDE:

```powershell
.\gradlew.bat runIde --no-daemon
```

In the sandbox, open any project, use **Tools > Open Overcode**, and verify that the tool window opens. Use **Install ACP
config** with an empty home configuration, then verify the generated `~/.jetbrains/acp.json`. With Android Studio's AI
Assistant enabled, select the **Overcode** agent and verify that normal Overcode conversations retain goal-loop and queued-
message behavior.

## Roadmap

Future work can add richer status inspection only if JetBrains exposes a stable ACP session API. The plugin should continue
to avoid duplicating Overcode's agent protocol or maintaining a second goal-loop implementation.
