# Gentle AI

[Gentle AI](https://github.com/Gentleman-Programming/gentle-ai) adds a
spec-driven development (SDD) workflow, subagents, skills, and review to coding
agents. It installs into each agent's own configuration, so threads get it
through whichever provider runs them: Claude, Codex, Cursor, OpenCode,
Antigravity, or Pi.

## Set up Gentle AI

Install Gentle AI on the machine that runs your projects and set it up for the
agents you use, following its own instructions. Pi gets it through the gentle-pi
package instead; see [Pi](./providers-pi.md#gentle-ai). Remote clients do not
need their own installation.

T3 Code shows Gentle AI only for the providers it is set up for. When it is set
up for at least one, **Settings > Gentle AI** shows its version, the providers
that run with it, and its preset, persona, and components. From there you can:

- **Sync** the agents' Gentle AI files after upgrading it, when settings show a
  sync is needed.
- Check for updates, **Upgrade**, and **Run doctor**.
- Set **Binary path** when `gentle-ai` is not on the environment's `PATH`. Left
  empty, T3 Code also finds the copy gentle-pi bundles.

On mobile, **Settings > Gentle AI** offers sync, update checks, and doctor. Set
the binary path and upgrade from web or desktop settings.

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
