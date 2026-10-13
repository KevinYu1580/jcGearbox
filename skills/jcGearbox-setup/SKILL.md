---
name: jcGearbox-setup
description: Set up the jcGearbox plugin step by step - API key, mode, sending Claude's reply to Jev, and a check that it runs. Use when the person runs /jcGearbox-setup or asks to set up, configure or install jcGearbox.
---

# Set up jcGearbox

Walk the person through these steps in order. Ask with AskUserQuestion where there is a choice, explain each choice in one or two plain sentences, and keep their current value when they want no change. Answer in the person's language.

Read the current settings with the CLI, never by reading `~/.claude/settings.json` (its `env` block can hold other secrets, and `api_key` is not kept there):

```bash
claude plugin configure jc-gearbox@jc-gearbox --json
```

`inputs` holds each setting's current value, `configured` lists the ones that are set, and a sensitive setting such as `api_key` never shows its value. Never print `api_key` or any environment value.

Write a setting by piping a JSON object of strings to the CLI (numbers and booleans as strings too):

```bash
echo '{"default_mode": "shadow"}' | claude plugin configure jc-gearbox@jc-gearbox --values-stdin
```

## 1. The plugin is installed and enabled

Run `claude plugin list` and find `jc-gearbox@jc-gearbox`. If it is missing, give the person the two install commands from the README. If it is disabled, ask before running `claude plugin enable jc-gearbox@jc-gearbox`.

## 2. A TypeSafe API key

A key is set when `api_key` is in `configured`, or when `[ -n "$TYPESAFE_API_KEY" ]` is true; check without showing it. If the configure command fails, ask the person rather than assume there is no key. If there is none:

- Send them to https://console.typesafe.ai to create one.
- Do not take the key in chat and do not type it anywhere yourself. The person sets it with `/plugin configure jc-gearbox@jc-gearbox`, which keeps it in secure storage. Adding `TYPESAFE_API_KEY` to the `env` block of `~/.claude/settings.json` also works, but keeps it there in plain text and passes it to every command and MCP server Claude Code starts.

## 3. Mode (`default_mode`)

- `shadow` (default): judges every prompt and shows the pick in the status line, but sends requests unchanged. Good for the first days.
- `auto`: changes the model and effort for real.
- `off`: does nothing until `/jcGearbox-on`, which then turns `auto` on for that session.

## 4. Send the end of Claude's reply (`send_assistant_tail`)

Recommend turning it on. Jev decides whether a prompt like "here are the results" continues the last task far better when it sees what Claude said before it. The cost is privacy: the end of Claude's reply, which can hold code or error messages, goes to TypeSafe. If they turn it on, `assistant_tail_chars` (default 1000, 100 to 8000) sets how much; about 700 tokens per 1000 characters, a fraction of a cent a day.

## 5. Optional: the models

Mention the defaults in one line each and change them only if asked: `low_model` haiku, `balanced_model` sonnet, `strong_model` opus, `long_model` fable (the most expensive; `off` turns it off). Switching to Fable skips Claude Code's confirmation for models billed to usage credits, so on a plan that bills Fable to credits they are spent without asking. An alias may end in `[1m]` for the 1M context. On Bedrock, Vertex, Foundry or a gateway the aliases do not resolve, so each tier needs a full model id.

## 6. Check

Tell the person to run `/reload-plugins` (or start a new session) so the settings apply, send any prompt, and look for `opus-5-5·high` or `shadow ▸ opus-5-5·high` in the status line. `no API key` or `Jev HTTP 401` means the key is missing or wrong. `/jcGearbox-status` shows the full state and `/jcGearbox-log` the decisions.

End with a short list of what was set.
