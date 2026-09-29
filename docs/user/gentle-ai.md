# Gentle AI

[Gentle AI](https://github.com/Gentleman-Programming/gentle-ai) adds a
development workflow, subagents, skills, memory, and review to coding agents. It installs into each agent's own configuration, so threads get it
through whichever provider runs them: Claude, Codex, Cursor, OpenCode,
Antigravity, or Pi.

## Set up Gentle AI

Install Gentle AI on the machine that runs your projects and set it up for the
agents you use, following its own instructions. Pi gets it through the gentle-pi
package instead; see [Pi](./providers-pi.md#gentle-ai). Remote clients do not
need their own installation.

**Settings > Gentle AI** appears once gentle-ai is installed on a connected
environment, or a provider runs with it. What it offers depends on the gentle-ai
version.

With a gentle-ai that has the headless API, the page manages Gentle AI on the
environment it runs on:

- The top row says whether Gentle AI is up to date. **Update** appears when
  Gentle AI or its tools have a new version, and also brings your agents' files
  up to date; **Sync** appears when only the files are behind.
- **Your agents** lists the agents Gentle AI is set up in, each with the profile
  or model preset it runs and a switch for it. **Add agent** sets Gentle AI up
  in another agent found on the environment, with the setup your other agents
  use. **Open** shows one agent's page: its models or profiles, its plugins,
  gentle-pi's persona and project overrides for Pi, and removing Gentle AI
  from that agent alone. Pi's **Claude Bridge** plugin runs Claude models in Pi
  on your Claude Pro or Max subscription through Claude Code, so sign in to
  Claude Code first; Pi must not have `ANTHROPIC_BASE_URL` or an Anthropic key
  set, or its requests go there instead.
- **Review** turns on an independent review of agents' code changes before
  delivery, and, for the project picked in its header, turns it off there or
  clears its review history.
- **More** holds what you set once: the setup every agent shares (persona,
  preset, and components), custom agents written from your description,
  project tools such as CodeGraph, backups of the files Gentle AI changed, a
  health check, re-syncing, and removing Gentle AI from some or all agents.

Long tasks run on the environment and show their progress at the top of the
page, so you can leave and come back, or follow them from another device.
Setting up and other multi-step tasks open in place of the page; the back arrow
returns to it.

With an older gentle-ai, the page offers sync, update checks, upgrade, and
doctor. Set **Binary path** when `gentle-ai` is not on the environment's `PATH`.
Left empty, T3 Code also finds the copy gentle-pi bundles.

On mobile, **Settings > Gentle AI** shows task progress, updates, sync, your
agents with their model presets and Claude Code profile, and backups. Add or
remove agents, edit profiles and models, and create agents from web or desktop.

## Other models in Claude Code

Claude Code picks one of four model slots, `fable`, `opus`, `sonnet`, and `haiku`, each
time it hands work to a subagent. Through a proxy that serves other providers' models,
such as [CLIProxyAPI](./cli-proxy.md), a Claude Code profile sets which model each slot
really runs and tells Claude what each slot is for, so it chooses a model per task: for
example Opus for design, Sonnet for code, and an inexpensive model behind `haiku` for
bounded tasks. Switch profiles from Claude Code's row under **Your agents**, and create or
edit them from **Open**, then **Edit** next to **Profile**; the slot choices are the models your proxied Claude Code
providers serve. Keep one profile per situation, such as one for when an account is near
its usage limit, and switch when it is; **None** puts Claude Code's own models back.

A profile applies only to Claude Code providers that go through a proxy, such as the
CLIProxyAPI provider that **Use in T3 Code** adds. Claude Code that reaches Anthropic
directly keeps its own models, and nothing changes in `~/.claude`. A profile can also pin
Gentle AI's phases to slots; phases are shared by every Claude Code, so a phase pinned to
`haiku` runs whatever `haiku` is on the provider running it.

## Turn Gentle AI off for a thread

In a new thread, open the Gentle AI dropdown in the composer and clear
**Enable**. The thread's agent then runs on your own configuration without
anything Gentle AI added: its instructions, subagents, skills, commands, hooks,
and MCP servers. Your own settings, sign-in, and history are unchanged, and
Gentle AI stays on for your other threads. The choice is stored with the thread
when you send its first message. What gets left out is exactly what removing
Gentle AI from that agent would take out, so an agent Gentle AI has not set up
runs as it always does.

A few setups cannot run without Gentle AI:

- Cursor on macOS, where its sign-in is tied to your home folder.
- OpenCode connected to an external server, which loads its own configuration.

In a Claude thread with Gentle AI off, your own skills and commands are
available under the `user:` prefix, for example `/user:deploy`.

## Feature documents

With Organic Driven Development (ODD), Gentle AI keeps larger work in a feature
document under the project's `odd/tasks/` folder: the objective, scope, tasks
with acceptance criteria, and progress.

Open the Gentle AI dropdown in the composer and choose **Feature documents** to
see the project's features with their task progress and next step. Choose one
to continue it in a new thread, where Gentle AI resumes from the document.
**New spec** opens a thread that asks Gentle AI to write only the feature
document for a feature you describe, without changing code. This lets someone
who plans work, such as a product manager, write specs that others then build.

The list appears with a gentle-ai that reports feature documents. ODD replaced the
earlier spec-driven development (SDD) workflow and needs no setup.
