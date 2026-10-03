# Memory

Memory shows what your agents remember between sessions. It reads
[Engram](https://github.com/Gentleman-Programming/engram), the memory agents use when Gentle AI
sets it up. Open **Memory** from the sidebar or the command palette, or press `mod+shift+u` on web
and desktop when the terminal is not focused. Customize `memory.open` in
**Settings → Keybindings**.

Memory appears once a connected environment has Engram installed. Install it with Gentle AI in
**Settings → Gentle AI**. T3 Code starts Engram's local server on that environment when it is not
already running, so there is nothing else to configure. With several environments, pick one in the
breadcrumb.

## Read what agents remember

- **Brain map** draws each memory as a dot. Blue dots are decisions, orange dots are findings such
  as fixes and discoveries, and green dots are session summaries. Lines join related memories;
  faint lines join memories saved in the same session. A faded dot was replaced by a newer memory.
  Switch to **List** to read the same memories as a table.
- **Search** finds memories by what they say. Filter by type, or pick a project in the header to
  narrow everything on the page.
- **Recent sessions** shows each session's summary.
- Click any memory to read it in full, with its relations and what was saved around it.

The map shows the newest 600 memories. Pick a project to see older ones, or search.

## Settle memories that disagree

When a new memory may contradict an older one, Engram asks for a verdict. **Needs your call** lists
each pair. Choose **First replaces second**, **They contradict**, **Both hold**,
**Different situations**, or **Unrelated**. Engram records the verdict for the agents that recall
either memory.

The line under the header shows Engram's own health check and, when something is wrong, what to do
about it.

## In threads

When an agent saves, updates, searches, or reads a memory, the activity log says what it saved or
searched for. Choose **Open in Memory** to see that memory. The thread details panel lists the
memories saved in the thread.

## Export to Obsidian

Choose **Export to Obsidian** and enter the vault folder on that environment. On desktop, choose
**Choose…** to pick a folder on this computer. Each memory becomes a note linked to its session. Exporting again adds only what is new. When a project is picked in the
header, only that project's memories are exported.
