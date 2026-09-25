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
Installed Pi extensions also run in T3 Code threads. If gentle-pi is installed,
its subagents appear in the thread's Agents panel with live progress and results.
The Agents panel shows their live status and recent transcript. Gentle AI does
not currently expose direct subagent controls to Pi RPC hosts.
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

## Gentle AI profiles and SDD

Choose **Install Gentle AI** in **Settings > Providers > Pi**, or **Update** next
to its version to upgrade. This runs `pi install npm:gentle-pi` or
`pi update npm:gentle-pi` on the project environment. Remote clients do not need
their own installation.

With gentle-pi 3.5 or newer installed for Pi, open **Settings > Providers > Pi**
to choose the global persona and manage model profiles. The active global profile
applies unless the repository declares one or the local clone has a pin. The
**Project overrides** section shows which source applies and lets you pin a
profile or override the persona. The main Pi model stays in T3 Code's composer.
Changes to routing and persona take effect when a Pi session starts or reloads.
The optional **Gentle AI binary path** uses the copy bundled with gentle-pi when
left empty. Refreshing Providers also reloads Gentle AI settings changed
outside T3 Code. On mobile, project profile and persona controls are in
**Project overview**.

For a new Pi thread, open the Gentle AI dropdown and clear **Enable** to run
without Gentle AI. The choice is stored with the thread when you send its first
message, and the dropdown then shows whether Gentle AI is on for that thread.
Other installed Pi extensions remain available.

For SDD, set the project's execution mode, artifact store, delivery strategy,
and review budget in Pi settings; on mobile, they are in **Project overview**.
They are saved in the project's `.pi/gentle-ai/sdd-preflight.json`. Commit that
file so the whole team uses the same choices. A profile pinned for a checkout
stays on your machine.

In a Pi thread, open the Gentle AI dropdown and choose **Set up SDD** once per
project. After that, **SDD changes** lists the project's active OpenSpec changes
with their next phase and task progress. Choose a change's action, such as
**Implement**, to open a new thread with Gentle AI on and that phase's request
already written; review it and send. **New change** opens a thread for proposing
another change. Changes are listed for projects that save SDD artifacts as
OpenSpec files.

## T3 Code tools

Each Pi thread automatically receives T3 Code's tools for that thread. No Pi
extension or MCP configuration is required. Tool access ends with the thread and
does not change your global Pi configuration.
