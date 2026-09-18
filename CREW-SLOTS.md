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
