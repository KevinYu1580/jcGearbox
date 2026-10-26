<!-- 維護者：這份要和 docs/README.md、以及 ../README.zh-TW.md 的摘要保持一致。 -->
# jcGearbox 詳細說明

[English](README.md) · 繁體中文 · [回到 README](../README.zh-TW.md)

[README](../README.zh-TW.md) 背後的完整細節：model 和 effort 怎麼選、所有手動覆寫方式、設定與隱私條款。

## Prompt cache

**換 model 或 effort 會讓 prompt cache 失效。** Claude Code 的對話快取依 model 分開，多數 model 還依 effort 等級分開；一換，下一個請求就要把整段對話重新讀過，沒有快取（[Claude Code 文件](https://code.claude.com/docs/zh-TW/prompt-caching)）：

- **model**：每次切換都會。所以 jcGearbox 每個 session 只選一次 model。`auto` 模式下，session 中途用 `/jcGearbox-pin`、`/jcGearbox-off`、`/jcGearbox-shadow` 或 `/model` 也算切換。
- **effort**：每次改都會，只有 Opus 5.5、Sonnet 5.5、Haiku 5.5、Fable 5.1 搭配 Anthropic API key 或 Claude 訂閱時例外。Amazon Bedrock、Google Cloud 的 Agent Platform（Vertex AI）、Claude apps gateway、設了 `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`、HIPAA 組織都沒有這個例外，Opus 5、4.x 這類較舊的 model 也沒有。

**因此建議用 Anthropic API key 或 Claude 訂閱，而且每個 tier 都落在這四個 model 上**（各 tier 實際對應哪個 model，看 `/jcGearbox-status`）：這樣每個 prompt 換 effort 也不會讓快取失效。其他環境請把 `min_effort` 和 `max_effort` 設成同一級，只讓 mod 選 model。`/jcGearbox-stats` 會列出換了 effort 和沒換時，prompt 從快取讀到的比例。

## 怎麼選 model

session 的第一個 prompt 會請 Jev 選 tier。選項把 Opus 放第一，因為[官方矩陣](https://platform.claude.com/docs/zh-TW/about-claude/models/choosing-a-model#model-selection-matrix)說多數工作從它開始。

| Tier | 用途 | 預設 |
|---|---|---|
| `strong` | 複雜的代理式 coding、大型重構、系統工程、困難除錯 | `opus` |
| `balanced` | 日常 coding、資料分析、代理式工具使用 | `sonnet` |
| `low` | 快速、便宜、大量或子代理型的任務 | `haiku` |
| `long` | 持續數小時的 agent session、深度研究 | `fable`（最貴；填 `off` 停用） |

- Jev 給「需要這個 tier 或更強」至少 0.5 的機率（`tier_upgrade_probability`）時，換成較強 tier 的 model；給「較弱的就夠」至少 0.8（`tier_min_probability`）時，才換成較弱 tier 的 model；否則維持你選的 model。這個 prompt 遇到 Jev 的網路錯誤或 5xx，時間還剩一秒以上就重試一次。
- 選擇會維持整個 session，避免 prompt cache 失效。新 session 或 `/clear` 會重新選；接續或 fork 的對話不會：fork 認得出來源 session 時沿用它的選擇，否則維持原本的 model。
- API 不讓用某個 model（沒有權限、沒有提供），或 model 拒答時，這個 session 不會再要求它，狀態列會說明原因；`/jcGearbox-auto` 會重新要求它。過載或伺服器錯誤（Claude Code 自己也視為暫時性）不算，任何 model 都會遇到的帳號問題（帳單、帳號停權、雲端憑證載入失敗）也不算。登入失敗或用量上限，只對這個 session 還沒回答過的 model 才算：Bedrock 或 Vertex 上沒開通的 model、要用你沒有的 usage credits 計費的 model，都是這樣失敗的。
- 這樣換成 Fable 時，不會出現 Claude Code 對「用 usage credits 計費的 model」的確認視窗：如果你的方案把 Fable 算進 credits，會直接扣。不想要就把 `long_model` 設成 `off`。

### 一個 session 裡 model 怎麼變

流程圖在 [README](../README.zh-TW.md#model)。

## 怎麼選 effort

等級依照官方的 [effort 文件](https://platform.claude.com/docs/zh-TW/build-with-claude/effort)。

流程圖在 [README](../README.zh-TW.md#effort)。完整步驟：

1. 從 Jev 的 effort 分數出發（`low` 到 `max`）。如果只是接續上一件事（「好」、「繼續」、貼上輸出），沿用上一回合的 effort。Jev 對自己的分數沒把握時（信心度低於 `effort_min_confidence`，0.7），也沿用上一回合的；還沒有上一回合的 effort 時（例如 session 的第一個 prompt），就不改 effort。
2. 你說上次失敗了，就升一級。
3. 出錯可能造成難以挽回的損害時（正式環境、刪資料、資料庫遷移、認證、金流、force-push），至少用 `high`。
4. 限制在 `min_effort` 和 `max_effort` 之間（以 `max_effort` 為準）。
5. 再降到該 model 能用的等級：

| model | 能用 | 沒送 effort 時 |
|---|---|---|
| Opus 5.5、Sonnet 5.5、Haiku 5.5 | `low`–`max` | `medium` |
| Opus 4.7 | `low`–`max` | `xhigh` |
| Fable、Mythos、Opus 5/4.8、Sonnet 5 | `low`–`max` | `high` |
| Opus 4.6、Sonnet 4.6、Mythos Preview | 沒有 `xhigh`（改成 `high`） | `high` |
| Opus 4.5 | 最高 `high` | `high` |
| Haiku 4.5 和更舊的 model | 不支援 effort | — |
| mod 不認得的 model ID | 全部等級 | `high` |

### 特殊情況

- **不是你打的 prompt**（通知、排程）不問 Jev，沿用 session 的 model 和上一回合的 effort。
- **子代理、`claude -p` 和 Agent SDK 的執行**一律不動（開啟 `fork_follows_route` 時，auto 模式下從主對話 fork 出去的子代理跟著 session 的 model；slash command 自帶 model 的那一回合 fork 出去的，維持 command 的 model）。
- **slash command 或 skill** 自己指定的 model 或 effort，在它那一回合照它的。
- **Ultracode** 不是 effort 等級，只是讓 Claude Code 能跑 workflow，所以照常選 model 和 effort；prompt 裡有這個關鍵字時，在 `/jcGearbox-log` 標示 `ultracode`（貼上的文字也算，也不檢查 workflow 有沒有開）。
- **Jev 出錯或逾時**：Jev 出錯或超過 `jev_timeout_seconds`（3 秒）沒回應時，這個 prompt 什麼都不改，狀態列會顯示原因。
- **等不等 Jev**：只有 Jev 的答案能改變請求時，請求才會等它：shadow 從不等；第一個 prompt 之後，effort 由你決定或 model 不支援 effort 時也不等（slash command 仍會等）。這時只有比 Jev 還快回來的第一則回覆，會等它的答案，最多到逾時。

## 手動覆寫

| 你 | mod |
|---|---|
| `/jcGearbox-pin <model>` | 這個 session 改用該 model（plan mode 除外，見下） |
| 第一個 prompt 之後打 `/model <名稱>`（即使是目前的 model），或在選單換成別的 model | 這個 session 不再改 model |
| 第一個 prompt 之後打 `/effort <等級>`（即使是目前的等級），或在選單換成別的 effort | 這個 session 不再改 effort |
| `/effort auto`（或 `unset`） | 重新開始調整 effort，從你最後實際跑的等級接下去（夾在 `min_effort` 與 `max_effort` 之間；你自己設的是數字時，不從任何等級接） |
| 進入 plan mode（含 `opusplan` 的規劃階段） | 規劃回合維持在夠強的 model，見下方 [Plan mode](#plan-mode) |
| `/jcGearbox-auto` | 清掉以上全部；effort 從你最後實際跑的等級接下去，同 `/effort auto` |

### Plan mode

- 那些回合不改寫到比 `balanced` 弱（要有設 balanced tier，且 API 回得了它；沒有時，不比 Claude Code 當下自己用的 model 弱）、也不比 Claude Code 為了規劃而升上去的 model 弱的 model（`opusplan` 下的 Opus、`haiku` 別名的 Sonnet：mod 不把它拉回來）。
- session 自己以較強的 model（Opus、Fable）啟動、被 mod 降下來時，只要 mod 選的是 `balanced` 或更強，規劃就用 mod 選的 model；pin 到認不出 tier 的 model 時照用。
- 第一個 prompt 在 plan mode 送出時，以 session 在 plan mode 之外所用的 model 為基準（`opusplan` 下是 Sonnet，`haiku` 別名是 Haiku），不以規劃時升上去的 model 為基準。
- 在 plan mode 裡，`/model` 指名它顯示的 model 或 Claude Code 規劃時用的 model，都算你的選擇。

### mod 偵測不到的操作

- 在選單選回 session 原本的 model，Claude Code 不當成有換，mod 偵測不到，會繼續用它自己選的 model：請打 `/model <名稱>`，或用 `/jcGearbox-pin <model>`。
- 在選單選 Opus Plan Mode 而它當下的 model 就是目前的 model 時也一樣：請打 `/model opusplan`。
- 被 Claude Code 拒絕的 `/model`（hook 擋下、沒有 1M context）只在它的回覆說明時才不算；在終端機裡它什麼都不回，mod 仍當成你的選擇（`/jcGearbox-auto` 可以解掉）。
- resume 或重載 plugin 之後、送出下一個 prompt 之前在選單改的 effort 也偵測不到：請用 `/effort <等級>`。

## 指令

| 指令 | 作用 |
|---|---|
| `/jcGearbox-setup` | 引導設定 |
| `/jcGearbox-status`（或 `/jcGearbox`） | 模式、model、effort、各 tier 對應的 model、上一則的 Jev 分數與版本，以及上個請求實際送出的值 |
| `/jcGearbox-auto`、`/jcGearbox-shadow`、`/jcGearbox-off` | 這個 session 的模式（`/jcGearbox-auto` 會一併清掉 pin，並重新要求停用的 model） |
| `/jcGearbox-on` | `/jcGearbox-off` 之後重新開啟，回到 `default_mode`（它是 `off` 時改開 `auto`）；pin 保留 |
| `/jcGearbox-pin <model>` | 固定用某個別名或完整 model ID |
| `/jcGearbox-log [n]` | 最近 `n` 筆決策（預設 20），包含所有 session |
| `/jcGearbox-stats` | 紀錄中的決策和引擎原本的比：第一回合 model 升級、不變或降級，effort 調高、不變或調低，Jev 的錯誤率與延遲，抱怨比例；以及各回合的結果（回答、錯誤、中斷、拒答）、prompt 從快取讀到的比例（全部，以及和該 session 上一筆紀錄比，model 與 effort 都沒換、換了 effort、換了 model 時各自的比例），還有額度最近一次的用量與最高值 |

舊寫法 `/jcGearbox <動作>` 仍可用。

`/jcGearbox-setup`、`/jcGearbox-pin`、`/jcGearbox-auto`、`/jcGearbox-shadow`、`/jcGearbox-off` 和 `/jcGearbox-on` 是 skill，新 session 在第一個 prompt 之前，輸入框的選單就列得出來，由 mod 自己回應；其他指令在 session 啟動時才註冊，要到第一個 prompt 之後才列得出來。

## 狀態列

```
opus-5-5·high          auto：實際送出的
shadow ▸ opus-5-5·high   shadow：Jev 的選擇
```

auto 模式顯示實際送出的 model 和 effort；shadow 模式顯示 Jev 的選擇，請求照 session 原本的設定送出。effort 顯示 `?` 表示 mod 換了 model，effort 由 Claude Code 依新 model 決定：mod 沒設 effort，或設的剛好是 Claude Code 原本的等級（Claude Code 不當成有改）。只有 Jev 出錯時會加註 `Jev <錯誤>`；其他資訊（pin、`/model`、你自己設的 effort、指令自帶的 model、plan mode、`ultracode`、`Jev unsure`）記在 `/jcGearbox-log`，完整狀態看 `/jcGearbox-status`。Claude Code 底部顯示的 model 和 effort 是 session 自己的設定，shadow 照它送出，auto 可能改寫；auto 模式下實際送出的值以狀態列為準。

## 設定

用 `/jcGearbox-setup`、`/plugin configure jc-gearbox@jc-gearbox`，或 `claude plugin configure … --values-stdin`（值要寫成字串）修改。在 `/config` 改的會立刻生效；其他方式改完執行 `/reload-plugins` 或開新 session。設定存在 `~/.claude/settings.json` 的 `pluginConfigs`；`api_key` 存在 Claude Code 的安全儲存區。

| 設定 | 預設 | 說明 |
|---|---|---|
| `api_key` | — | TypeSafe key；沒填時讀 `TYPESAFE_API_KEY` |
| `default_mode` | `shadow` | 新 session 的模式：`shadow`、`auto` 或 `off` |
| `low_model`、`balanced_model`、`strong_model`、`long_model` | `haiku`、`sonnet`、`opus`、`fable` | 別名（`opus[1m]` 是 1M context）或完整 model ID；填 `off` 停用該 tier（session 自己的 model 屬於該 tier 時仍會問 Jev 它，好讓 Jev 能說「留下」） |
| `tier_upgrade_probability`、`tier_min_probability` | 0.5、0.8 | 換成較強、較弱 model 需要的機率 |
| `continuation_threshold` | 0.6 | 超過就算接續，沿用上一回合的 effort |
| `effort_min_confidence` | 0.7 | Jev 對 effort 分數的信心度低於這個值時不採用它的分數，沿用上一回合的 effort（抱怨或高風險仍會調高）；設 0 就永遠照 Jev |
| `signal_threshold` | 0.7 | 超過才算「上次失敗」和「有風險」 |
| `min_effort`、`max_effort` | `low`、`max` | mod 設定的範圍；你自己設的 effort 不受限 |
| `jev_model` | `jev-latest` | 填 `jev-1.13.0` 這類版本可固定；各門檻是在這一版上調的 |
| `jev_timeout_seconds` | 3 | Jev 的答案能改變的請求，最多等它多久（0.5–8） |
| `send_assistant_tail` | 關（建議開） | 一併送出 Claude 上一則回答的結尾 |
| `assistant_tail_chars` | 1000 | 送多少字（100–8000；每 1000 字約 700 tokens） |
| `fork_follows_route` | 關 | auto 模式下，從主對話 fork 出去的子代理也用 session 路由後的 model，讀得到對話的 prompt cache |

別名只在用 Anthropic 帳號或 API key 登入時有效；用 API key 時 Claude Code 沒有 model 清單，別名改用 mod 的內建對照表，`/jcGearbox-status` 會標示 `built-in`。你的 model 清單沒有提供的別名（例如沒有 Fable 權限）會讓那個 tier 停用。用 Bedrock、Vertex、Foundry 或 gateway 時，請至少替兩個 tier 填完整 model ID。session 一旦選到 Haiku，會停在 Haiku 直到你 pin 別的 model。

## 隱私

每個你送出的 prompt（自己打的，或透過桌面 App、Remote Control、Slack 送出的；`claude -p` 和 Agent SDK 的執行不處理），TypeSafe 會收到：這次的 prompt（最多約 6000 字，太長就保留開頭和結尾）、上一個 prompt（最多約 1000 字）、從第二個 prompt 起 session 目前的 model 和上一回合的 effort（Bedrock ARN 會去掉帳號部分），以及開啟 `send_assistant_tail` 時 Claude 上一則回答的結尾。不是你打的 prompt，內容一律不送；但開啟 `send_assistant_tail` 時，Claude 對它的回答結尾可能送出。檔案、程式碼和工具結果只有在這些文字裡時才會送出。常見的 key 與 token 格式（API key、GitHub、AWS、Slack、Google 的 key、JWT、私鑰）在送出或存檔前會換成 `[redacted]`；其他你貼上的 secret 仍會原樣送出。Claude 引用的網頁或檔案內容，可能經由回答結尾送到 Jev、影響它的判斷。TypeSafe 的[隱私權政策](https://typesafe.ai/legal/privacy-policy)表示不拿這些資料訓練，但沒寫明保留多久；伺服器在美國，只有 enterprise 方案提供 zero retention。mod 只向 Claude Code 確認你是否用 Anthropic 帳號登入，用來判斷別名能不能用，不會碰到憑證本身。

本機（`~/.claude/plugins/store/jc-gearbox_*.json`）保留：每個 prompt 的前 200 字（決策紀錄，最近 200 筆），每個 session 的上一個 prompt（最多約 1000 字）和回答結尾（最近 200 個 session；該 session 的下一個 prompt 會換掉它，關掉選項時則是刪掉），以及 Claude 較長回答結尾的雜湊，用來認出 fork 來自哪個 session（最近 200 筆）。每筆決策另外記下引擎原本的 model 和 effort、Jev 花了多久、這個回合的請求數與 token 數，以及額度用量。刪掉這個檔就會清空。
