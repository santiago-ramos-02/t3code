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

With a gentle-ai that has the headless API, the page manages Gentle AI the way
its own menu does, on the environment it runs on:

- **Setup** chooses the agents, persona, preset, components, and the options
  gentle-ai asks for, then installs.
- **Updates** checks for new versions and upgrades, with or without a sync.
  **Sync** rewrites Gentle AI's files in every agent it set up.
- **Models** picks a preset or each role's model for Claude Code, Codex, Kiro,
  and OpenCode.
- **Custom agents** has an installed agent write a new one from your
  description, then installs it.
- **Community tools**, **OpenCode plugins**, **Receipt-driven development**,
  and the **Review store** match gentle-ai's own options.
- **Backups** restores, renames, pins, or deletes the snapshots gentle-ai takes
  before changing files. **Uninstall** removes what it set up.

Long tasks run on the environment and show their progress on the page, so you
can leave and come back, or follow them from another device. Setting up and
other multi-step tasks open in place of the page; the back arrow returns to it.

With an older gentle-ai, the page offers sync, update checks, upgrade, and
doctor. Set **Binary path** when `gentle-ai` is not on the environment's `PATH`.
Left empty, T3 Code also finds the copy gentle-pi bundles.

On mobile, **Settings > Gentle AI** shows task progress and offers updates,
sync, model presets, and backups. Set up Gentle AI, customize models, and
create agents from web or desktop.

## Turn Gentle AI off for a thread

In a new thread, open the Gentle AI dropdown in the composer and clear
**Enable**. The thread's agent then runs on your own configuration without
anything Gentle AI added: its instructions, subagents, skills, commands, hooks,
and MCP servers. Your own settings, sign-in, and history are unchanged, and
Gentle AI stays on for your other threads. The choice is stored with the thread
when you send its first message.

A few setups cannot run without Gentle AI:

- Cursor on macOS, where its sign-in is tied to your home folder.
- OpenCode connected to an external server, which loads its own configuration.

In a Claude thread with Gentle AI off, your own skills and commands are
available under the `user:` prefix, for example `/user:deploy`.

## SDD changes

Gentle AI 3.7 and earlier offer spec-driven development (SDD). Newer releases
replace it with Organic Driven Development (ODD), which needs no setup, so the
items below appear only with a Gentle AI that still has SDD.

Open the Gentle AI dropdown and choose **SDD changes** to see the project's
active changes with their next phase and task progress. Choose a change's
action, such as **Implement**, to open a new thread with Gentle AI on and that
phase's request already written; review it and send. **New change** opens a
thread for proposing another change. Planning requests stop once the tasks are
written; implementation starts only when you choose **Implement** or ask for
it.

The first time a thread uses SDD, Gentle AI asks for the project's SDD choices
in the thread, and sets the project up if it has not been. Pi threads set these
choices once per project instead, with **Set up SDD**.

Changes are listed when the project saves artifacts as OpenSpec project files.
Ask Gentle AI in a thread about changes kept only in Engram memory.
