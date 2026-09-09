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
- **`glow`** — optional (`brew install glow`); renders the issue view's markdown.
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
  default for either: the plugin will not guess which of your panes it is. Both
  must match your layout exactly, and both must be unique — a renamed or
  duplicated label is reported rather than resolved.
- `issueSlotSettleMs` / `issueSlotPollMs` — how long to wait for a layout that
  is still being applied, and how often to look. Defaults `5000` and `200`
  milliseconds. The wait is always finite, and each `herdr` command it runs is
  given what is left of it as its own timeout.
- `issueSlotCommandMs` — the bound on every `herdr` command run after the layout
  has settled, and on the socket call that focuses the slot. Default `5000`
  milliseconds. A herdr that accepts a command and never answers cannot hold the
  picker open.
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

With `showIssueDetails: true`, opening a worktree — freshly created or re-opened — also
shows the picked issue in a pane your own layout already provides: the pane labeled
`issuePaneLabel` in the tab labeled `issueTabLabel`, inside the workspace herdr just
reported. It shows the identifier, title, state, assignee, priority, estimate, project,
cycle, labels, the description, and the comment threads oldest-first, fetched from Linear
with your key and rendered by the plugin — no extra CLI needed.

**You start the viewer yourself.** In the pane you picked, run:

```bash
node <plugin-dir>/bin/slot-host.js --pane "$HERDR_PANE_ID" \
  --config-dir "$(herdr plugin config-dir tdi.worktree-from-linear)"
```

(`--cwd` defaults to the pane's working directory and must be the worktree the issue
belongs to. `herdr plugin dir tdi.worktree-from-linear` gives you `<plugin-dir>`.) That
process — the *issue host* — owns the pane while it runs, and picking an issue makes it
show that issue. `q` or `Ctrl-C` quits it and gives the pane back to your shell. Your
layout can start it for you as the pane's startup command.

Why it works this way, rather than the plugin typing a command into your shell: a shell
cannot be asked whether it is at a prompt. A shell sitting inside its own `read` builtin
has the same pid, the same process group and the same name as an idle one, so anything
"helpfully" typed there would be answering somebody's prompt — silently, and at exactly
the wrong moment. This plugin therefore never writes to a terminal at all. There is no
command construction, no shell quoting and no `pane run` anywhere in it.

Delivery also never changes your layout. It does not split, swap, move, resize or close
anything. Everything else is reported and left alone:

- The pane is not running an issue host — a shell, an agent, an editor, a command,
  anything else. The message tells you the exact command to start one there.
- The host that is running belongs to another checkout, or published incomplete identity.
- The tab or pane label is missing, renamed, or matches more than one tab or pane.
- The layout has not finished being applied within `issueSlotSettleMs`.
- herdr could not be asked, answered something unreadable, or did not answer within
  `issueSlotCommandMs`.
- The host already has a different issue on screen: it says so and keeps what you are
  reading.

In all of those the worktree is already open and its layout untouched; only the issue view
is skipped, with a line saying why.

Invoking the action again for the same issue focuses the host that already has it rather
than restarting anything, and never sends it a second fetch. That only happens when the
pane's live foreground process is the host, the metadata it published names that same live
process, and the host itself confirms the issue over its socket — leftover metadata from a
host that has since exited proves nothing on its own.

#### How the picker reaches the host

The host creates a unix socket in a directory it makes for itself (mode `0700`, socket
mode `0600`, both removed on the way out) and publishes the path, its pid, a random
instance token and a digest of its checkout as metadata on its own pane. The picker reads
those, checks them against the live foreground process, and sends one bounded request over
that socket. A request carries a known operation and a validated issue identifier —
never a command, a script or an environment — and the host validates every field of it
against itself before acting. It is local same-user IPC, not a network endpoint, and not a
daemon: the host dies with its pane.

Focusing one named pane is the only thing here herdr's CLI cannot do — `herdr pane focus`
is directional — so that goes over `HERDR_SOCKET_PATH`, the same socket herdr's own plugins
use, as a single bounded request with a deadline. Nothing is kept open and nothing is
subscribed to.

If Linear cannot be reached, the host prints why, exits non-zero and gives the pane back to
your shell — the worktree and the layout that got you there are already correct, so nothing
is rolled back. Starting the host again is up to you; the plugin will not restart it,
because that would mean typing into the shell it just handed back.

With `glow` installed the description and comments are rendered as markdown at the pane's
width, and a resize re-renders to fit. Without it — or when the pane's output is not a
terminal — the same content prints as plain text. Rendering is bounded like everything
else: a renderer that has not finished within five seconds is signalled, the plain panel is
printed instead, and the pane goes back to reading `q`. No renderer outlives the pane's own
process.

### The `[[panes]]` issue pane

The older entrypoint (`bin/issue.js`, herdr pane id `issue`) still works: herdr opens a
pane, passes the identifier as `HERDR_WFP_ISSUE`, and it renders the same view and holds
until you close the pane. It owns no slot and publishes nothing.

## Develop

```bash
npm test
```
