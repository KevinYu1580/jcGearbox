<p align="center">
  <img src="docs/assets/banner.svg" alt="jcGearbox: Right model. Right effort. Every prompt." width="100%">
</p>

# jcGearbox

English · [繁體中文](README.zh-TW.md)

In Claude Code you pick one model and one effort level and they apply to every prompt, so simple work overpays and hard work is under-powered. jcGearbox is a Claude Code mod that asks [TypeSafe's Jev](https://typesafe.ai), a fast judgment model, how hard each prompt is and sets the model and effort to match.

- **Model**: picked on a session's first prompt, then kept for the whole session to keep the prompt cache.
- **Effort**: picked again on every prompt.
- Tiers and levels follow Anthropic's [model selection matrix](https://platform.claude.com/docs/en/about-claude/models/choosing-a-model#model-selection-matrix) and [effort levels](https://platform.claude.com/docs/en/build-with-claude/effort#effort-levels).

It starts in **shadow** mode: it shows its pick in the status line but sends your requests unchanged. Switch to `auto` once `/jcGearbox-log` has convinced you; the evidence that Jev judges difficulty well is thin.

> [!IMPORTANT]
> **A new model or effort costs the prompt cache.** Run jcGearbox on an Anthropic API key or a Claude subscription, with every tier on Opus 5.5, Sonnet 5.5, Haiku 5.5 or Fable 5.1: only there does a new effort every prompt keep the cache. Anywhere else (Bedrock, Vertex AI, a gateway, older models), set `min_effort` and `max_effort` to the same level, so only the model is routed. See the [reference](docs/README.md#prompt-cache).

## Requirements

- Claude Code 2.1.286 or newer. Mods are an early-access API, so a Claude Code release can break this one.
- A TypeSafe API key from [console.typesafe.ai](https://console.typesafe.ai).

## Install

```
/plugin marketplace add KevinYu1580/jcGearbox
/plugin install jc-gearbox@jc-gearbox
```

Then run **`/jcGearbox-setup`**, which walks you through the key, the mode and the main settings. Without a key the mod does nothing and the status line says `no API key`.

**Recommended: turn on `send_assistant_tail`** (off by default). It sends the end of Claude's last reply to TypeSafe, but Jev judges much better with it.

```bash
echo '{"send_assistant_tail": "true"}' | claude plugin configure jc-gearbox@jc-gearbox --values-stdin
```

## How it works

**Model**: on a session's first prompt, Jev picks a tier. The model moves to a stronger tier at 0.5 probability that one is needed, to a weaker tier only at 0.8 that one will do, and otherwise stays on your model.

| Tier | For | Default |
|---|---|---|
| `strong` | Complex agentic coding, large refactors, hard debugging | `opus` |
| `balanced` | Everyday coding, data analysis | `sonnet` |
| `low` | Fast, cheap, high-volume tasks | `haiku` |
| `long` | Agent sessions that run for hours, deep research | `fable` (costs the most; `off` disables it) |

**Effort**: every prompt starts from Jev's score (`low`–`max`); a prompt that only continues the last task ("ok", "go on") keeps the last effort; saying the last attempt failed goes up one level; anything that could do hard-to-undo damage (production, data deletion, force-push…) gets at least `high`; the result is kept between `min_effort` and `max_effort` and lowered to what the model takes.

If Jev errors or times out (3 s by default), nothing changes for that prompt. The full rules, diagrams and per-model effort table are in the [reference](docs/README.md#picking-the-model).

## Commands

| Command | Does |
|---|---|
| `/jcGearbox-setup` | Guided setup |
| `/jcGearbox-status` (or `/jcGearbox`) | Mode, model, effort and the model each tier resolves to |
| `/jcGearbox-auto`, `/jcGearbox-shadow`, `/jcGearbox-off`, `/jcGearbox-on` | Mode for this session |
| `/jcGearbox-pin <model>` | Pin a model for this session |
| `/jcGearbox-log [n]` | Last `n` decisions |
| `/jcGearbox-stats` | Decisions, Jev's errors and latency, prompt cache hit rates and more |

A `/model` or `/effort` of your own after the first prompt stops the mod changing that for the session; `/jcGearbox-auto` clears those overrides. Plan mode and other details are in [Overriding it](docs/README.md#overriding-it).

The status line shows what was actually sent in `auto` (e.g. `opus-5-5·high`) and Jev's pick in shadow (e.g. `shadow ▸ opus-5-5·high`).

## Settings

Set them with `/jcGearbox-setup` or `/plugin configure jc-gearbox@jc-gearbox`. The ones you are most likely to change:

| Setting | Default | Meaning |
|---|---|---|
| `default_mode` | `shadow` | `shadow`, `auto` or `off` for new sessions |
| `low_model`, `balanced_model`, `strong_model`, `long_model` | `haiku`, `sonnet`, `opus`, `fable` | The model for each tier; `off` disables it |
| `min_effort`, `max_effort` | `low`, `max` | Range of efforts the mod may set |
| `send_assistant_tail` | off (recommended on) | Also send the end of Claude's last reply |

On Bedrock, Vertex, Foundry or a gateway, give at least two tiers full model ids. Every setting is in the [reference](docs/README.md#settings).

## Privacy

For each prompt you send, TypeSafe receives the prompt (up to ~6000 characters), your previous prompt (up to ~1000), the session's current model and last effort, and, with `send_assistant_tail` on, the end of Claude's last reply. Common key and token shapes are replaced with `[redacted]` before sending; other secrets you paste go as they are. TypeSafe says it does not train on this data but doesn't say how long it keeps it. The local log lives in `~/.claude/plugins/store/jc-gearbox_*.json`; delete it to clear it. Full details in [Privacy](docs/README.md#privacy).

## License

[MIT](LICENSE)
