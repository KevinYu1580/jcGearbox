# jev-cc-model-router

[English](README.md) · 繁體中文

一個 Claude Code mod（function hooks plugin）。它請 [TypeSafe 的 Jev](https://typesafe.ai) 判斷任務有多難，然後：

- **每個 session 選一次 model**：平常用 Sonnet，session 的第一個 prompt 看起來很難時改用 Opus，不必手動切換；
- **每個回合選 effort**：簡單的回合降低 effort，回應更快；說上次失敗或任務有風險時調高。

預設是 **shadow 模式**：每回合照樣判斷，並在狀態列顯示「開 auto 的話會怎麼選」，但什麼都不改，直到你切到 `auto`。先觀察一陣子，再決定 Jev 的判斷對你夠不夠準（見[已知限制](#已知限制)）。

## 需求

- Claude Code **2.1.286 以上**。mod API 是 early access，任何版本都可能不經通知就修改。
- TypeSafe API key（[console.typesafe.ai](https://console.typesafe.ai)）。

## 安裝

```
/plugin marketplace add KevinYu1580/jev-cc-model-router
/plugin install jev-cc-model-router@jev-cc-model-router
```

在 plugin 設定的 `api_key` 填入 key，或設定環境變數 `TYPESAFE_API_KEY`。沒有 key 時 mod 什麼都不做。

## 怎麼判斷

### model：每個 session 一次

session 裡你送出的第一個 prompt，會請 Jev 判斷任務需要哪個 tier：

| tier | 適用 | 預設 model |
|---|---|---|
| `low` | 查資料、解釋、改名、格式化、執行指令、一行修改 | `sonnet` |
| `balanced` | 單一模組內的一般功能或 bug 修正、寫測試、單一檔案重構 | `sonnet` |
| `strong` | 跨模組設計、困難除錯（並行、效能、記憶體）、架構決策、資安、需求不明確 | `opus` |
| `long` | 數小時的自主工作、整個 repo 的遷移或稽核 | 停用（填 `fable` 啟用） |

對應到同一個 model 的 tier，機率合併計算。勝出 model 的機率至少要 `tier_min_probability`（0.6）才會換；不到就沿用你選的 model。平手時取較強的。

第一個 prompt 之後 model **不會再自己換**，所以 mod 不會在 session 中途丟掉 prompt cache。新 session 或 `/clear` 會重新決定；`--resume` 和對話壓縮沿用原本的決定。（壓縮本身仍用你選的 model，見[已知限制](#已知限制)。）

### effort：你送出的每個 prompt

1. 起點是 Jev 的 effort 分數（`low`、`medium`、`high`、`xhigh`、`max`）。如果這則 prompt 只是接續上一件事（「好」、「繼續」、簡短回答），改用上一回合的 effort。
2. 如果你說上次做錯或失敗，升一級（最高 `max`）。
3. 如果出錯會造成難以挽回的損害（正式環境、刪資料、資料庫遷移、認證、金流、force-push），至少 `xhigh`。
4. 最後確保不低於 `min_effort`。

Jev 給的機率要超過 `signal_threshold`（0.7）才算成立。你說上次失敗、effort 已經是 `max`、而且 model 不是 Opus 或 Fable 時，狀態列會建議 `/jcmr pin opus`。

背景任務通知、排程 prompt、其他 session 傳來的訊息都不會送給 Jev；這些回合沿用 session 目前的 model 和 effort。子代理一律不動。

### Jev 失敗時

Jev 出錯或超過 1.5 秒沒回應時，不做新的決策，狀態列顯示原因（`Jev HTTP 401`、`Jev timeout`）。如果是 session 的第一個 prompt，請求照沒有這個 mod 時的樣子送出，這個 session 就一直用你選的 model；之後的 prompt 則沿用 session 的 model 和上一回合的 effort。

## 以你的選擇為準

| 你做的事 | 效果 |
|---|---|
| `/jcmr pin <別名或完整 ID>` | 這個 session 固定用該 model（`auto` 模式下） |
| 第一個 prompt 之後用 `/model` 或選單換 model | 這個 session 不再改 model，並清掉 pin |
| 第一個 prompt 之後用 `/effort` 或選單改 effort | 這個 session 不再改 effort |
| `/jcmr auto` | 切回 `auto`，並清除以上所有固定。從 shadow 開始的 session，狀態列顯示的 model 會從下一個請求開始生效（重寫一次 prompt cache） |

session 開始時已設定的 effort 只當成起點，不算你的選擇：要固定它，請在第一個 prompt 之後再設一次，或用 `/jcmr off`。

slash command 自帶的單回合 effort（skill frontmatter 的 `effort:`、`/code-review max`）只作用在那一回合，不算固定。

mod 選了別的 model 之後，想回到 session 一開始的那個 model，請用 `/jcmr pin <model>`：在 `/model` 或選單選回同一個 model，對 Claude Code 來說不算換，mod 收不到通知。

## 指令

| 指令 | 作用 |
|---|---|
| `/jcmr` | 顯示模式、model 和 effort 狀態，以及上一則 prompt 的 Jev 分數 |
| `/jcmr auto`／`shadow`／`off` | 只改**這個 session** 的模式。新 session 的預設由 `default_mode` 設定決定 |
| `/jcmr pin <model>` | 這個 session 固定用某個 model |
| `/jcmr log [n]` | 列出最近 `n` 筆決策（預設 20），包含所有 session |

## 狀態列

```
jcmr ▸ opus-5-5·high                 auto
jcmr(shadow) ▸ opus-5-5·high         shadow：開 auto 的話會怎麼選
jcmr: no API key
jcmr: needs Claude Code 2.1.286+
```

視情況在後面加註：`model pinned`、`effort pinned`、`try /jcmr pin opus`、`built-in model table`、`Jev <錯誤>`。API 實際回應的 model 跟要求的不同，或請求完全沒有回應而且回合因錯誤結束時，會顯示 `jcmr: <model> was not used (<model> answered); not switching to it again`（沒有回應時括號內是 `no response`）。

## 設定

| 設定 | 預設 | 說明 |
|---|---|---|
| `api_key` | 空 | TypeSafe key。沒填就讀 `TYPESAFE_API_KEY` |
| `default_mode` | `shadow` | 新 session 的模式：`shadow`、`auto` 或 `off` |
| `low_model`、`balanced_model`、`strong_model` | `sonnet`、`sonnet`、`opus` | 別名（`haiku`、`sonnet`、`opus`、`fable`）或完整 model ID。空白代表停用該 tier |
| `long_model` | 空 | 填 `fable` 才啟用 |
| `tier_min_probability` | 0.6 | 換掉 session model 所需的最低機率 |
| `signal_threshold` | 0.7 | 「接續」、「說上次失敗」、「危險操作」的機率要超過多少才算 |
| `min_effort` | `low` | mod 設定的最低 effort |
| `jev_model` | `jev-latest` | 填版本號（如 `jev-1.13.0`）就固定版本 |
| `send_assistant_tail` | 關 | 一併送出 Claude 上一則回答的最後約 1000 字（見隱私） |

### model 名稱

完整 model ID 直接使用。別名會從 Claude Code 自己的 model 清單（`~/.claude/cache/model-catalog/` 底下的快取）換算成目前的 model ID，讀不到時改用內建對照表（狀態列會顯示 `built-in model table`）。

別名只在你用 Anthropic 帳號登入 Claude Code 時有效。為了判斷這一點，mod 會呼叫 Claude Code 的 `authorize()`，但只看它有沒有回應：**拿到的 handle 不會被使用，mod 不會讀取或送出你的憑證。** 使用 Bedrock、Vertex、Foundry 或 LLM gateway 時，別名換算不出來，這些 tier 會停用：請填完整 model ID，否則 mod 只會調整 effort。

**`low_model` 設成 Haiku 時：** Haiku 不支援 effort 設定，context 只有 200K。第一個 prompt 選到它，整個 session 就只能用 Haiku，除非手動 `/jcmr pin` 其他 model。

## 隱私

你送出的每個 prompt，mod 只會送給 TypeSafe：

- 這則 prompt（最多約 6000 字；太長就保留開頭和結尾）；
- 你的上一則 prompt（最多約 1000 字）；
- session 目前的 model 和上一回合的 effort；
- 開啟 `send_assistant_tail` 時，Claude 上一則回答的最後約 1000 字。

不送程式碼、檔案內容或工具結果，除非你把它們貼在 prompt 裡，或開啟了 `send_assistant_tail`。通知、子代理報告等不是你打的回合，一律不送。

依 TypeSafe 的說法，資料不會拿來訓練，但沒有寫明保留多久；伺服器在美國；只有 enterprise 方案提供零保留。

本機（Claude Code 的 plugin store）會保存：決策紀錄裡每則 prompt 的前 200 字、每個 session 的上一則 prompt（1000 字）；開啟 `send_assistant_tail` 時，另存每個 session 中 Claude 上一則回答的最後約 1000 字（關掉選項後仍會留到該 session 紀錄被清掉）。保留最近 200 筆決策和 200 個 session。

## 已知限制

- 支持 Jev 能判斷任務難度的證據很弱：參考實作自己的評測 AUC 為 0.570，信賴區間包含亂猜，也沒有繁中數據。shadow 模式就是讓你自己看準不準。
- mod API 是 early access，任何 Claude Code 版本都可能改壞。
- 對話壓縮（自動或 `/compact`）和 Claude Code 其他附屬請求不經過 mod 改寫的 hook，所以用你選的 model 和它原本的 effort。mod 把 session 換到別的 model 時，這些請求讀不到對話的 prompt cache，摘要也由你選的 model 寫。
- model 清單快取是 Claude Code 的內部檔案，格式隨時可能改；改了會退回內建對照表，而內建表要在新 model 推出時更新。
- 換 effort 不會讓 prompt cache 失效，這點只在 Opus 5.5、Claude Code 2.1.280 以後觀察過，樣本少。

## 開發

```
claude plugin validate .claude-plugin/plugin.json
claude plugin validate .
claude plugin test .
```

第一行驗 manifest 和 hooks module；第二行在有 `marketplace.json` 的資料夾上只會驗 marketplace。

要試用本機版本，用 `claude --plugin-dir /path/to/jev-cc-model-router` 載入；桌面 App 則在 `~/.claude/settings.json` 的 `env` 加 `CLAUDE_CODE_PLUGIN_DIRS` 指向這個資料夾（再加 `CLAUDE_CODE_PLUGIN_DIR_WATCH=1` 可存檔即重載）。設計文件在 [docs/SPEC.md](docs/SPEC.md)。

## 授權

[MIT](LICENSE)
