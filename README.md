# Worktree from Linear: herdr plugin

Pick a Linear issue and open its worktree using Herdr Plus's shared project policy. Plus preserves existing branches and registered checkout paths. Multiple matches require an explicit choice. Issue details fill a configured pane in the resulting workspace.

## Install

```bash
herdr plugin install tdi/herdr-worktree-from-linear
```

## Prerequisites

- **Herdr 0.9.0 or newer** and enabled **Herdr Plus** with `plan-worktree` / `apply-worktree` support and configured `[[worktree.projects]]` policies. Open the project’s primary workspace before creating linked worktrees.

- **`fzf`**: the fuzzy picker (`brew install fzf`). Required for the intended
  overlay. Without it, the picker uses a plain numbered prompt.
- **`glow`**: optional (`brew install glow`). It renders the issue view's markdown.
  Without it the pane prints the same plain-text panel as before.
- **A Linear personal API key for each workspace**: Linear → Settings →
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
  "issueLimit": 500,
  "teamKey": "BIT",
  "idTeamKey": "IC",
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

- `linearApiKeyEnvByTeam`: optional uppercase issue-team to environment-variable
  map for ID lookup and the issue-details pane. `HSYS-4619` selects `HSYS` even outside Git or
  when focused on a different checkout. An unmapped team fails explicitly. When
  no legacy inline `linearApiKey` is set, a missing selected environment key
  also fails rather than trying another workspace. Remove that legacy inline
  key to enable per-team credential selection. Otherwise, it still overrides
  the selected environment key for mapped teams, for backward compatibility.
  This does not combine workspace issue lists in the worktree picker. Map every
  team whose issues you select. A third team may appear through the picker's
  repository route. Its detail pane refuses to load until you map that team.
  After Linear changes a team key, keep the old key in this map next to the new
  one. The pane then loads an id with the old key, such as `HSYS-4619` after
  `HSYS` became `ENG`. Linear resolves that old id, and the pane shows the
  current id, `ENG-4619`. A crew slot keeps the id it stored.
- `linearApiKeyEnvByPath`: optional ordered path rules for selecting an API
  key environment variable. The first rule whose `contains` substring appears
  in the repository root wins. Matching is case-insensitive.
- `linearApiKeyEnvDefault`: the environment-variable name used when no path
  rule matches. This supports a small exception list with one common default.
- `linearApiKey`: legacy key value. Existing configs still work. An explicit value takes precedence.
  New configs should keep key values out of `config.json`. Use the environment-variable options above.
- `issueLimit`: the most issues the picker lists (default 500).
  The plugin reads pages of at most 100 issues. It stops at this limit or the last page.
- `teamKey`: optional. Restrict the list to one team (e.g. `BIT`).
- `idTeamKey`: optional. Set the team for a bare number such as `1516`.
  Without a matching row, the picker looks for `IC-1516` when this key is `IC`.
  If absent, it uses `teamKey`. With neither key, a bare number selects only a matching row.
  A full ID uses its own team. It ignores both keys.
- `assignedToMe`: optional. When `true`, only list issues assigned to you (the
  API key's user). Default `false` (all assignees).
- `includeTriage`: optional. When `true`, also list issues in the triage state
  (on top of the unstarted/started defaults). Default `false`.
- `placement`: where the picker pane opens: `"right"` (default), `"left"`,
  `"top"`, `"down"` (splits, so your work stays visible), `"overlay"`
  (full-screen), or `"popup"` (centered floating window). `left`/`top` open a
  right/down split then swap into place.
- `fzfLayout`: `"down"` puts the search bar at the bottom (default).
  `"top"` puts it at the top. Both use a compact picker window.
- `showIssueDetails`: optional. When `true`, opening a worktree also shows the
  picked issue's details in a pane your layout already provides (see below).
  Default `false`, and it needs `issueTabLabel` and `issuePaneLabel`.
- `issueTabLabel` / `issuePaneLabel`: the tab label, and the pane label inside
  that tab, that name the slot the issue view is delivered to. There is no
  default for either: the plugin will not guess which of your panes it is. Both
  must match your layout exactly, and both must be unique. A renamed or
  duplicated label is reported rather than resolved.
- `issueSlotSettleMs` / `issueSlotPollMs`: how long to wait for a layout that
  is still being applied, and how often to look. Defaults `5000` and `200`
  milliseconds. The wait is always finite, and each `herdr` command it runs is
  given what is left of it as its own timeout.
- `issueSlotCommandMs`: the bound on every `herdr` command run after the layout
  has settled, and on the host socket call. Default `5000`
  milliseconds. A herdr that accepts a command and never answers cannot hold the
  picker open.
- `popupWidth` / `popupHeight`: size of the `popup` placement, as a percentage
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
reads `LINEAR_API_KEY_HSYS`. Every other repository reads
`LINEAR_API_KEY_EMBER`. Rules are checked in order and the first match wins.
Only the variable names belong in `config.json`. Export their key values into
the herdr server's inherited environment.

For ID lookups and issue-detail views, also configure `linearApiKeyEnvByTeam` as in the complete
example above. Identifier-based routing takes precedence over path inference.
The initial picker list uses repository routing. A typed ID lookup uses its team route.
No key values are copied between workspaces or persisted by this routing.

Without `linearApiKeyEnvByPath` or `linearApiKeyEnvDefault`, the plugin uses the legacy key order.
`linearApiKey` in `config.json` wins. Otherwise, it uses `LINEAR_API_KEY`, the name Linear's SDK and CLI use.
An explicit `linearApiKey` also wins over repository-path routing when both are
present, for backward compatibility.

Keep keys in a secret manager instead of on disk. Herdr spawns plugin actions as
child processes, so anything that exports the variables into the herdr server's
environment works. Options include `op run --`, a systemd `EnvironmentFile=`, direnv,
or a plain shell export before `herdr`. Key values are inherited through the process
environment and are not added to pane command arguments.

`popup` opens the picker as a centered floating window that doesn't disturb your
pane layout. `overlay` also closes back to the original layout when the picker exits.

## Use

Bind the `Worktree from Linear issue` action to a key (herdr `[[keys.command]]`,
`type = "plugin_action"`, `command = "tdi.worktree-from-linear.pick"`), or invoke
it from the action menu. The picker lists active issues through the configured filters.
It reads pages until it reaches `issueLimit` or the last page.
An empty list prints `no active issues` and still opens the picker.
You can type an ID even with no listed issues.

Type a full ID such as `IC-1516` and press Enter to select that exact issue.
Letter case does not matter. A full ID wins over the highlighted row.
The picker reuses a listed issue or loads it through Linear's `issue(id:)` lookup.
This lookup can find closed, unassigned, or older issues. It also resolves an old team key.
Map that team in `linearApiKeyEnvByTeam` when you use team routing.
A missing issue prints a message and sends a notification. It creates no worktree.
Other API errors fail the action.

A bare number uses `idTeamKey`, then `teamKey`, only when no row matches.
With a matching row, the highlighted row wins.
Without fzf, enter a row number or a full ID at the prompt.
A valid row number wins over a bare-number lookup.
Esc or Ctrl-C in fzf cancels the action.

Rows show the state before the title:

```text
IC-1516  ◐ In Progress  Title  [Project] @owner
```

Only the icon uses Linear's state color. Unknown state types show the name without an icon.
Rows omit the project or owner when absent. Titles use at most 60 code points.
Longer titles use 59 code points and `…`.

| State type | Icon |
| --- | --- |
| Triage | ◇ |
| Backlog | ◌ |
| Unstarted | ○ |
| Started | ◐ |
| Started with `review` in its name | ◕ |
| Completed | ● |
| Canceled or duplicate | ⊘ |

Select an issue and herdr asks Plus to plan from its identifier and title.
The picker applies a sole candidate. Multiple matching branches/checkouts show a second chooser.
Cancelling either chooser creates nothing. The Linear-provided branch name is not a naming policy.

Plus owns branch prefix, name limits, checkout root, remote default/base, existing branch reuse and native worktree creation/opening. Configure those in Plus, including any project base override. This plugin's former `base` option is obsolete. A missing backend, missing project policy or changed plan fails visibly without a fallback creation path. Refresh and select again after a changed-plan refusal.

The action uses the original invoking pane and checkout, even if another client changes focus. Use `placement: "overlay"` or `"popup"` to preserve the surrounding layout while choosing. Noninteractive invocation requires explicit `HERDR_WFP_CWD`. The plugin never uses its executable directory as the target repository.

### Show a Linear issue here

Choose `Show Linear issue here` from the action menu.
You can also bind `tdi.worktree-from-linear.show` with `type = "plugin_action"`.
Select an issue or type an ID in the same picker.
The action sends it to the configured Issue / Utility pane in the invoking workspace.
It creates no worktree. It works with `showIssueDetails: false`.
The workspace must have native checkout provenance and a running issue host in the configured slot.
The action checks the invoking workspace before it opens the picker.
A delivery failure prints a message, sends a notification, and returns status 1.

### Start an agent on a Linear issue

Choose `Start agent on Linear issue` from the action menu.
You can also bind `tdi.worktree-from-linear.start` with `type = "plugin_action"`.
Select an issue in the same picker. Cancel to leave without a start.

This action requires the dot command `task new` and its configured agent pool.
The command defaults to `$HOME/dot/bin/task`. Set `TASK_BIN` to use another executable path.
The picker calls `task new "<identifier> [M]"` from the invoking pane's context.
The task command creates the worktree and Crew workspace. It then starts the supervised agent.
The picker prints the command's result and sends a notification with the same message.
A task failure prints its message and makes the picker exit with status 1.

The size is always `[M]`. This picker has no size column or prefix key for `[S]` or `[L]`.
Use `task new` directly to select another size.

Before it calls the task, the picker removes variables with these name prefixes:

- `HERDR_PLUGIN_`
- `HERDR_WFP_`

This prevents the task from using this plugin's paths for bootstrap preparation.
The task inherits all other environment variables, including the socket path and named Linear keys.
The picker sets `HERDR_ENV=1` and sets `HERDR_PANE_ID` to the original invoking pane.
The task reads the Linear key by name. It inherits `TASK_LINEAR_KEY_ENV` when you set it.
The picker adds no key value to command arguments.
The `Worktree from Linear issue` action keeps its existing behavior.

### The issue slot

With `showIssueDetails: true`, opening a worktree (freshly created or re-opened) also
shows the picked issue in a pane your layout provides.
The pane has the label `issuePaneLabel` in the tab with label `issueTabLabel`.
The workspace comes from herdr’s worktree reply. The plugin fetches the details from Linear with your key.
It shows the identifier, title, state, assignee, priority, estimate, project, cycle, labels, and description.
It also shows comment threads oldest-first. No extra CLI is needed.

The host reads the task worktree's repeated `harkness.issues` Git config key every two
seconds. Set one Linear ID per value in `config.worktree`. IDs use the form `IC-421`.
The host ignores invalid values and keeps the first copy of each ID. Dot writes
`harkness.managed-issues=true` in the task worktree's `config.worktree` when it
seeds the list. When this key is `true`, an empty list shows the ready text.
The host does not fall back to `harkness.tracker`. If the key is absent or has
another value, the host uses a valid tracker ID when the list has no valid ID.
With no valid ID, it shows the ready text. The plugin reads this config. Dot
owns the writes. No native test covers the managed key.

One pane lists all IDs in config order. The selected issue's details appear below the
list. The list row stays visible when there is one issue. Press `j` or `k` to select an
issue. Press Enter for its full view. Press Enter or Esc to return to the list. Press `o`
to open the shown issue in Linear. Press `r` to fetch the shown issues now, in the list
and in the full view. Press `q` to return to the shell. The host names its
own pane with the selected ID. It creates no pane.
The full view redraws when its issue changed in Linear. It clears the screen and the
scrollback first, the same way it does when it opens.
A failed request keeps the last good details and shows a short error.
The host selects a delivered ID outside the list until the list changes.
Native pane behavior is untested.

#### One Linear fetcher per Mac

All issue hosts of one user on one Mac share one fetcher. One host, the leader, calls
Linear. The other hosts, the followers, read its cache. No extra process runs. The
leader is one of the hosts, and the fetcher ends with the last host.

The hosts meet in a private directory with mode `0700`. The host takes the first of these:

1. `$WFL_SHARED_DIR`, when set. It must be an absolute path.
2. `$XDG_RUNTIME_DIR/wfl-fetch`, when that runtime directory exists and is yours.
3. `wfl-fetch` in the system temporary directory.

A host that cannot create or trust that directory fetches on its own. Its error line
shows `Fetcher: private, <reason>`.

| File | Writer | Content |
|---|---|---|
| `host-<pid>.json` | each host | its pid, its checkout, the shown IDs with the rate it wants for each, and a refresh stamp |
| `leader.json` | the leader | its pid and a heartbeat |
| `issues.json` | the leader | the cache: for each ID the `updatedAt`, the details, and the last error |

No file holds an API key. An error text in the cache passes the same redaction as the
screen.

The lock is `leader.json`. A host creates it with an exclusive link. A follower takes
the lock in three cases:

- The leader removed it on exit.
- The leader's process is gone.
- The heartbeat is older than 90 s.

The leader drops a host whose interest file is older than 5 min. It removes the file
of a host whose process is gone.

The leader asks Linear for each ID at the fastest rate any host wants:

| The ID is | Rate |
|---|---|
| in an open full view, or in a focused pane | every 60 s |
| in a background list | every 5 min |

Each host asks herdr `pane get <its pane>` for its own `focused` field. It asks at most
once per 10 s, and only while it shows an ID. A live `herdr pane get` reply on
2026-10-24 carried `result.pane.focused`. Whether a pane the user looks at reports
`focused: true` in a native layout is untested.

Each fetch asks Linear for `updatedAt` first, in one bounded request per credential. The
full details follow only for the IDs that changed, or that have no cache entry. Mixed
Linear workspaces need one request for each key. Each ID that the team key filter misses
costs one more request at every probe. An ID with an old team key, or a missing issue,
is such a miss.

Budget, for one credential. Each ID is due on its own schedule, counted from the first
time a host showed it. IDs that became due in the same 10 s tick share one probe. The
leader does not align the schedules. For 8 hosts with 3 IDs each, all in the background:

| The hosts | Probes per hour |
|---|---|
| started together, so all 24 IDs share one schedule | 12 |
| started at different times, each host's 3 IDs together | 96 |
| showed every ID at a different time | up to 288 |

One open full view has one ID, so it adds up to 60 probes per hour. A focused pane makes
every ID it shows fast, each on its own schedule. It adds up to 60 probes per hour for
each distinct schedule among its IDs. When every ID first appeared at a different time,
that is 60 times the ID count. A pane with 3 IDs then costs 180 probes per hour. A probe
that finds a changed ID, or an ID with no cache entry, adds one full request per
credential. Each ID that the team key filter misses adds one lookup per probe. Before
this fetcher, each host fetched every minute: 8 hosts cost 480 requests per hour.

**You start the viewer yourself.** In the pane you picked, run:

```bash
node <plugin-dir>/bin/slot-host.js --pane "$HERDR_PANE_ID" \
  --config-dir "$(herdr plugin config-dir tdi.worktree-from-linear)"
```

`--cwd` defaults to the pane's working directory. It must be the worktree the issue belongs to.
`herdr plugin dir tdi.worktree-from-linear` gives you `<plugin-dir>`.
That process (the *issue host*) owns the pane while it runs. Picking an issue makes it show that issue. `q` or `Ctrl-C` quits it and gives the pane back to your shell. Your
layout can start it for you as the pane's startup command.

The plugin cannot ask a shell whether it is at a prompt. A shell inside its own `read` builtin has the same pid, process group, and name as an idle shell.
Text sent there would silently answer that prompt. This plugin therefore never writes to a terminal at all. There is no
command construction, no shell quoting and no `pane run` anywhere in it.

Delivery also never changes your layout. It does not split, swap, move, resize or close
anything. Everything else is reported and left alone:

- The pane is not running an issue host: a shell, an agent, an editor, a command,
  anything else. The message tells you the exact command to start one there.
- The host that is running belongs to another checkout, or published incomplete identity.
- The tab or pane label is missing, renamed, or matches more than one tab or pane.
- The layout has not finished being applied within `issueSlotSettleMs`.
- herdr could not be asked, answered something unreadable, or did not answer within
  `issueSlotCommandMs`.

In all of those cases, the worktree stays open with its layout unchanged.
The plugin skips the issue view. A log line and bounded native notification say why.

Invoking the action again for the same issue reuses the host.
It leaves focus on the current pane and sends no second fetch.
This requires three checks:

- The pane's live foreground process is the host.
- The published metadata identifies that live process.
- The host checks the issue over its socket.

Leftover metadata from a host that exited proves nothing on its own.

#### How the picker reaches the host

The host creates its own directory and unix socket.
The directory uses mode `0700`. The socket uses mode `0600`. The host removes both when it exits.
It publishes the socket path, pid, random instance token, and checkout digest as metadata on its pane. The picker reads
those, checks them against the live foreground process, and sends one bounded request over
that socket. A request carries a known operation and a checked issue identifier.
It never carries a command, script, or environment. The host checks every field against itself before acting. It is local same-user IPC, not a network endpoint, and not a daemon. The host dies with its pane.
Socket paths must fit native metadata’s 80-byte bound. The host uses a short random directory and basename.
It refuses an overlong custom runtime path. The error tells you to shorten `TMPDIR` or `XDG_RUNTIME_DIR`.

If Linear cannot be reached, the host keeps its last good details and shows an error.
The host remains in the pane. You can still select an issue or press `q`.

In the full view, `glow` renders the description and comments as markdown at the pane's
width, and a resize re-renders to fit. Without it (or when the pane's output is not a
terminal), the same content prints as plain text. The plugin signals a renderer that exceeds five seconds.
It prints the plain panel instead. The pane returns to reading `q`. No renderer outlives the pane's own
process.

### The `[[panes]]` issue pane

The older entrypoint (`bin/issue.js`, herdr pane id `issue`) still works.
Herdr opens a pane and passes the identifier as `HERDR_WFP_ISSUE`.
The pane renders the same view and holds until you close it. It owns no slot and publishes nothing.

## Develop

```bash
npm test
```

### Show an issue from a project action

A project action can run this command with the plugin's `HERDR_PLUGIN_CONFIG_DIR`:

```bash
node <plugin-dir>/bin/show.js --workspace WORKSPACE_ID --issue IC-72
```

The explicit workspace must carry native checkout provenance.
The command uses the same host delivery as `Show Linear issue here`.
It reports failure through its existing command line output.
It does not create a pane or type a command into one.
