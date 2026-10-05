# jev-cc-model-router

English · [繁體中文](README.zh-TW.md)

A Claude Code mod (a plugin of function hooks) that asks [TypeSafe's Jev](https://typesafe.ai) how hard your task is, then:

- **picks the model once per session**: Sonnet for everyday work, Opus when the first prompt of a session looks hard, without you switching by hand;
- **picks the effort every turn**: lower for easy turns so replies come back faster, higher when you say the last attempt failed or the task is risky.

It starts in **shadow mode**: it judges every turn and shows what it would do in the status line, but changes nothing until you turn on `auto`. Watch it for a while and decide whether Jev's judgement is good enough for you (see [Limitations](#limitations)).

## Requirements

- Claude Code **2.1.286 or newer**. The mod API is early access and may change without notice in any release.
- A TypeSafe API key ([console.typesafe.ai](https://console.typesafe.ai)).

## Install

```
/plugin marketplace add KevinYu1580/jev-cc-model-router
/plugin install jev-cc-model-router@jev-cc-model-router
```

Give it your key in the plugin's settings (`api_key`), or set the `TYPESAFE_API_KEY` environment variable. Without a key the mod does nothing.

## How it decides

### Model: once per session

On the first prompt you type in a session, Jev is asked which tier the task needs:

| Tier | Meant for | Default model |
|---|---|---|
| `low` | Lookups, explanations, renames, formatting, running a command, one-line edits | `sonnet` |
| `balanced` | A typical feature or bug fix in one module, writing tests, a single-file refactor | `sonnet` |
| `strong` | Cross-module design, hard debugging (concurrency, performance, memory), architecture, security, unclear requirements | `opus` |
| `long` | Hours of autonomous work, repo-wide migrations or audits | off (set `fable` to enable) |

Tiers that map to the same model add their probabilities together. The model changes only when the winning model gets at least `tier_min_probability` (0.6); otherwise the session keeps the model you picked. A tie goes to the stronger model.

After the first prompt the model **never changes on its own**, so the mod never throws the prompt cache away mid-session. A new session or `/clear` decides again; `--resume` and compaction keep the decision. (Compaction itself still runs on the model you picked: see [Limitations](#limitations).)

### Effort: every prompt you type

1. Start from Jev's effort score (`low`, `medium`, `high`, `xhigh`, `max`). If the prompt just continues the previous task ("ok", "go ahead", a short answer), keep the previous effort instead.
2. If you say the last attempt was wrong or failed, go one level up (at most `max`).
3. If a mistake could do hard-to-reverse damage (production, data deletion, migrations, auth, money, force-push), use at least `xhigh`.
4. Never go below `min_effort`.

A signal counts only when Jev's probability is above `signal_threshold` (0.7). When you complain and the effort is already `max` on a model other than Opus or Fable, the status line suggests `/jcmr pin opus`.

Background-task notifications, scheduled prompts and messages from other sessions are never sent to Jev; those turns keep the session's current model and effort. Subagents are never touched.

### When Jev fails

Any Jev error or a reply slower than 1.5 seconds makes no new decision, and the status line says why (`Jev HTTP 401`, `Jev timeout`). On the session's first prompt the request then goes out as it would without the mod, and the session keeps your model for good; on later prompts the session's model and the previous effort carry on.

## Your choices win

| You do | Effect |
|---|---|
| `/jcmr pin <alias or full id>` | This session uses that model (in `auto` mode) |
| Switch model with `/model` or the picker after the first prompt | The mod stops changing the model for this session and drops any pin |
| Change the effort with `/effort` or the picker after the first prompt | The mod stops changing the effort for this session |
| `/jcmr auto` | Back to `auto`, and every pin above is cleared. In a session that started in shadow, the model the status line showed takes effect on the next request (one prompt-cache rewrite) |

An effort already set when the session starts is taken as the starting point, not as your choice: to keep it, set it again after the first prompt, or use `/jcmr off`.

A slash command that sets its own effort for its turn (a skill's `effort:` frontmatter, `/code-review max`) keeps it for that turn and pins nothing.

To go back to the model you started the session with after the mod picked another, use `/jcmr pin <model>`: choosing the same model again in `/model` or the picker is no switch as far as Claude Code is concerned, so the mod never hears of it.

## Commands

| Command | Does |
|---|---|
| `/jcmr` | Shows the mode, the model and effort state, and Jev's scores for the last prompt |
| `/jcmr auto` / `shadow` / `off` | Sets the mode for **this session**. The default for new sessions is the `default_mode` setting |
| `/jcmr pin <model>` | Pins a model for this session |
| `/jcmr log [n]` | Lists the last `n` decisions (20 by default) across all sessions |

## Status line

```
jcmr ▸ opus-5-5·high                 auto
jcmr(shadow) ▸ opus-5-5·high         shadow: what auto would do
jcmr: no API key
jcmr: needs Claude Code 2.1.286+
```

Notes are appended when they apply: `model pinned`, `effort pinned`, `try /jcmr pin opus`, `built-in model table`, `Jev <error>`. If the API answers with a different model than the one requested, or the request gets no response at all and the turn ends in an error, you see `jcmr: <model> was not used (<model> answered); not switching to it again` (`no response` in the brackets for the latter).

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `api_key` | empty | TypeSafe key. Falls back to `TYPESAFE_API_KEY` |
| `default_mode` | `shadow` | Mode for new sessions: `shadow`, `auto` or `off` |
| `low_model`, `balanced_model`, `strong_model` | `sonnet`, `sonnet`, `opus` | Alias (`haiku`, `sonnet`, `opus`, `fable`) or full model id. Empty disables the tier |
| `long_model` | empty | Set `fable` to enable |
| `tier_min_probability` | 0.6 | Minimum probability to change the session's model |
| `signal_threshold` | 0.7 | Probability above which "continuation", "the last attempt failed" and "high stakes" count |
| `min_effort` | `low` | Lowest effort the mod sets |
| `jev_model` | `jev-latest` | Set a version such as `jev-1.13.0` to pin one |
| `send_assistant_tail` | off | Also send the last ~1000 characters of Claude's previous reply (see Privacy) |

### Model names

A full model id is used as written. An alias is turned into the current model id from Claude Code's own model list (the cache under `~/.claude/cache/model-catalog/`), falling back to a built-in table (`built-in model table` in the status line).

Aliases work only when you log in to Claude Code with your Anthropic account. To check that, the mod calls Claude Code's `authorize()` and only looks at whether it answers at all: **the handle it returns is never used, and the mod never reads or sends your credentials.** On Bedrock, Vertex, Foundry or an LLM gateway, aliases resolve to nothing and those tiers are disabled: enter full model ids, or the mod only adjusts effort.

**Haiku as `low_model`:** Haiku does not take an effort setting and has a 200K context window. If the first prompt picks it, the whole session stays on Haiku unless you `/jcmr pin` another model.

## Privacy

For each prompt you type, the mod sends TypeSafe only:

- the prompt (up to ~6000 characters; longer ones keep the start and the end);
- your previous prompt (up to ~1000 characters);
- the session's current model and the previous effort;
- with `send_assistant_tail` on, the last ~1000 characters of Claude's previous reply.

It never sends code, file contents or tool results, unless you pasted them into your prompt or turned on `send_assistant_tail`. Notifications, subagent reports and other turns you did not type are never sent.

According to TypeSafe, data is not used for training, but the retention period is not stated, the servers are in the US, and zero retention is offered on the enterprise plan only.

Locally (in Claude Code's plugin store), the mod keeps the first 200 characters of each prompt in its decision log, your last prompt (1000 characters) per session and, with `send_assistant_tail` on, the last ~1000 characters of Claude's last reply per session (kept until that session's record is pruned, even after you turn the option off). It keeps the latest 200 decisions and 200 sessions.

## Limitations

- The evidence that Jev can judge task difficulty is weak: the reference implementation's own evaluation reports an AUC of 0.570, with a confidence interval that includes chance, and there is no data for Chinese prompts. That is what shadow mode is for.
- The mod API is early access; any Claude Code release may break it.
- Compaction (automatic or `/compact`) and Claude Code's other side requests do not pass through the hook the mod rewrites, so they run on the model you picked, at its own effort. When the mod moved the session to another model, those requests cannot read the conversation's prompt cache, and your picked model writes the summary.
- The model list cache is a Claude Code internal file whose format can change; the mod then falls back to its built-in table, which needs an update when new models ship.
- Changing the effort has been observed not to invalidate the prompt cache only on Opus 5.5 with Claude Code 2.1.280 and later, on a small sample.

## Development

```
claude plugin validate .claude-plugin/plugin.json
claude plugin validate .
claude plugin test .
```

The first validates the manifest and the hooks module; the second, run on a folder with a `marketplace.json`, validates only the marketplace.

To try a local checkout, load it with `claude --plugin-dir /path/to/jev-cc-model-router`, or name the folder in `CLAUDE_CODE_PLUGIN_DIRS` (plus `CLAUDE_CODE_PLUGIN_DIR_WATCH=1` to reload on save) in the `env` block of `~/.claude/settings.json` for the desktop app. The design is in [docs/SPEC.md](docs/SPEC.md) (Traditional Chinese).

## License

[MIT](LICENSE)
