# claude-lark-channel

Lark/Feishu channel plugin for Claude Code. Bridges Lark messaging with Claude Code via MCP + WebSocket.

## Features

- Real-time message reception via Lark SDK WebSocket
- `lark_reply` — reply to conversations
- `lark_react` — add emoji reactions (UPPERCASE types: THUMBSUP, OK, SMILE, etc.)
- `lark_send` — send messages to any chat/user
- `lark_fetch_messages` — fetch chat history
- Message dedup & expiry filtering
- Sender allowlist (open_id based)
- Permission relay (approve/deny Claude's tool calls from Feishu)

## Prerequisites

- [Bun](https://bun.sh) runtime
- A Feishu/Lark self-built app with:
  - **WebSocket long connection mode** enabled (Events & Callbacks → Connection mode)
  - **Event subscription**: `im.message.receive_v1`
  - **Permissions**: `im:message`, `im:message:send`, `im:message.reaction:write`
  - Bot added to target group chats

## Setup

1. Install dependencies:

```bash
bun install
```

2. Add to your `.mcp.json` (project-level) or `~/.claude.json` (global):

```json
{
  "mcpServers": {
    "lark-channel": {
      "command": "bun",
      "args": ["/path/to/claude-lark-channel/index.ts"],
      "env": {
        "LARK_APP_ID": "your_app_id",
        "LARK_APP_SECRET": "your_app_secret",
        "LARK_BRAND": "feishu"
      }
    }
  }
}
```

3. Start Claude Code with the channel:

```bash
claude --dangerously-load-development-channels server:lark-channel
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `LARK_APP_ID` | Yes | Feishu app ID |
| `LARK_APP_SECRET` | Yes | Feishu app secret |
| `LARK_BRAND` | No | `feishu` (default) or `lark` |
| `LARK_ALLOW_FROM` | No | Comma-separated open_id allowlist (empty = allow all) |

## Sender Access Control

By default, all senders are allowed. To restrict:

- Set `LARK_ALLOW_FROM` env var with comma-separated open_ids
- Or create `access.json` alongside `index.ts`:

```json
{
  "allowFrom": ["ou_xxxx", "ou_yyyy"],
  "dmPolicy": "allowlist"
}
```

## Multi-Channel

Works alongside other channels (Discord, Telegram, etc.):

```bash
claude --channels plugin:discord@claude-plugins-official --dangerously-load-development-channels server:lark-channel
```

## License

MIT
