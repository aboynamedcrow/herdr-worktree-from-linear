# Issue delivery by pane ID

Set `issueSlotById` to `true` to use Plus role metadata.
The selected workspace uses `crew_crew_tab` and `crew_issue_pane` tokens.
The pane must remain in that workspace and tab.
A rename does not affect delivery with recorded IDs.
Partial bindings or missing and moved targets cause refusal.

For a workspace without any `crew_` tokens, the plugin uses explicit legacy labels.
Set both `issueTabLabel` and `issuePaneLabel` to keep delivery in older crews.
The tab and pane labels must each select one target.
The host must still report the configured pane label.
A workspace with any Crew metadata cannot use this fallback.

The plugin checks the selection again before delivery.
A change between ID and label selection causes refusal.
Host process, checkout, socket, and instance checks still apply.
The plugin creates no replacement pane and types no commands into a shell.

The default remains label-based selection for existing installations.

## Host list mode

The task worktree stores active Linear IDs as repeated `harkness.issues` values in
`config.worktree`. The host reads them with this command:

```sh
git -C <cwd> config --worktree --get-all harkness.issues
```

Each value must match `^[A-Z][A-Z0-9]*-[1-9][0-9]*$`. The host keeps
config order and removes duplicate IDs. Dot writes `harkness.managed-issues=true`
in the task worktree's `config.worktree` when it seeds the list. When this key
is `true`, an empty list shows ready text. The host does not read
`harkness.tracker`. If the key is absent or has another value, the host uses a
valid tracker ID when the list has no valid ID. With no valid ID, it shows
ready text. Dot owns all writes. No native test covers the managed key.

The host checks the list every two seconds. It keeps the selected ID while that ID
remains in the list. It requests all listed details in one bounded GraphQL call per
credential after a list change and once a minute. Mixed Linear workspaces need separate
calls. A failed call keeps the last good details. A delivered
ID outside the list stays selected until the list changes. Delivery leaves pane focus
where it was. The host renames only its own pane. Native pane behavior is untested.
