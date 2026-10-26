<p align="center">
  <img src="docs/assets/banner.svg" alt="jcGearbox: Right model. Right effort. Every prompt." width="100%">
</p>

# jcGearbox

[English](README.md) · 繁體中文

在 Claude Code 裡，你選一個 model 和一個 effort，之後所有 prompt 都用它：簡單的事付大錢，難題又用了太弱的設定。jcGearbox 是一個 Claude Code mod，每個 prompt 先問 [TypeSafe 的 Jev](https://typesafe.ai)（一個快速的判斷 model）有多難，再替你調整 model 和 effort。

- **model**：session 的第一個 prompt 決定，之後整個 session 不變，以保住 prompt cache。
- **effort**：每個 prompt 都重新決定。
- tier 和等級依照 Anthropic 官方的 [model 選擇矩陣](https://platform.claude.com/docs/zh-TW/about-claude/models/choosing-a-model#model-selection-matrix)和 [effort 等級](https://platform.claude.com/docs/zh-TW/build-with-claude/effort#effort-levels)。

預設是 **shadow** 模式：只在狀態列顯示它的選擇，請求原樣送出。看 `/jcGearbox-log` 覺得可信後再切到 `auto`；Jev 判斷難度準不準，目前證據還很少。

> [!IMPORTANT]
> **換 model 或 effort 會讓 prompt cache 失效。** 建議用 Anthropic API key 或 Claude 訂閱，且每個 tier 都落在 Opus 5.5、Sonnet 5.5、Haiku 5.5 或 Fable 5.1：只有這樣，每個 prompt 換 effort 才不會讓快取失效。其他環境（Bedrock、Vertex AI、gateway、較舊的 model 等）請把 `min_effort` 和 `max_effort` 設成同一級，只讓 mod 選 model。詳見[詳細說明](docs/README.zh-TW.md#prompt-cache)。

## 需求

- Claude Code 2.1.286 以上。mod 是 early access API，Claude Code 改版可能讓它失效。
- TypeSafe API key，到 [console.typesafe.ai](https://console.typesafe.ai) 申請。

## 安裝

```
/plugin marketplace add KevinYu1580/jcGearbox
/plugin install jc-gearbox@jc-gearbox
```

接著執行 **`/jcGearbox-setup`**，它會一步步帶你設好 key、模式和主要設定。沒有 key 時 mod 什麼都不做，狀態列顯示 `no API key`。

**建議開啟 `send_assistant_tail`**（預設關）：它會把 Claude 上一則回答的結尾送到 TypeSafe，但 Jev 會判斷得準很多。

```bash
echo '{"send_assistant_tail": "true"}' | claude plugin configure jc-gearbox@jc-gearbox --values-stdin
```

## 運作方式

**model**：session 的第一個 prompt 請 Jev 選 tier。Jev 認為需要較強 tier 的機率 ≥ 0.5 就換強，認為較弱 tier 就夠的機率 ≥ 0.8 才換弱，否則維持你選的 model。

| Tier | 用途 | 預設 |
|---|---|---|
| `strong` | 複雜的代理式 coding、大型重構、困難除錯 | `opus` |
| `balanced` | 日常 coding、資料分析 | `sonnet` |
| `low` | 快速、便宜、大量的任務 | `haiku` |
| `long` | 持續數小時的 agent session、深度研究 | `fable`（最貴，可填 `off` 停用） |

**effort**：每個 prompt 從 Jev 的分數（`low`–`max`）出發；只是接續上一件事（「好」、「繼續」）就沿用上一回合的；說上次失敗就升一級；可能造成難以挽回損害的操作（正式環境、刪資料、force-push 等）至少 `high`；最後限制在 `min_effort`–`max_effort`，並降到該 model 支援的等級。

Jev 出錯或逾時（預設 3 秒）時，這個 prompt 什麼都不改。完整規則、流程圖和各 model 支援的 effort 見[詳細說明](docs/README.zh-TW.md#怎麼選-model)。

## 指令

| 指令 | 作用 |
|---|---|
| `/jcGearbox-setup` | 引導設定 |
| `/jcGearbox-status`（或 `/jcGearbox`） | 目前的模式、model、effort 與各 tier 對應的 model |
| `/jcGearbox-auto`、`/jcGearbox-shadow`、`/jcGearbox-off`、`/jcGearbox-on` | 切換這個 session 的模式 |
| `/jcGearbox-pin <model>` | 這個 session 固定用某個 model |
| `/jcGearbox-log [n]` | 最近 `n` 筆決策 |
| `/jcGearbox-stats` | 決策、Jev 錯誤率與延遲、prompt cache 命中率等統計 |

第一個 prompt 之後自己打 `/model` 或 `/effort`，mod 這個 session 就不再改那一項；`/jcGearbox-auto` 會清掉這些覆寫。plan mode 等細節見[手動覆寫](docs/README.zh-TW.md#手動覆寫)。

狀態列在 `auto` 模式顯示實際送出的 model 和 effort（如 `opus-5-5·high`），在 shadow 模式顯示 Jev 的選擇（如 `shadow ▸ opus-5-5·high`）。

## 設定

用 `/jcGearbox-setup` 或 `/plugin configure jc-gearbox@jc-gearbox` 修改。最常調的幾項：

| 設定 | 預設 | 說明 |
|---|---|---|
| `default_mode` | `shadow` | 新 session 的模式：`shadow`、`auto` 或 `off` |
| `low_model`、`balanced_model`、`strong_model`、`long_model` | `haiku`、`sonnet`、`opus`、`fable` | 各 tier 用的 model；填 `off` 停用 |
| `min_effort`、`max_effort` | `low`、`max` | mod 可設定的 effort 範圍 |
| `send_assistant_tail` | 關（建議開） | 一併送出 Claude 上一則回答的結尾 |

用 Bedrock、Vertex、Foundry 或 gateway 時，請至少替兩個 tier 填完整 model ID。全部設定見[詳細說明](docs/README.zh-TW.md#設定)。

## 隱私

每個你送出的 prompt，TypeSafe 會收到：這次的 prompt（最多約 6000 字）、上一個 prompt（最多約 1000 字）、session 目前的 model 和上一回合的 effort，以及開啟 `send_assistant_tail` 時 Claude 上一則回答的結尾。常見的 key 與 token 格式送出前會換成 `[redacted]`，其他 secret 仍原樣送出。TypeSafe 表示不拿這些資料訓練，但沒寫明保留多久。本機紀錄存在 `~/.claude/plugins/store/jc-gearbox_*.json`，刪掉就會清空。完整說明見[隱私](docs/README.zh-TW.md#隱私)。

## 授權

[MIT](LICENSE)
