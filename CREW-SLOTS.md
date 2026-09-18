# Issue delivery by pane ID

Set `issueSlotById` to `true` to use Plus role metadata.
The selected workspace must have `crew_crew_tab` and `crew_issue_pane` tokens.
The pane must remain in that workspace and tab.

This mode ignores `issueTabLabel` and `issuePaneLabel`.
A rename does not affect delivery. A missing binding causes refusal.
The plugin checks the binding again before delivery.
Host process, checkout, socket, and instance checks still apply.
The plugin creates no replacement pane and types no commands into a shell.

The default remains label-based selection for existing installations.
