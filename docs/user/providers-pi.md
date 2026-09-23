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

Set up credentials and other Pi preferences with Pi as usual. T3 Code reuses that
installation, including its credentials, models, skills, and custom commands.
Installed Pi extensions also run in T3 Code threads. If gentle-pi is installed,
its subagents appear in the thread's Agents panel with live progress and results.
The panel's stop and steer actions ask the parent Pi agent to use Gentle AI's
tools; check the conversation for the result of each request.
T3-managed Pi threads use Pi's native persisted sessions for resume behavior;
T3 Code does not discover or import arbitrary standalone Pi sessions.

In the web or desktop app, open **Settings > Providers**, select the environment,
and enable **Pi**. Pi must be on that environment's `PATH`. If it was installed by
a version manager or lives elsewhere, set **Binary path** to its executable.

Choose **Refresh provider status** after changing Pi configuration. The provider
card shows the detected version and status, and a refresh reloads Pi's current
model catalog. Mobile uses the same provider and models from the connected
environment; provider configuration remains in web or desktop settings.

## Gentle AI profiles and SDD

With gentle-pi 3.5 or newer installed for Pi, open **Settings > Providers > Pi**
and choose a project in the **Gentle AI** section. Create a profile, assign models
and effort to its subagents, then save it and choose **Use for project**. This
pins the profile to that Git repository. Other projects keep their own routing;
the main Pi model still comes from T3 Code's composer. Remove the local pin to
return to the repository declaration or Gentle AI's global routing.

For SDD, choose the project's execution mode, artifact store, delivery strategy,
and review budget, then save. These choices are reused as suggestions. In a Pi
thread for that project, run `/gentle:sdd-preflight` to confirm them for the
session or `/gentle-sdd-init` to start SDD.

## T3 Code tools

Each Pi thread automatically receives T3 Code's tools for that thread. No Pi
extension or MCP configuration is required. Tool access ends with the thread and
does not change your global Pi configuration.
