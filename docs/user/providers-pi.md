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
a version manager or lives elsewhere, set **Binary path** to its executable.

Choose **Refresh provider status** after changing Pi configuration. The provider
card shows the detected version, available model providers, and status. A refresh
reloads Pi's current available model catalog after changing credentials.
Mobile uses the same provider and models from the connected environment. Set
Pi's binary path and credentials in web or desktop settings.

## Gentle AI profiles and SDD

Install the latest Gentle AI package on the project environment with
`pi install npm:gentle-pi`. If it is already installed, run
`pi update npm:gentle-pi` to upgrade it. T3 Code uses that environment's
installed package; remote clients do not need their own installation.

With gentle-pi 3.5 or newer installed for Pi, open **Settings > Providers > Pi**
and choose a project in the **Gentle AI** section. Create a profile, assign models
and effort to its subagents, then save it. **Use globally** makes it the default
for projects without a pin. **Use for project** pins it to that Git repository;
removing a local pin restores the repository declaration or global profile.
The main Pi model still comes from T3 Code's composer. The **Persona for this
project** setting chooses Gentleman or Neutral, or inherits Gentle AI's global
persona. Profile routing and persona changes take effect when Pi reloads or a
new session starts. On mobile, open the project's **Project overview** to choose
the global profile, pin a profile, or set its persona. Edit subagent model
routing in web or desktop settings. Refreshing Providers also reloads Gentle AI
settings changed outside T3 Code.

For SDD, choose the project's execution mode, artifact store, delivery strategy,
and review budget, then save. These choices are reused as suggestions. In a Pi
thread for that project, **Set up SDD** runs Gentle's installed setup command
directly in the Pi session when the project needs it. **Gentle AI > View SDD
status** shows the next phase and any prerequisites. To begin or continue a
change, describe the work in the normal composer. In web or desktop,
**Gentle AI > Project SDD defaults** opens the current project's provider settings.
In an idle Pi thread, **Gentle AI > Review SDD choices** opens Gentle's preflight
editor directly.
On mobile, save SDD choices from **Project overview**. Gentle AI confirms
saved choices at the start of each Pi session.

## T3 Code tools

Each Pi thread automatically receives T3 Code's tools for that thread. No Pi
extension or MCP configuration is required. Tool access ends with the thread and
does not change your global Pi configuration.
