# Inbound Flows

Inbound flows live in the vault `_flows` collection as JSON documents.

They are matched before the normal inbound reply run. A matching flow injects
trusted flow context into the current agent turn. The agent then uses its
normal tools to decide whether the message semantically matches the flow and to
perform any required actions.

## Flow Schema

```json
{
  "enabled": true,
  "kind": "inbound_message",
  "name": "Parent absence",
  "priority": 100,
  "trigger": {
    "channels": ["whatsapp"],
    "senders": ["+49123456789"]
  },
  "vars": {
    "student_name": "Maria Popescu",
    "presence_collection": "elevi",
    "presence_path": "Prezenta elevi.md"
  },
  "instruction": "You are handling a school attendance automation for {{student_name}}. If the parent's message means the student will be absent on the next school day or on an explicitly mentioned date, update {{presence_collection}}/{{presence_path}} accordingly using vault tools. Then reply in Romanian with exactly: \"Mulțumesc pentru mesaj, luăm notă de informație.\" Then use the message tool to notify the owner on Telegram that the presence list for {{student_name}} was updated. If the message instead says the student will attend, update attendance accordingly and still reply politely. If the message is unrelated or ambiguous, do not update the file automatically; ask a concise follow-up question or handle it normally."
}
```

## Trigger Fields

- `channels`: exact channel ids like `whatsapp`, `telegram`, `imessage`
- `accountIds`: optional account ids for multi-account channels
- `senders`: exact sender matches against inbound identifiers like `from`, `senderId`, `senderE164`, or `senderUsername`
- `conversationIds`: exact conversation target matches

All trigger matches are exact and case-insensitive.

## Template Variables

Flow `instruction` supports `{{var}}` replacements from:

- `vars.*`
- `{{from}}`
- `{{content}}`
- `{{channel_id}}`
- `{{account_id}}`
- `{{conversation_id}}`
- `{{session_key}}`
- `{{agent_id}}`
- `{{sender_id}}`
- `{{sender_e164}}`
- `{{sender_name}}`
- `{{sender_username}}`
- `{{to}}`
- `{{now_iso}}`
- `{{today}}`

## Notes

- Matching a flow does not force the agent to execute it blindly. The injected
  flow context explicitly tells the agent to apply the flow only if the message
  semantically matches the instruction.
- Multiple matching flows are injected in descending `priority` order.
- The paired agent must have vault read access to `_flows`.
