# Moved

The contents of this directory have been moved to `../_legacy-mcp-server/`.

The ADO plugin no longer ships an external MCP server as its primary tool surface. The five tools (`ado.get_pr`, `ado.list_pr_comments`, `ado.comment_pr`, `ado.list_iterations`, `ado.get_pr_status`) are now **hostable tools** under `../tools/` — single-file scripts hosted in-process by the Conductor MCP server (spec §10.3).

`../_legacy-mcp-server/` keeps the previous external-MCP-server implementation as a reference for plugin authors who need the heavyweight pattern (long-running indexer, stateful daemon, foreign-language binary).

This empty placeholder directory exists only because the Windows file watcher held an open handle when the rename was attempted. Safe to delete on a reboot — nothing references it.
