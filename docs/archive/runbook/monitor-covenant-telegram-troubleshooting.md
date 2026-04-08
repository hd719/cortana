# Monitor ↔ Covenant Telegram Visibility Troubleshooting

Use this when `@monitorhdbot` appears online but does not see/respond to Covenant group messages.

## Fast diagnosis

1. **Confirm correct chat id**
   - Covenant group id should be `-5006548746`.
   - If session history shows a different id, routing is wrong.

2. **Confirm OpenClaw routing/session key**
   - Expected session key: `agent:monitor:telegram:group:-5006548746`
   - Check in: `~/.openclaw/agents/monitor/sessions/sessions.json`

3. **Confirm binding goes to Monitor account**
   - In `~/.openclaw/openclaw.json`, ensure a binding like:
   ```json
   { "agentId": "monitor", "match": { "channel": "telegram", "accountId": "monitor" } }
   ```

4. **Confirm group mention policy**
   - If `requireMention: true`, Monitor only reacts when explicitly mentioned.
   - For always-on monitoring in Covenant, set:
   ```json
   "channels": {
     "telegram": {
       "groups": {
         "-5006548746": { "groupPolicy": "open", "requireMention": false }
       }
     }
   }
   ```

5. **Confirm Telegram bot can receive group updates**
   - `getMe` should show `can_read_all_group_messages: true` for monitor bot.
   - Bot must still be present in the group (`getChatMember` status should be `member` or `administrator`).

6. **Restart gateway after config changes**
   - `openclaw gateway restart`

## Telegram app/admin checklist

In Telegram group settings for Covenant:

- Monitor bot is in the group.
- If using topics/threads heavily, prefer granting bot admin to avoid topic permission edge cases.
- In BotFather for monitor bot:
  - Privacy mode should be **disabled** for full group message visibility.
  - Re-add bot to group if permissions changed.

## Canonical symptom mapping

- **Only responds when tagged** → `requireMention: true` (OpenClaw policy), not transport failure.
- **Never responds, even when tagged** → bad binding/accountId, wrong bot token/account, or bot removed from group.
- **Works in DM but not group** → group policy/allowlist mismatch or Telegram privacy/admin settings.

## Recommended baseline for Covenant

For Covenant group `-5006548746` and monitor account:

- Binding to `agentId: monitor` + `accountId: monitor`
- Group policy open
- `requireMention: false`
- Bot privacy disabled
- Gateway restarted after changes
