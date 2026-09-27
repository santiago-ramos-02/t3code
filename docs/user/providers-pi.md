# Pi

T3 Code uses the Pi installation and configuration already present on the selected
environment. Pi 0.86.1 or newer is required. There is no separate T3 Code sign-in
or provider-managed installation.

## Set up Pi

Install Pi on the machine that runs your projects, not on the phone or remote
browser you use to control T3 Code:

```bash
npm install -g @earendil-works/pi-coding-agent@latest
pi --version
```

Set up credentials and other Pi preferences with Pi as usual. Pi can use several
upstream model providers. Run `pi` on the project environment and use `/login`
to connect one, or set that provider's API key in **Settings > Providers > Pi >
Environment**. T3 Code reuses Pi's configuration and shows its available model
providers and models in Pi settings. Select any of those models in
T3 Code's model picker. Models registered by a project-local Pi extension appear
in that project's picker. T3 Code also reuses Pi's skills and custom commands.
Installed Pi extensions also run in T3 Code threads, and their questions and
confirmations appear in the thread.
T3-managed Pi threads use Pi's native persisted sessions for resume behavior;
T3 Code does not discover or import arbitrary standalone Pi sessions.

In the web or desktop app, open **Settings > Providers**, select the environment,
and enable **Pi**. Pi must be on that environment's `PATH`. If it was installed by
a version manager or lives elsewhere, set **Binary path** to its executable. While
Pi is missing or has no model provider yet, the Pi card's **Setup** section shows
the command to run.

Choose **Refresh provider status** after changing Pi configuration. The provider
card shows the detected version, available model providers, and status. A refresh
reloads Pi's current available model catalog after changing credentials.
Mobile uses the same provider and models from the connected environment. Set
Pi's binary path and credentials in web or desktop settings.

## Gentle AI

[Gentle AI](https://github.com/Gentleman-Programming/gentle-shell) is an
optional Pi package. T3 Code shows its controls only when Pi on the project
environment loads it, globally or for that project. Install it with Pi, for
example `pi install npm:gentle-pi`, then choose **Refresh provider status**.
Remote clients do not need their own installation. When an installed copy is
older than 3.5, **Settings > Providers > Pi** offers to update it.

Its subagents appear in the thread's Agents panel with live progress and
results, and its todo list appears as the composer's task progress while the
turn runs. Its slash commands work in threads; commands that report a result,
such as `/gentle:status` or `/gentle:doctor`, show it in the thread. Commands
that only drive Pi's terminal interface, such as `/gentle:profiles`, are not
offered; T3 Code's own profile and model routing settings replace them.

Open **Settings > Providers > Pi**
to choose the global persona and manage model profiles. The active global profile
applies unless the repository declares one or the local clone has a pin. The
**Project overrides** section shows which source applies and lets you pin a
profile or override the persona. As in Pi, activating a profile also makes its
`orchestrator` entry Pi's default model. Changes to routing and persona take
effect when a Pi session starts or reloads.

To switch profiles from a Pi thread, open the Gentle AI dropdown and choose one
under **Profile**. This applies it the way Pi's `/gentle:profiles` does: it
becomes the active profile, or, if the project has a pin, the pin moves to it.
The thread also switches to the profile's orchestrator model and thinking level
for its next message. You can still pick a different model for the thread
afterward. Choosing the current profile again moves the thread back to its
orchestrator. A profile without an orchestrator keeps the thread's model.
The optional **Gentle AI binary path** uses the copy bundled with gentle-pi when
left empty. Refreshing Providers also reloads Gentle AI settings changed
outside T3 Code. On mobile, project profile and persona controls are in
**Project overview**.

For a new Pi thread, open the Gentle AI dropdown and clear **Enable** to run
standalone Pi without Gentle AI. The choice is stored with the thread when you
send its first message, and the dropdown then shows whether Gentle AI is on for
that thread. Other installed Pi extensions, skills, and prompts remain
available; Gentle AI's own commands and skills are not offered in that thread.

In a Pi thread, open the Gentle AI dropdown and choose **Set up SDD** once per
project, including a new empty folder. Setup asks for the project's execution
mode, artifact store, delivery strategy, and review budget, then prepares the
project. Engram memory needs an Engram extension for Pi, such as gentle-engram;
without one, Gentle AI saves artifacts as OpenSpec project files instead and
setup tells you. The choices are saved in the project's
`.pi/gentle-ai/sdd-preflight.json`. Commit that file so the whole team uses the
same choices. Change them later from **SDD preferences** in the same dropdown or
in Pi settings; on mobile, also in **Project overview**. The first time each
thread uses SDD, Gentle AI asks you to confirm the choices. A profile pinned for
a checkout stays on your machine.

After setup, **SDD changes** lists the project's active changes with their next
phase and task progress. Choose a change's action, such as **Implement**, to
open a new thread with Gentle AI on and that phase's request already written;
review it and send. **New change** opens a thread for proposing another change.
Planning requests stop once the tasks are written, even in automatic mode;
implementation starts only when you choose **Implement** or ask for it. Changes
are listed when the project saves artifacts as project files; ask Gentle AI in
a thread about changes kept only in Engram memory.

## T3 Code tools

Each Pi thread automatically receives T3 Code's tools for that thread. No Pi
extension or MCP configuration is required. Tool access ends with the thread and
does not change your global Pi configuration.
