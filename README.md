# 大料桥接插件

把当前用户在大料平台上的全部 Agent 同步安装到 Claude Code 和 Codex，并附带一个「平台助手」。平台操作统一封装到 CLI，harness 通过 MCP → CLI → 平台 API 管理该用户的项目、文本素材和 Agent，也可直接调用 CLI。

大料的 MCP 名为 `daliao-active`，npm 包名和 CLI 命令为 `daliao-bridge`。插件生成文件存放在 `~/.config/daliao-bridge/`。

插件运行在用户电脑上，默认选择线上服务 `https://cc.agoodbit.com`，也可在本机持久切换到本地服务。环境选择与 Token 配置分开：没有 Token 也能切换，访问平台数据和同步 Agent 时才需要该服务的 Token。后端负责鉴权、资源归属和保存文本素材；插件不连接数据库，不接收 `user_id` 覆盖参数。Agent 使用 harness 当前模型，模型选择、密钥和推理设置由 harness 管理，平台不提供模型配置或执行模型。

## 从 App 复制一次

在大料 App 打开「工具 → 连接 AI 工具」，点击「复制安装指令」，直接粘贴到正在使用的 Claude Code、Codex 或其他 AI 工具的**对话框**并发送。无需先选 harness、打开终端或手动创建令牌。

App 会为当前会话所在的服务签发专用 API Token，将该服务地址、Token 和 [AI 安装说明](INSTALL.md) 一起复制。Web App 的服务地址可能是 `https://cc.agoodbit.com`，iOS App 可能使用 `https://api.agoodbit.com`；安装 App 复制的指令时沿用其中的地址。AI 根据当前工具识别安装方式、准备依赖、完成连接并同步全部 Agent 和默认平台助手。本地 App 签发的是本地服务的 Token，不能用于连接线上服务；安装线上连接需从线上 App 获取 Token。复制内容含访问凭据，也会进入目标 AI 工具的会话记录；仅粘贴到信任的工具，不公开分享。可在 App「API 令牌」撤销对应的「AI 工具安装」令牌。

Claude Code、Codex 使用已实现的原生安装器。其他工具通过标准 stdio MCP 和导出的 Agent Skills 接入，由当前 AI 按自身官方配置完成安装；需要具备本地执行及 MCP 能力，不能承诺没有这些能力的聊天工具也可安装。原生安装器要求 Git、Node.js 22+ 及对应 harness。只有新会话才能加载的工具，安装后需开启新会话。

### 手动维护

直接使用 CLI 时，在源码目录执行：

```sh
# 初始化 ~/.cc，首次使用默认线上；已有选择会保留
node src/cli.js init
# 为当前环境配置 Token，按提示隐藏输入
node src/cli.js configure
# 验证当前服务和身份
node src/cli.js whoami

# 配置本地服务使用本地 App 签发的 Token
node src/cli.js connections use local
node src/cli.js configure
# 以后直接切换，不需要再次输入已保存的 Token
node src/cli.js connections use cloud
node src/cli.js connections current
```

`init` 创建 `~/.cc/`、`~/.cc/profiles/` 和不含 Token 的 `~/.cc/active.json`，重复执行不会覆盖当前选择，也不会创建空凭证文件。`configure` 不需要填写地址或文件路径：它为当前环境验证并保存 Token，保留环境选择及已有账号绑定。线上与本地分别使用各自服务签发的 Token。凭证按平台及用户存入 `~/.cc/profiles/`，无需手动记住文件名；自动化可用 `configure --token-stdin` 通过标准输入提供 Token。

安装或更新插件时，AI 执行的入口为：

```sh
node src/cli.js install --harness codex --token-stdin
# 本地服务使用该服务签发的 Token，并显式指定地址
node src/cli.js install --url http://127.0.0.1:8080 --harness codex --token-stdin
# Claude Code 使用 cc；其他 MCP 工具使用 mcp 生成接入文件
```

省略 `--url` 时，`install` 使用 `https://cc.agoodbit.com`。令牌通过 stdin 传入，不能作为命令行参数。`install` 按平台及 Token 用户分别保存连接，返回 `profilePath`，并将本次安装的连接设为当前连接。线上与本地各用其服务签发的 Token，互不替代。

```sh
# 不需要先配置 Token，就能选择环境
node src/cli.js connections use local
# 或 node src/cli.js connections use cloud
node src/cli.js connections current
# 查看已配置的凭证文件
node src/cli.js connections list
# 配好所选服务的 Token 后，再访问业务或同步
node src/cli.js whoami
node src/cli.js sync --harness codex
```

`connections use local|cloud` 不要求已有 Token，会将环境选择写入权限为 `600` 的 `~/.cc/active.json`；不复制 Token。没有配置文件时，线上地址为 `https://cc.agoodbit.com`，本地地址为 `http://localhost:8080`。尚未手动选择时默认线上；已有线上凭证时优先使用 `cc.agoodbit.com`，没有它时可使用 `api.agoodbit.com`。

`connections current` 即使未配置 Token 也能成功，返回当前环境、地址和 `tokenConfigured`。`tokenConfigured` 表示本机是否已选中可用的凭证配置，实际服务与 Token 有效性由 `whoami` 验证；未配置时运行 `configure`。多个匹配的凭证文件会返回 `profileRequired: true`，此时用 `connections list` 查看文件，再用 `connections use local|cloud --profile <连接文件>` 选择账号。选择非默认线上地址时也使用 `--profile`；指定文件必须已经配置且属于所选环境。`connections list` 可加 `--profile` 纳入额外的手动连接文件。

业务 CLI、`sync` 和当前插件的 MCP 工具在未显式指定连接文件时读取当前选择。所选环境没有凭证时返回 `token_not_configured`，需要选择账号时返回 `connection_ambiguous`；不会改用另一个环境的凭证。业务 CLI 和 `sync` 的 `--profile` 仅覆盖本次命令。切换后 MCP 数据操作立即使用新选择；具备相应凭证后才能访问数据。本地 Agent 的名称、说明和提示词是上次同步的快照；先切换当前连接，再运行 `sync` 并开启新会话加载。

更新源码时在安装目录运行 `git pull --ff-only`、`npm ci`，再运行 `sync --harness <当前工具>` 并开启新会话，加载更新后的大料插件和 Agent 说明。`--dry-run` 只查看范围；`--generate-only` 仅导出。高级用法 `configure --url <origin> [--profile <连接文件>]` 仍可指定平台和凭证文件，只保存凭证，不切换环境；更换账号时使用独立的连接文件。

如果配置时提示 404，先确认平台已支持 `GET /api/integrations/me` 和 Agent 接口。插件发布不代表目标平台后端已经更新。

## 平台操作 CLI

CLI 可以独立运行，不需要 LLM、MCP 服务或 Codex / Claude Code。环境切换只需 Node.js 22+ 和本项目依赖；访问业务还需可访问的平台后端和平台 API Token。直接使用时运行 `init`，用 `connections use local|cloud` 选择环境，再运行 `configure` 保存该环境的 Token；自动化配置可加 `--token-stdin` 通过标准输入提供 Token，无需执行插件安装或 Agent 同步。

现有 18 个平台工具全部对应 CLI 命令，每次 MCP 调用通过子进程执行 CLI。命令参数、校验与接口映射统一维护在 `src/commands.js`，新增平台操作先补 CLI，再由 MCP 适配。

| 能力 | CLI 命令 | 对应 MCP 工具 |
| --- | --- | --- |
| 当前用户 | `whoami` | `current_user` |
| 项目 | `projects <操作>` | `list_projects`、`get_project`、`create_project`、`update_project`、`delete_project` |
| 素材 | `materials <操作>` | `list_materials`、`get_material`、`create_material`、`update_material`、`delete_material` |
| Agent | `agents <操作>` | `list_agents`、`get_agent`、`create_agent`、`update_agent`、`delete_agent` |
| 语音识别 | `asr health`、`asr transcribe` | `asr_health`、`transcribe_audio` |

项目、素材和 Agent 三个命令组均提供 `list`、`get`、`create`、`update`、`delete` 操作。

在源码目录运行。下例中的 `--profile` 演示单次指定安装时返回的连接文件；省略时使用 `connections current` 指向的连接：

```sh
node src/cli.js --help --json
node src/cli.js materials create --help
node src/cli.js projects list --profile /path/to/profile.json
node src/cli.js projects create --profile /path/to/profile.json --input '{"title":"采访项目"}'
node src/cli.js materials list --profile /path/to/profile.json --input '{"project_id":7,"page":1,"page_size":100}'
node src/cli.js materials get --profile /path/to/profile.json --input '{"material_id":8}'
node src/cli.js projects update --profile /path/to/profile.json --input '{"project_id":7,"changes":{"title":"新标题"}}'
node src/cli.js agents list --profile /path/to/profile.json
node src/cli.js asr health --profile /path/to/profile.json
node src/cli.js asr transcribe --profile /path/to/profile.json --input '{"audio_path":"/path/to/audio.pcm"}'
```

示例中的 ID 需要替换为实际查询结果。输入字段沿用 MCP 参数：资源 ID 为数字，更新字段放在 `changes` 中，省略的字段保持原值。素材列表默认 `page=1`、`page_size=100`；详情命令返回全文。

用户说的「素材 N」（UI 显示为 `#N`）是全局唯一的素材编号 `materials.id`，即 `list_materials` 摘要中的 `id`、`create_material` 返回的 `id`。读取、修改、删除素材时将 N 传给 `material_id`；不要使用 `project_id`、`current_asset_id`、期数（episode number）或列表位置。按素材编号访问遇到 `http_404` 时，应向用户说明找不到该编号的素材，不要换一个数字重试。

JSON 输入可用 `--input '<JSON>'`、`--input-file <文件>` 或 `--input-stdin`，三者互斥。长正文优先使用文件或管道，避免命令行长度和引号转义问题，例如 `material.json` 内容：

```json
{"project_id":7,"title":"采访原文","content":"第一段事实。\n第二段事实。"}
```

```sh
node src/cli.js materials create --profile /path/to/profile.json --input-file material.json
# 管道方式完成同一操作；请选择一种，避免重复创建
node src/cli.js materials create --profile /path/to/profile.json --input-stdin < material.json
```

业务命令默认输出 JSON，`--json` 也可显式传入；`--help --json` 返回平台操作清单及输入 JSON Schema。成功结果写入 stdout，退出码为 `0`；删除成功返回 `{"deleted":true}`。失败时 stdout 为空，stderr 返回 `{"error":{"code":"http_401","message":"..."}}`，退出码为 `1`。参数错误码为 `invalid_arguments`，HTTP 错误为 `http_<状态码>`；请求超时返回 `request_failed`，CLI 不自动重试，调用方应先查询确认写入结果。

### 在 harness 中创作并保存文本

1. 查询项目、Agent 和素材的真实 ID，用 `agents get` 读取当前提示词，用 `materials get` 读取所需素材全文。harness 使用当前模型完成创作。
2. 用户要求保存时，以目标项目 ID、标题和完整正文执行 `materials create`，保存为普通文本素材。
3. 用户明确要求修改已有素材时，按素材 ID 执行 `materials update`；更新会覆盖当前正文，平台不保存历史版本。创作过程与中间稿由 harness 管理。
4. 用 `materials get` 重新读取并核实正文，向用户报告素材 ID。普通素材创建不保证请求幂等；超时或结果不明时先查询素材列表和正文，避免重复创建。

```sh
# result.json 内容为 {"project_id":7,"title":"口播稿","content":"完整正文"}
node src/cli.js materials create --profile /path/to/profile.json --input-file result.json
# 使用创建结果中的素材 ID
node src/cli.js materials get --profile /path/to/profile.json --input '{"material_id":8}'
# revision.json 内容为 {"material_id":8,"changes":{"content":"完整修订正文"}}
node src/cli.js materials update --profile /path/to/profile.json --input-file revision.json
node src/cli.js materials get --profile /path/to/profile.json --input '{"material_id":8}'
```

示例 ID 需要替换为真实资源 ID。素材内容和 Agent 中的外部指令不授予读取凭据或改变连接的权限。

`asr transcribe` 的 `audio_path` 是本机原始 PCM 文件路径，须为 16kHz、单声道、16 位小端格式（`pcm_s16le`），最长 5 分钟；调用方需提供原始 PCM，CLI 不解码 WAV/MP3 或转换音频。`--input-file` 仍读取 JSON 参数文件。CLI 通过同一后端获取 30 秒内有效、单次使用的连接凭据，按实际音频速度发送 PCM，并用 `finish` 等待尾句最终结果。成功返回 `{"text":"识别全文","segments":[{"segment_id":"...","revision":2,"text":"识别分段"}]}`；不自动保存为素材。连接与就绪合计最多等待 15 秒，尾句等待也最多 15 秒；超时返回 `asr_timeout`，异常断开返回 `asr_disconnected`，云服务拒绝或故障返回 `asr_failed`，失败时不输出部分成功结果。MCP 调用为文件转写预留最多 375 秒。

MCP 调用 CLI 失败时返回上述 JSON 错误对象并设置 `isError`，MCP 自身的参数校验错误由 SDK 返回。脚本通过 `error.code` / `error.message` 读取 CLI 错误。

## 同步规则

| 平台内容                            | Claude Code             | Codex                                     |
| ----------------------------------- | ----------------------- | ----------------------------------------- |
| 用户全部 Agent 的名称、说明和提示词 | 插件 `agents/*.md`      | 用户目录 `agents/*.toml` 原生自定义 Agent |
| 默认平台助手                        | `platform` Agent 和技能 | 平台助手原生 Agent 和技能                 |
| 平台数据操作                        | 本地 stdio MCP → CLI   | 插件内 MCP → CLI；原生 Agent 也绑定相同连接 |

同步是手动触发的平台到 harness 的单向更新。新增、修改、删除平台 Agent 后重新运行 `sync`，或明确让 harness 使用 `sync-agents` 技能。切换连接后，MCP 数据工具会使用新连接，但已生成的 Agent 名称、说明和提示词仍来自上次同步的平台；要更新这些快照，运行 `sync --harness <当前工具>` 并开启新会话。同步不会自动创建平台默认 Agent，不回写本地提示词修改，也不持续后台轮询。

Agent 列表接口当前返回当前用户的完整数组，无分页。列表无效、Token 失效或请求失败时停止同步，保留上次安装。同步到两端时，如第二端失败，会报告第一端已完成，可修复后重试。无法做到跨两个独立 harness 的原子安装。

同步只改写带本插件标记的 Codex Agent 文件，保留其他文件；同名非托管文件会导致停止。托管文件应在平台修改，直接改本地副本会被下次同步覆盖。Claude Code 切换至新插件版本后不再加载已删除的 Agent。历史生成版本留在本地供排查，不自动清理。

## 数据工具与权限

内置 18 个 MCP 工具：当前用户，以及项目、素材、Agent 各自的列表、详情、创建、修改和删除，另有 ASR 健康查询与音频转写。素材列表带分页；详情工具读取全文。创建素材默认是文本素材，后端记录 `source=api`。语音识别复用提词器的服务端 ASR，音频会发送到平台配置的识别服务，可能按平台的云服务配置计费。

文件上传和 PDF 提取尚未封装为插件工具。已在平台处理完成的素材全文可由 harness 读取并用于创作。账号修改和 Token 管理不向插件开放。

- HTTP API 请求携带用户自己的长期 Token；ASR WebSocket 使用后端签发的一次性短期连接凭据。后端确定用户，不信任调用方指定的归属。跨用户资源统一返回 404。
- 当前插件的 MCP 工具每次调用都由 CLI 读取当前连接及其凭证文件；显式传入 `--profile` 的 CLI 命令只读取指定文件。CLI 校验连接状态中的平台和用户绑定，后端校验 Token 当前所属用户。撤销 Token 后，下次请求立即失败。
- 连接只接受 HTTPS origin；本地调试允许 loopback HTTP。禁止 URL 内置凭证、查询参数及重定向，避免把 Token 发往其他地址。
- 自动安装和不指定路径的 `configure` 将凭证保存为 `~/.cc/profiles/<平台及用户标识>.json`，权限为 `600`。当前选择另存于 `~/.cc/active.json`，不含 Token。App 复制的安装指令和目标 AI 会话中包含 Token；插件运行时从对应凭证文件读取，不把 Token 写入插件清单、Agent 提示词或日志。
- 同一用户的多个 Token 可访问该用户全部业务资源，当前没有 Token 级别的细分 scope。操作系统账号及其启动的 harness 必须可信；本机文件权限不是对同一系统账号内恶意进程的隔离。

更换当前账号的 Token 时运行 `configure`；后续 CLI / MCP 调用会读取更新后的 Token。自动 install 按账号及平台保存独立配置；手动 configure 切换账号或平台时须使用不同的 `--profile` 文件，不能静默覆盖已绑定其他账号的配置。切换当前连接使用 `connections use`，不需改写凭证文件。

## 本地文件与卸载

连接状态和凭证文件放在 `~/.cc/` 下。生成文件放在 `~/.config/daliao-bridge/marketplaces/daliao-active/` 下；插件名和原生 Agent 前缀固定为 `daliao-active`，同一插件可随当前连接切换。Codex 默认使用 `~/.codex/agents/`，设置了 `CODEX_HOME` 时使用该目录下的 `agents/`。各平台和账号的 Token 保存在独立凭证文件中。

MCP 配置引用此项目中的运行脚本和 Node 绝对路径，因此保留源码目录和 `node_modules`。移动源码或更新 Node 路径后重新运行 `sync`。不要分享生成的私人 Agent 目录或凭证文件。

卸载时，用同步输出的 `namespace`（当前为 `daliao-active`）和 `marketplace` 替换下列占位符：

```sh
claude plugin uninstall '<namespace>@<marketplace>' --scope user
codex plugin remove '<namespace>@<marketplace>'
claude plugin marketplace remove '<marketplace>'
codex plugin marketplace remove '<marketplace>'
```

再删除 Codex `agents/` 中属于该 `namespace` 且首行标有 `Managed by daliao-bridge` 的文件，以及对应的生成目录。确认不再使用后分别在所属平台撤销 Token，再删除对应凭证文件及 `active.json`。插件卸载不会删除平台资源，撤销 Token 也不会清除已保存在本地的提示词副本。

## 验证

```sh
npm test
npm run check
# 不监听端口：fake fetch 驱动真实 CLI / stdio MCP 子进程及 fake 安装器
npm run test:offline

# 独立 CLI 业务闭环：连接隔离的真实后端，不使用 LLM、MCP 或模型宿主
BRIDGE_TEST_ORIGIN=http://127.0.0.1:18083 npm run test:cli:e2e

# 独立 CLI 语音识别闭环：隔离后端必须配置 ASR mock 模式
BRIDGE_TEST_ORIGIN=http://127.0.0.1:18083 npm run test:asr:e2e

# 可选：实际 CLI 安装/更新，全部使用临时配置目录；需 Python 3.11+ 解析 TOML
node --test tests/harness-smoke.js

# 可选：本地后端全链路，会创建临时账号，结束时注销并删除其资源
BRIDGE_TEST_ORIGIN=http://127.0.0.1:8081 node --test tests/platform-smoke.js
```

`BRIDGE_TEST_PYTHON` 可指定安装测试使用的 Python 3.11+ 可执行文件。平台端应另外覆盖跨用户项目、素材、Agent 的读写隔离及 Token 撤销。当前配套 Go 后端已通过独立 MySQL 权限回归测试。

`test:cli:e2e` 对应 [独立 CLI 闭环用例](tests/cli-platform-smoke.js)，需先启动已完成迁移的隔离后端与 MySQL；`BRIDGE_TEST_ORIGIN` 只允许本机地址。该测试不重建数据库，只创建并最终注销临时账号、清理其数据和临时连接文件。缺少后端配置或后端不可达时测试失败，不会跳过或用 mock 代替。普通 `npm test` 仍运行无需数据库的命令与 MCP 测试。

闭环测试的每一步都启动新的 CLI 进程、解析 JSON 和退出码，并使用上一步返回的真实资源 ID；后续查询必须读到修改后的数据库状态。覆盖：

- 项目：创建、列表与详情、修改、重新读取并检查未修改字段、删除、确认列表为空且详情返回 404。
- 素材：从文件创建长文本、分页查询、修改与重新读取全文、单条删除、删除项目后确认剩余素材不可访问。
- Agent：创建、列表与详情、修改提示词并清空说明、重新读取、删除并确认不存在；全程不调用模型。
- 权限：另一账号读取、修改、删除和跨项目新增均被拒绝，原数据保持不变；撤销 Token 后读写均失败，另一账号仍可使用。

账号注册、测试 Token 的签发与撤销、最终账号清理由测试准备代码直接调用后端，因为这些账号级操作不属于当前业务 CLI 的开放范围。连接配置、身份查询、项目、素材和 Agent 操作均只通过 CLI 执行。测试子进程不继承模型密钥或宿主配置，PATH 指向临时目录。

`test:asr:e2e` 对应 [独立 CLI ASR 用例](tests/asr-platform-smoke.js)，使用隔离后端的 ASR mock 模式，覆盖 API Token 配置、健康查询、单次连接凭据、PCM 发送、尾句结束与最终文本、stdio MCP → CLI 的同一链路，以及 Token 撤销后的拒绝。它不验证真实云服务的识别准确率；普通 `npm test` 覆盖音频输入限制、消息时序、分段修订、错误、超时与连接清理。

2026-10-28 接口收缩：CLI 和 MCP 已移除 9 个创作任务与作品版本命令，旧命令返回未知命令且不发送 HTTP 请求；成稿保存统一使用普通文本素材创建或更新。当前有 18 个平台工具；连接、身份、项目、素材、Agent、ASR 和真实 harness 同步入口保持可用。Node.js 24 下 `npm run check`、`npm run test:offline`（12/12）和 3 份生成技能校验通过；后者使用无端口 fake fetch、真实 CLI / stdio MCP 子进程及 fake 安装器。完整 `npm test` 中需监听端口的用例被执行环境以 `listen EPERM` 拒绝，真实后端闭环与实际 harness 安装未运行。

2026-10-23 大料命名统一验证：Node.js 22 下 `npm run check` 与 `npm test`（34/34）通过，覆盖 CLI、安装器、原生 Agent、账号命名空间和 stdio MCP（`daliao-bridge`）。真实后端闭环与 Claude Code / Codex 实际安装待部署后验证。

2026-10-11 ASR CLI / MCP 已通过 `npm test` 的 20 项测试、`npm run check`，并在独立 tmpfs MySQL 与 Go API 的 mock ASR 后端通过 `test:asr:e2e` 的 2 项验证。使用临时账号与 API Token，测试后清理；未使用开发库或真实用户账号。未验证真实云服务的识别准确率，也未更新日常使用的插件安装。

2026-10-10 已在独立的 Go API 与 tmpfs MySQL 测试库上通过上述四组闭环场景（Node 测试计数 5 项），验证真实持久化和删除结果；未使用开发库、既有验收库或真实用户账号。

2026-10-09 CLI 改造已通过 13 项自动测试、`npm run check`，以及 Claude Code / Codex 的隔离安装与更新测试。覆盖 16 项 CLI 操作、真实 stdio MCP → CLI → 本地假 API、长文本文件与管道输入、参数拒绝、账号绑定及 Token 撤销。本轮未重跑真实后端与 UI 验收，也未更新日常账号的插件安装；更新使用中的插件需重新 `sync` 并开启新会话。

2026-10-07 本地已通过：9 项单元/MCP 测试、App 实际剪贴板 → install → 两个 Agent 与平台助手 → MCP 身份查询、Claude Code 2.1.153 和 Codex CLI 0.160.0 的隔离安装与更新、真实 Go/MySQL 后端的同步与 MCP CRUD、两用户资源隔离和 Token 撤销。还未用真实用户 Token 安装到日常 harness，未验证模型在真实对话中的自动选择质量，尚未部署配套后端的新身份接口；请按目标平台实际接入状态使用。

格式依据：[Codex 插件](https://developers.openai.com/plugins/build/plugins)、[Codex 自定义 Agent](https://learn.chatgpt.com/docs/agent-configuration/subagents)、[Claude Code 插件](https://code.claude.com/docs/en/plugins-reference)、[MCP SDK](https://ts.sdk.modelcontextprotocol.io/v2/)。首版复用官方 MCP SDK，不自行实现协议。

## 平台接口约定

| 接口                                                                          | 用途                                                                                     |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `GET /api/integrations/me`                                                    | 返回 Token 所属用户的 `id`、`username`、`nickname`                                       |
| `GET/POST /api/projects`，`GET/PATCH/DELETE /api/projects/:id`                | 当前用户的项目管理                                                                       |
| `GET/POST /api/projects/:id/materials`，`GET/PATCH/DELETE /api/materials/:id` | 素材列表、详情和管理；列表返回 `items`、`total`、`page`、`page_size`                     |
| `GET/POST /api/agents`，`GET/PATCH/DELETE /api/agents/:id`                    | Agent 完整列表和管理；同步需要 `id`、`name`、`description`（可为 null）、`system_prompt` |
| `GET /api/asr/health` | 语音识别服务状态和后端模式 |
| `POST /api/asr/tickets` | API Token 换取一次性、30 秒有效的 WebSocket 连接凭据 |
| `GET /api/asr/ws?ticket=<连接凭据>` | WebSocket PCM 转写；`connected` → 配置 → `ready` → 音频 → `finish` → 最终结果 → `finished` |

请求使用 `Authorization: Bearer <用户 API Token>`，Token 为 `hd_` 加 43 位 URL-safe Base64。接口必须在服务端鉴权并检查资源归属，不能只依赖插件校验。删除成功返回 204，其余成功响应为 JSON；无效/已撤销 Token 返回 401，跨用户 ID 返回 404。创建素材时不接受客户端指定 `user_id` 或伪造来源。
