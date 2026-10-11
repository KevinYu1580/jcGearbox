---
name: jcmr-setup
description: Set up the jev-cc-model-router plugin step by step - API key, mode, sending Claude's reply to Jev, and a check that it runs. Use when the person runs /jcmr-setup or asks to set up, configure or install jcmr / jev-cc-model-router.
---

# Set up jev-cc-model-router

Walk the person through these steps in order. Ask with AskUserQuestion where there is a choice, explain each choice in one or two plain sentences, and keep their current value when they want no change. Answer in the person's language.

The settings live in `~/.claude/settings.json` under `pluginConfigs["jev-cc-model-router@jev-cc-model-router"].options`. Read only that object, and never print `api_key` or any environment value.

Write a setting by piping a JSON object of strings to the CLI (numbers and booleans as strings too):

```bash
echo '{"default_mode": "shadow"}' | claude plugin configure jev-cc-model-router@jev-cc-model-router --values-stdin
```

## 1. The plugin is installed and enabled

Run `claude plugin list` and find `jev-cc-model-router@jev-cc-model-router`. If it is missing, give the person the two install commands from the README. If it is disabled, ask before running `claude plugin enable jev-cc-model-router@jev-cc-model-router`.

## 2. A TypeSafe API key

Check whether a key is set without showing it: the `TYPESAFE_API_KEY` variable (`[ -n "$TYPESAFE_API_KEY" ]`) or a key under the plugin's options. If there is none:

- Send them to https://console.typesafe.ai to create one.
- Do not take the key in chat and do not type it anywhere yourself. The person sets it with `/plugin configure jev-cc-model-router@jev-cc-model-router` (stored in secure storage) or adds `TYPESAFE_API_KEY` to the `env` block of `~/.claude/settings.json`.

## 3. Mode (`default_mode`)

- `shadow` (default): judges every prompt and shows the pick in the status line, but sends requests unchanged. Good for the first days.
- `auto`: changes the model and effort for real.
- `off`: does nothing until `/jcmr-on`.

## 4. Send the end of Claude's reply (`send_assistant_tail`)

Recommend turning it on. Jev decides whether a prompt like "here are the results" continues the last task far better when it sees what Claude said before it. The cost is privacy: the end of Claude's reply, which can hold code or error messages, goes to TypeSafe. If they turn it on, `assistant_tail_chars` (default 1000, 100 to 8000) sets how much; about 700 tokens per 1000 characters, a fraction of a cent a day.

## 5. Optional: the models

Mention the defaults in one line each and change them only if asked: `low_model` haiku, `balanced_model` sonnet, `strong_model` opus, `long_model` fable (the most expensive; `off` turns it off). On Bedrock, Vertex, Foundry or a gateway the aliases do not resolve, so each tier needs a full model id.

## 6. Check

Tell the person to restart Claude Code (settings apply at start), send any prompt, and look for `jcmr ▸ …` or `jcmr(shadow) ▸ …` in the status line. `jcmr: no API key` or `Jev HTTP 401` means the key is missing or wrong. `/jcmr-status` shows the full state and `/jcmr-log` the decisions.

End with a short list of what was set.
