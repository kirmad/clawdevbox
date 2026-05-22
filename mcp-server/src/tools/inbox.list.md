# inbox.list

List inbox items (metadata only — body content NOT included).

## Parameters

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| kind | string | no | Filter by item kind |
| state | "new" \| "open" \| "snoozed" \| "archived" \| "done" | no | Filter by state |
| label | string | no | Case-insensitive label match |
| limit | number | no | Max items to return (1-500) |
| cursor | string | no | Pagination cursor from previous response |

## Examples

List all items:
```json
{ "tool": "inbox.list", "args": {} }
```

List only new items:
```json
{ "tool": "inbox.list", "args": { "state": "new" } }
```

Filter by label with pagination:
```json
{ "tool": "inbox.list", "args": { "label": "urgent", "limit": 10 } }
```

## Notes

- To get the full body of an item, use `inbox.read` with the item's `id`.
- Results are ordered by creation date (newest first).
- The response includes a `count` field and an `items` array with metadata only.
