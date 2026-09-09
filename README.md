# Worktree from Linear — herdr plugin

Keybind, pick an active Linear issue from your team, and herdr opens a git
worktree on the issue's Linear branch, based on your default branch. Worktree
only — pair it with
[worktree-setup](https://github.com/tdi/herdr-worktree-setup) to run per-repo
setup on `worktree.created`.

## Install

```bash
herdr plugin install tdi/herdr-worktree-from-linear
```

## Prerequisites

- **`fzf`** — the fuzzy picker (`brew install fzf`). Required for the intended
  overlay; without it a plain numbered prompt is used.
- **`glow`** — optional (`brew install glow`); renders the issue pane's markdown.
  Without it the pane prints the same plain-text panel as before.
- **A Linear personal API key for each workspace** — Linear → Settings →
  Security & access → API → create a personal key. Export each key under an
  environment-variable name, then configure the plugin to select that name by
  repository path (below).
- **`git`** and **Node.js** (herdr invokes `node`). No `gh` needed.

## Configure

`config.json` in the plugin config dir (`herdr plugin config-dir tdi.worktree-from-linear`):

```json
{
  "linearApiKeyEnvByTeam": {
    "HSYS": "LINEAR_API_KEY_HSYS",
    "IC": "LINEAR_API_KEY_EMBER"
  },
  "linearApiKeyEnvByPath": [
    { "contains": "hsys", "env": "LINEAR_API_KEY_HSYS" }
  ],
  "linearApiKeyEnvDefault": "LINEAR_API_KEY_EMBER",
  "issueLimit": 50,
  "base": "default",
  "teamKey": "BIT",
  "assignedToMe": true,
  "includeTriage": true,
  "placement": "right",
  "fzfLayout": "down",
  "showIssueDetails": true,
  "issueTabLabel": "Work",
  "issuePaneLabel": "Issue",
  "popupWidth": "80%",
  "popupHeight": "70%"
}
```

- `linearApiKeyEnvByTeam` — optional uppercase issue-team to environment-variable
  map for the issue-details pane. `HSYS-4619` selects `HSYS` even outside Git or
  when focused on a different checkout. An unmapped team fails explicitly. When
  no legacy inline `linearApiKey` is set, a missing selected environment key
  also fails rather than trying another workspace. Remove that legacy inline
  key to enable per-team credential selection; otherwise it still overrides
  the selected environment key for mapped teams, for backward compatibility.
  This does not combine workspace issue lists in the worktree picker. Map every
  team whose issues can be selected: a third team may appear through the picker's
  repository route but its detail pane will refuse to load until that team is mapped.
- `linearApiKeyEnvByPath` — optional ordered path rules for selecting an API
  key environment variable. The first rule whose `contains` substring appears
  in the repository root wins; matching is case-insensitive.
- `linearApiKeyEnvDefault` — the environment-variable name used when no path
  rule matches. This supports a small exception list with one common default.
- `linearApiKey` — legacy key value. Existing configs remain supported and an
  explicit value still takes precedence, but new configs should keep key values
  out of `config.json` and use the environment-variable options above.
- `issueLimit` — max issues listed (default 50).
- `base` — where the new branch starts: `"default"` (repo default branch),
  `"head"` (current checkout), or an explicit branch name (e.g. `"develop"`).
- `teamKey` — optional; restrict to one team (e.g. `BIT`).
- `assignedToMe` — optional; when `true`, only list issues assigned to you (the
  API key's user). Default `false` (all assignees).
- `includeTriage` — optional; when `true`, also list issues in the triage state
  (on top of the unstarted/started defaults). Default `false`.
- `placement` — where the picker pane opens: `"right"` (default), `"left"`,
  `"top"`, `"down"` (splits, so your work stays visible), `"overlay"`
  (full-screen), or `"popup"` (centered floating window). `left`/`top` open a
  right/down split then swap into place.
- `fzfLayout` — `"down"` (default, search bar at the bottom) or `"top"` (search bar at the top). The picker renders as a compact window either way.
- `showIssueDetails` — optional; when `true`, opening a worktree also shows the
  picked issue's details in a pane your layout already provides (see below).
  Default `false`, and it needs `issueTabLabel` and `issuePaneLabel`.
- `issueTabLabel` / `issuePaneLabel` — the tab label, and the pane label inside
  that tab, that name the slot the issue view is delivered to. There is no
  default for either: the plugin will not guess which of your panes to type
  into. Both must match your layout exactly, and both must be unique — a
  renamed or duplicated label is reported rather than resolved.
- `issueSlotSettleMs` / `issueSlotPollMs` — how long to wait for a layout that
  is still being applied, and how often to look. Defaults `5000` and `200`
  milliseconds. The wait is always finite.
- `popupWidth` / `popupHeight` — size of the `popup` placement, as a percentage
  (`"80%"`) or a terminal-cell count (`120`). Only used when `placement` is
  `popup`. Defaults `80%` × `70%`.

### API key from the environment

For multiple Linear workspaces, configure variable names rather than key values:

```json
{
  "linearApiKeyEnvByPath": [
    { "contains": "hsys", "env": "LINEAR_API_KEY_HSYS" }
  ],
  "linearApiKeyEnvDefault": "LINEAR_API_KEY_EMBER"
}
```

With this example, any repository root containing `hsys` (in any letter case)
reads `LINEAR_API_KEY_HSYS`; every other repository reads
`LINEAR_API_KEY_EMBER`. Rules are checked in order and the first match wins.
Only the variable names belong in `config.json`; export their key values into
the herdr server's inherited environment.

For issue-detail views, also configure `linearApiKeyEnvByTeam` as in the complete
example above. Identifier-based routing takes precedence over path inference;
the picker (which has no selected identifier yet) keeps repository routing.
No key values are copied between workspaces or persisted by this routing.

When neither `linearApiKeyEnvByPath` nor `linearApiKeyEnvDefault` is configured,
the legacy behavior is unchanged: `linearApiKey` in `config.json` wins, then the
plugin falls back to `LINEAR_API_KEY` — the same name Linear's SDK and CLI use.
An explicit `linearApiKey` also wins over repository-path routing when both are
present, for backward compatibility.

Keep keys in a secret manager instead of on disk. Herdr spawns plugin actions as
child processes, so anything that exports the variables into the herdr server's
environment works — `op run --`, a systemd `EnvironmentFile=`, direnv, or a
plain shell export before `herdr`. Key values are inherited through the process
environment and are not added to pane command arguments.

`popup` opens the picker as a centered floating window that doesn't disturb your
pane layout — it requires **herdr ≥ 0.7.4** (older servers reject it; the plugin
still works with the other placements).

## Use

Bind the `Worktree from Linear issue` action to a key (herdr `[[keys.command]]`,
`type = "plugin_action"`, `command = "tdi.worktree-from-linear.pick"`), or invoke
it from the action menu. It lists your team's active issues; pick one and herdr
creates + focuses a worktree on the issue's branch. If a worktree for that branch
already exists, it is opened instead.

### The issue slot

With `showIssueDetails: true`, opening a worktree — freshly created or re-opened —
also shows the picked issue in a pane your own layout already provides: the pane
labeled `issuePaneLabel` in the tab labeled `issueTabLabel`, inside the workspace
herdr just reported. It shows the identifier, title, state, assignee, priority,
estimate, project, cycle, labels, the description, and the comment threads
oldest-first, fetched from Linear with your key and rendered by the plugin — no
extra CLI needed.

Delivery never changes your layout. It does not split, swap, move, resize or
close anything; it types one command into a slot that is already sitting at an
idle shell prompt — the shell process itself in the foreground, with no job
running under it. The viewer starts with an absolute node, script, config
directory and checkout path, and with `NODE_OPTIONS` cleared, so neither the
slot's `PATH` nor its environment can change which viewer runs or what it loads.
Everything else is reported and left alone:

- The tab or pane label is missing, renamed, or matches more than one tab or pane.
- The layout has not finished being applied within `issueSlotSettleMs`.
- herdr could not be asked, or answered something unreadable.
- The slot is busy: an agent, an editor, a command — anything that is not the
  slot's own shell sitting at its prompt.

In all of those the worktree is already open and its layout untouched; only the
issue view is skipped, with a line saying why.

Invoking the action again for the same issue focuses the viewer that is already
there rather than restarting it, and never sends it input. That only happens when
the pane's live foreground process and the metadata it published agree on both
the issue and the invocation that started it — leftover metadata from a viewer
that has since exited proves nothing on its own. A viewer showing a different
issue counts as busy. `q` or `Ctrl-C` closes the viewer and hands the shell back.

Focusing one named pane is the only thing here herdr's CLI cannot do — `herdr
pane focus` is directional — so it goes over `HERDR_SOCKET_PATH`, the same socket
herdr's own plugins use, as a single bounded request with a deadline. Nothing is
kept open and nothing is subscribed to.

If Linear cannot be reached, the viewer prints why and returns the shell it was
typed into, exiting non-zero like any other failed command — the worktree and the
layout that got you there are already correct, so nothing is rolled back and the
slot is not left parked on an error. (The older `[[panes]]` entrypoint has no
shell to return to, so there the message stays on screen until you close it.)

With `glow` installed the description and comments are rendered as markdown at
the pane's width, and a resize re-renders to fit. Without it — or when the pane's
output is not a terminal — the same content prints as plain text.

## Develop

```bash
npm test
```
