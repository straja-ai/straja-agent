# Channel Behavior Reference

Practical guide to how WhatsApp and Telegram channels work in OpenClaw. Covers message flow, access control, configuration, and operational details.

## WhatsApp

WhatsApp uses the Baileys library to maintain a WhatsApp Web session. The gateway owns the socket and handles reconnections automatically.

### How messages flow

```
Incoming WhatsApp message
  |
  v
Dedupe check -----> skip if offline catch-up (append-type)
  |
  v
Echo detection ---> skip if agent just sent this exact text
  |
  v
Access control ---> block or send pairing request if sender not allowed
  |
  v
Group mention gate -> skip if bot not @mentioned (groups only, default behavior)
  |
  v
Debounce buffer --> batch rapid messages from same sender (if debounceMs > 0)
  |
  v
Route to agent ---> create/update session, invoke LLM
  |
  v
Send reply back to same chat
```

### Self-chat (messaging yourself)

When the WhatsApp account's own phone number sends a message, **all access control is bypassed**. This is the primary way to interact with your agent via WhatsApp -- you message yourself and the agent replies in the same chat.

Self-chat also activates special behavior:

- Read receipts are skipped for self-chat turns
- Mention-JID auto-trigger is suppressed
- Response prefix defaults to `[{agent_name}]` or `[openclaw]` if not configured

### DM access control

Controlled by `channels.whatsapp.dmPolicy`:

| Policy              | Behavior                                                                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `pairing` (default) | Unknown senders receive a pairing code. Must be approved via `openclaw pairing approve whatsapp <CODE>` before the agent responds. |
| `allowlist`         | Only phone numbers listed in `allowFrom` can trigger the agent. Unknown senders are silently ignored.                              |
| `open`              | Any sender triggers the agent. Requires `allowFrom: ["*"]`.                                                                        |
| `disabled`          | All DMs blocked.                                                                                                                   |

`allowFrom` takes E.164 phone numbers: `["+15551234567", "+447911123456"]`. Use `"*"` for wildcard.

Account-level override: `channels.whatsapp.accounts.<id>.dmPolicy` and `accounts.<id>.allowFrom` take precedence for that account.

### Pairing flow (default DM policy)

1. Unknown sender messages the agent
2. Agent sends back a pairing code in the WhatsApp chat
3. You approve the code: `openclaw pairing approve whatsapp <CODE>`
4. Sender is added to the persistent allow-store
5. Future messages from that sender are processed normally

Pairing codes expire after 1 hour. Max 3 pending requests per channel.

### Group access control

Two independent layers:

**Layer 1 -- Which groups are allowed:**

- If `channels.whatsapp.groups` is omitted: all groups are eligible
- If `groups` is present: it acts as an allowlist (group JIDs as keys, or `"*"` for all)

**Layer 2 -- Which senders are allowed in groups:**

Controlled by `channels.whatsapp.groupPolicy`:

| Policy           | Behavior                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------- |
| `open` (default) | Sender allowlist bypassed. Any group member can trigger the bot (if mention-gating passes). |
| `allowlist`      | Sender must match `groupAllowFrom` (falls back to `allowFrom` if not set).                  |
| `disabled`       | All group messages blocked.                                                                 |

### Group mention gating

By default, the agent only responds in groups when **explicitly mentioned** or when someone **replies to the agent's message**.

Mention detection includes:

- Direct @mention of the bot's phone number/identity
- Configured regex patterns (`agents.list[].groupChat.mentionPatterns`)
- Implicit reply-to-bot (reply sender JID matches bot identity)

**Per-group configuration:**

```json5
{
  channels: {
    whatsapp: {
      groups: {
        "<group-jid>": {
          requireMention: false, // respond to ALL messages in this group
        },
      },
    },
  },
}
```

**Session-level toggle** (owner-only, not persisted):

- `/activation always` -- respond to all messages
- `/activation mention` -- require mention (default)

### Outbound messaging

The agent can only **reply** to whoever messaged it. There is no tool exposed to the LLM for sending messages to arbitrary contacts. This is a security design choice.

How replies work:

- Inbound message records delivery context (channel, sender number, account)
- Agent's response is routed back to the original sender automatically
- Replies require an active WhatsApp Web listener for the target account

Supported reply types:

- Text (chunked at 4000 chars by default)
- Images, videos, audio/voice notes, documents
- Polls (up to 12 options)
- Reactions (emoji)

### Message debouncing

When `debounceMs` is set, rapid consecutive messages from the same sender are batched into a single agent invocation.

```json5
{
  channels: {
    whatsapp: {
      debounceMs: 3000, // wait 3s for additional messages before processing
    },
  },
}
```

Default: `0` (no debouncing, each message processed immediately).

### Echo detection

The agent tracks its own recent outgoing messages (up to 100). When an inbound message matches text the agent just sent, it is skipped. This prevents infinite reply loops.

### Acknowledgment reactions

Send an emoji reaction when the agent starts processing a message:

```json5
{
  channels: {
    whatsapp: {
      ackReaction: {
        emoji: "👀",
        direct: true, // react in DMs (default: true)
        group: "mentions", // "always" | "mentions" | "never" (default: "mentions")
      },
    },
  },
}
```

The reaction is sent immediately on receipt, before the agent generates a reply.

### History and context

**Group history:** Unprocessed group messages are buffered and injected as context when the bot is finally triggered.

- Default limit: 50 messages
- Config: `channels.whatsapp.historyLimit`
- Set to `0` to disable

Context is injected between markers:

```
[Chat messages since your last reply - for context]
... buffered messages ...
[Current message - respond to this]
```

**DM history:** Configurable via `channels.whatsapp.dmHistoryLimit` or per-DM with `channels.whatsapp.dms.<phone>.historyLimit`.

### Read receipts

Enabled by default. Disable:

```json5
{
  channels: {
    whatsapp: {
      sendReadReceipts: false,
    },
  },
}
```

Self-chat turns skip read receipts even when globally enabled.

### QR login and session management

**Login flow:**

1. `openclaw channels login --channel whatsapp` (CLI) or via vault UI
2. QR code is generated and displayed
3. Scan with WhatsApp > Linked Devices
4. Session credentials saved to `~/.openclaw/credentials/whatsapp/<accountId>/`

**Force re-login:** `web.login.start` with `force: true` bypasses the "already linked" check and generates a fresh QR.

**Session storage:**

```
~/.openclaw/credentials/whatsapp/<accountId>/
  creds.json          # main Baileys credentials
  creds.json.bak      # backup
  pre-key-*.json      # pre-keys
  session-*.json      # session state
  sender-key-*.json   # group sender keys
```

**Logout:** `openclaw channels logout --channel whatsapp` clears the auth directory. In legacy auth directories, `oauth.json` is preserved.

**Stale session recovery:** If WhatsApp returns a 401 (session logged out), the credentials are automatically cleared and the user is prompted to scan a new QR.

### Text chunking

- Default limit: 4000 characters per message
- Config: `channels.whatsapp.textChunkLimit`
- Modes:
  - `"length"` (default): split by character count
  - `"newline"`: prefer paragraph boundaries, then fall back to length

### Media

- Inbound media save cap: `channels.whatsapp.mediaMaxMb` (default: 50 MB)
- Outbound media cap: `agents.defaults.mediaMaxMb` (default: 5 MB)
- `audio/ogg` is rewritten to `audio/ogg; codecs=opus` for WhatsApp voice-note compatibility
- Animated GIF playback supported via `gifPlayback: true`
- On media send failure, falls back to text warning instead of silently dropping

### Deployment patterns

**Dedicated number (recommended):**
Separate WhatsApp identity for the agent. Cleaner DM allowlists and no self-chat confusion.

```json5
{
  channels: {
    whatsapp: {
      dmPolicy: "allowlist",
      allowFrom: ["+15551234567"],
    },
  },
}
```

**Personal number:**
Agent uses your personal WhatsApp. Enable `selfChatMode` for proper self-chat handling:

```json5
{
  channels: {
    whatsapp: {
      dmPolicy: "allowlist",
      allowFrom: ["+15551234567"], // your own number
      selfChatMode: true,
    },
  },
}
```

---

## Telegram

Telegram uses the Bot API via grammY. Long polling is the default; webhook mode is optional.

### Setup

1. Create a bot with **@BotFather** (`/newbot`)
2. Configure the bot token:

```json5
{
  channels: {
    telegram: {
      enabled: true,
      botToken: "123456:ABC-DEF...",
    },
  },
}
```

Token resolution order:

1. `channels.telegram.accounts.<id>.tokenFile` (read from file)
2. `channels.telegram.accounts.<id>.botToken` (inline config)
3. `channels.telegram.tokenFile` (channel-level, default account only)
4. `channels.telegram.botToken` (channel-level, default account only)
5. `TELEGRAM_BOT_TOKEN` environment variable (default account only)

### DM access control

Same policy model as WhatsApp. Controlled by `channels.telegram.dmPolicy`:

| Policy              | Behavior                                                    |
| ------------------- | ----------------------------------------------------------- |
| `pairing` (default) | Unknown senders get a pairing code to approve.              |
| `allowlist`         | Only users in `allowFrom` can trigger the agent.            |
| `open`              | Any sender triggers the agent. Requires `allowFrom: ["*"]`. |
| `disabled`          | All DMs blocked.                                            |

`allowFrom` takes **numeric Telegram user IDs** (not usernames): `[123456789, 987654321]`. Use `"*"` for wildcard.

To find your Telegram user ID:

- DM the bot, then check `openclaw logs --follow` for `from.id`
- Or: `curl "https://api.telegram.org/bot<token>/getUpdates"`

### Group access control

Two layers (same model as WhatsApp):

**Layer 1 -- Which groups:** `channels.telegram.groups`

- Omitted: all groups allowed
- Present: acts as allowlist (numeric group IDs or `"*"`)

**Layer 2 -- Which senders:** `channels.telegram.groupPolicy`

| Policy                | Behavior                              |
| --------------------- | ------------------------------------- |
| `open`                | Any group member can trigger the bot. |
| `allowlist` (default) | Sender must match `groupAllowFrom`.   |
| `disabled`            | All group messages blocked.           |

### Group mention gating

Same as WhatsApp -- bot only responds when @mentioned by default.

```json5
{
  channels: {
    telegram: {
      groups: {
        "*": { requireMention: true }    // default: require mention
        // or
        "-1001234567890": { requireMention: false }  // always respond in this group
      }
    }
  }
}
```

**Privacy mode:** Telegram bots default to Privacy Mode, which limits what group messages they receive. If the bot must see all group messages (for `requireMention: false`):

- BotFather: `/setprivacy` > Disable
- Then remove and re-add the bot to each group

### Forum topics

Supergroups with topics get independent sessions per topic:

```json5
{
  channels: {
    telegram: {
      groups: {
        "<chatId>": {
          topics: {
            "<threadId>": {
              requireMention: false,
              systemPrompt: "You are a helpful assistant for this topic.",
            },
          },
        },
      },
    },
  },
}
```

Topic entries inherit group settings unless overridden.

### Streaming and live preview

Telegram supports live-editing messages as the agent generates text:

```json5
{
  channels: {
    telegram: {
      streamMode: "partial", // "off" | "partial" | "block"
    },
  },
}
```

- `off`: no preview, send final message only
- `partial`: frequent edits with partial text as it streams
- `block`: chunked preview updates

### Message actions

Telegram exposes more agent tools than WhatsApp:

| Action          | Config gate                      | Description              |
| --------------- | -------------------------------- | ------------------------ |
| `sendMessage`   | `actions.sendMessage`            | Send to specific chat ID |
| `react`         | `actions.reactions`              | Add emoji reaction       |
| `editMessage`   | `actions.editMessage`            | Edit a sent message      |
| `deleteMessage` | `actions.deleteMessage`          | Delete a message         |
| `sticker`       | `actions.sticker` (default: off) | Send/search stickers     |

### Inline buttons

```json5
{
  channels: {
    telegram: {
      capabilities: {
        inlineButtons: "allowlist", // "off" | "dm" | "group" | "all" | "allowlist"
      },
    },
  },
}
```

Callback clicks are passed to the agent as: `callback_data: <value>`

### Custom commands

Register commands in the Telegram menu:

```json5
{
  channels: {
    telegram: {
      customCommands: [
        { command: "backup", description: "Git backup" },
        { command: "generate", description: "Create an image" },
      ],
    },
  },
}
```

### Webhook mode

Default is long polling. For webhook:

```json5
{
  channels: {
    telegram: {
      webhookUrl: "https://your-domain.com/telegram-webhook",
      webhookSecret: "your-secret-here",
      webhookPath: "/telegram-webhook", // default
      webhookHost: "127.0.0.1", // default
    },
  },
}
```

### Reaction notifications

```json5
{
  channels: {
    telegram: {
      reactionNotifications: "own", // "off" | "own" | "all" (default: "own")
      reactionLevel: "minimal", // "off" | "ack" | "minimal" | "extensive"
    },
  },
}
```

`own` means reactions to bot-sent messages only.

### Ack reactions

Resolution order:

1. `channels.telegram.accounts.<id>.ackReaction`
2. `channels.telegram.ackReaction`
3. `messages.ackReaction`
4. Agent identity emoji fallback (default: "👀")

Set to `""` to disable.

---

## Common concepts

### Configuration hierarchy

Both channels follow the same precedence:

1. **Account-level** (highest): `channels.<ch>.accounts.<id>.<field>`
2. **Channel-level**: `channels.<ch>.<field>`
3. **Global**: `messages.<field>`
4. **Hard defaults** (lowest)

### Pairing

Both channels default to `dmPolicy: "pairing"`. The flow is identical:

1. Unknown sender messages the bot
2. Bot sends pairing code
3. Operator approves: `openclaw pairing approve <channel> <CODE>`
4. Sender added to persistent allow-store

Manage pairings:

```bash
openclaw pairing list <channel>
openclaw pairing approve <channel> <CODE>
```

### Session isolation

- **DMs:** One session per unique sender
- **Groups:** One session per group (WhatsApp) or group+topic (Telegram)
- Sessions are independent -- conversation history does not leak between them

### Channel routing

Replies are deterministic: a message received on WhatsApp is replied to on WhatsApp. The agent does not pick channels. Multiple channels can run simultaneously.

---

## Quick reference: minimal configs

**WhatsApp -- open to everyone:**

```json5
{
  channels: {
    whatsapp: {
      dmPolicy: "open",
      allowFrom: ["*"],
      groupPolicy: "open",
    },
  },
}
```

**WhatsApp -- locked down:**

```json5
{
  channels: {
    whatsapp: {
      dmPolicy: "allowlist",
      allowFrom: ["+15551234567"],
      groupPolicy: "disabled",
    },
  },
}
```

**Telegram -- standard setup:**

```json5
{
  channels: {
    telegram: {
      enabled: true,
      botToken: "123456:ABC-DEF...",
      dmPolicy: "pairing",
      groups: { "*": { requireMention: true } },
    },
  },
}
```

**Both channels simultaneously:**

```json5
{
  channels: {
    whatsapp: {
      dmPolicy: "pairing",
      allowFrom: ["+15551234567"],
    },
    telegram: {
      enabled: true,
      botToken: "123456:ABC-DEF...",
      dmPolicy: "pairing",
    },
  },
}
```
