# 萃角儿桥接插件

把当前用户在萃角儿平台上的全部 Agent 同步安装到 Claude Code 和 Codex，并附带一个「平台助手」。平台操作统一封装到 CLI，harness 通过 MCP → CLI → 平台 API 管理该用户的项目、文本素材和 Agent，也可直接调用 CLI。

首版是本地插件，运行在用户电脑上。后端负责鉴权与资源归属；插件不连接数据库，不接收 `user_id` 覆盖参数，不导出平台保存的模型密钥。Agent 使用 harness 自身的模型。

## 从 App 复制一次

在萃角儿 App 打开「工具 → 连接 AI 工具」，点击「复制安装指令」，直接粘贴到正在使用的 Claude Code、Codex 或其他 AI 工具的**对话框**并发送。无需先选 harness、打开终端或手动创建令牌。

App 会为当前账号签发专用 API Token，将平台地址、Token 和 [AI 安装说明](INSTALL.md) 一起复制。AI 根据当前工具识别安装方式、准备依赖、完成连接并同步全部 Agent 和默认平台助手。复制内容含访问凭据，也会进入目标 AI 工具的会话记录；仅粘贴到信任的工具，不公开分享。可在 App「API 令牌」撤销对应的「AI 工具安装」令牌。

Claude Code、Codex 使用已实现的原生安装器。其他工具通过标准 stdio MCP 和导出的 Agent Skills 接入，由当前 AI 按自身官方配置完成安装；需要具备本地执行及 MCP 能力，不能承诺没有这些能力的聊天工具也可安装。原生安装器要求 Git、Node.js 22+ 及对应 harness。只有新会话才能加载的工具，安装后需开启新会话。

### 手动维护

AI 执行的入口为：

```sh
node src/cli.js install --url https://platform.example.com --harness codex --token-stdin
# Claude Code 使用 cc；其他 MCP 工具使用 mcp 生成接入文件
```

令牌通过 stdin 传入，不能作为命令行参数。`install` 按平台及 Token 用户分别保存连接，返回 `profilePath`。后续 `whoami`、`sync` 均传入同一 `--profile`，例如：

```sh
node src/cli.js whoami --profile /path/to/profile.json
node src/cli.js sync --harness codex --profile /path/to/profile.json
```

更新源码时在安装目录运行 `git pull --ff-only`、`npm ci`，再同步当前工具。`--dry-run` 只查看范围；`--generate-only` 仅导出。原有 `configure --url <origin>` 仍支持手动隐藏输入令牌。

如果配置时提示 404，先确认平台已支持 `GET /api/integrations/me` 和 Agent 接口。插件发布不代表目标平台后端已经更新。

## 平台操作 CLI

CLI 可以独立运行：只需 Node.js 22+、本项目依赖、可访问的平台后端和平台 API Token，不需要 LLM、MCP 服务或 Codex / Claude Code。直接使用时先运行 `configure --url <平台 origin> --profile <连接文件>` 配置连接；自动化可加 `--token-stdin` 通过标准输入提供 Token，无需执行插件安装或 Agent 同步。

现有 16 个平台工具全部对应 CLI 命令，MCP 保留原有工具名称和参数，每次调用通过子进程执行 CLI。命令参数、校验与接口映射统一维护在 `src/commands.js`，新增平台操作先补 CLI，再由 MCP 适配。

| 能力 | CLI 命令 | 对应 MCP 工具 |
| --- | --- | --- |
| 当前用户 | `whoami` | `current_user` |
| 项目 | `projects <操作>` | `list_projects`、`get_project`、`create_project`、`update_project`、`delete_project` |
| 素材 | `materials <操作>` | `list_materials`、`get_material`、`create_material`、`update_material`、`delete_material` |
| Agent | `agents <操作>` | `list_agents`、`get_agent`、`create_agent`、`update_agent`、`delete_agent` |

三个命令组均提供 `list`、`get`、`create`、`update`、`delete` 操作。

在源码目录运行，`--profile` 使用安装时返回的连接文件路径：

```sh
node src/cli.js --help --json
node src/cli.js materials create --help
node src/cli.js projects list --profile /path/to/profile.json
node src/cli.js projects create --profile /path/to/profile.json --input '{"title":"采访项目"}'
node src/cli.js materials list --profile /path/to/profile.json --input '{"project_id":7,"page":1,"page_size":100}'
node src/cli.js materials get --profile /path/to/profile.json --input '{"material_id":8}'
node src/cli.js projects update --profile /path/to/profile.json --input '{"project_id":7,"changes":{"title":"新标题"}}'
node src/cli.js agents list --profile /path/to/profile.json
```

示例中的 ID 需要替换为实际查询结果。输入字段沿用 MCP 参数：资源 ID 为数字，更新字段放在 `changes` 中，省略的字段保持原值。素材列表默认 `page=1`、`page_size=100`；详情命令返回全文。

JSON 输入可用 `--input '<JSON>'`、`--input-file <文件>` 或 `--input-stdin`，三者互斥。长正文优先使用文件或管道，避免命令行长度和引号转义问题，例如 `material.json` 内容：

```json
{"project_id":7,"title":"采访原文","content":"第一段事实。\n第二段事实。"}
```

```sh
node src/cli.js materials create --profile /path/to/profile.json --input-file material.json
# 管道方式完成同一操作；请选择一种，避免重复创建
node src/cli.js materials create --profile /path/to/profile.json --input-stdin < material.json
```

业务命令默认输出 JSON，`--json` 也可显式传入；`--help --json` 返回平台操作清单及输入 JSON Schema。成功结果写入 stdout，退出码为 `0`；删除成功返回 `{"deleted":true}`。失败时 stdout 为空，stderr 返回 `{"error":{"code":"http_401","message":"..."}}`，退出码为 `1`。参数错误码为 `invalid_arguments`，HTTP 错误为 `http_<状态码>`；请求超时返回 `request_failed`，写入结果应先查询确认，不自动重试。

兼容性变化：原有安装、配置、身份查询和同步命令仍可使用，但 CLI 错误输出由纯文本改为上述 JSON；MCP 调用 CLI 失败时也返回同样的错误对象并设置 `isError`，MCP 自身的参数校验错误仍由 SDK 返回。依赖错误文本的脚本需改读 `error.code` / `error.message`。

## 同步规则

| 平台内容                            | Claude Code             | Codex                                     |
| ----------------------------------- | ----------------------- | ----------------------------------------- |
| 用户全部 Agent 的名称、说明和提示词 | 插件 `agents/*.md`      | 用户目录 `agents/*.toml` 原生自定义 Agent |
| 默认平台助手                        | `platform` Agent 和技能 | 平台助手原生 Agent 和技能                 |
| 平台数据操作                        | 本地 stdio MCP → CLI   | 插件内 MCP → CLI；原生 Agent 也绑定相同连接 |

同步是手动触发的平台到 harness 的单向更新。新增、修改、删除平台 Agent 后重新运行 `sync`，或明确让 harness 使用 `sync-agents` 技能。同步不会自动创建平台默认 Agent，不回写本地提示词修改，也不持续后台轮询。

Agent 列表接口当前返回当前用户的完整数组，无分页。列表无效、Token 失效或请求失败时停止同步，保留上次安装。同步到两端时，如第二端失败，会报告第一端已完成，可修复后重试。无法做到跨两个独立 harness 的原子安装。

同步只改写带本插件标记的 Codex Agent 文件，保留其他文件；同名非托管文件会导致停止。托管文件应在平台修改，直接改本地副本会被下次同步覆盖。Claude Code 切换至新插件版本后不再加载已删除的 Agent。历史生成版本留在本地供排查，不自动清理。

## 数据工具与权限

内置 16 个 MCP 工具：当前用户，以及项目、素材、Agent 各自的列表、详情、创建、修改和删除。素材列表带分页；详情工具读取全文。创建素材默认是文本素材，后端记录 `source=api`。

文件上传、PDF 提取、作品版本管理和服务端付费生成尚未封装为插件工具。账号修改、Token 管理和模型凭证管理不向插件开放；已有后端限制保持不变。

- 所有 API 请求携带用户自己的长期 Token。后端从 Token 确定用户，不信任调用方指定的归属。跨用户资源统一返回 404。
- 插件启动时核对连接的绑定信息；每次工具调用由 CLI 重新读取凭证文件，核对安装时绑定的平台、用户及 Token 当前所属用户。撤销 Token 后，下次请求立即失败。
- 连接只接受 HTTPS origin；本地调试允许 loopback HTTP。禁止 URL 内置凭证、查询参数及重定向，避免把 Token 发往其他地址。
- 自动安装的凭证文件为 `~/.config/cuijiao-bridge/profiles/<namespace>.json`；手动 configure 的默认路径为 `~/.config/cuijiao-bridge/profile.json`，权限为 `600`。App 复制的安装指令和目标 AI 会话中包含 Token；插件运行时从该文件读取。生成的插件只保存凭证文件路径和绑定用户，不把 Token 写入插件清单、Agent 提示词或日志。
- 同一用户的多个 Token 可访问该用户全部业务资源，当前没有 Token 级别的细分 scope。操作系统账号及其启动的 harness 必须可信；本机文件权限不是对同一系统账号内恶意进程的隔离。

更换同一用户的 Token 时重新 `configure`，然后重新开启 harness 会话。自动 install 按账号及平台选择独立配置；手动 configure 切换账号或平台时须使用不同的 `--profile` 文件，并在后续命令中传入同一路径，不能静默覆盖已绑定其他账号的配置。

## 本地文件与卸载

生成文件放在凭证文件同级的 `marketplaces/cuijiao-<平台摘要>-u<用户 ID>/` 下。每个账号使用独立的 marketplace、插件名和原生 Agent 前缀。Codex 默认使用 `~/.codex/agents/`，设置了 `CODEX_HOME` 时使用该目录下的 `agents/`。

MCP 配置引用此项目中的运行脚本和 Node 绝对路径，因此保留源码目录和 `node_modules`。移动源码或更新 Node 路径后重新运行 `sync`。不要分享生成的私人 Agent 目录或凭证文件。

卸载时，用同步输出的 `namespace` 和 `marketplace` 替换下列占位符：

```sh
claude plugin uninstall '<namespace>@<marketplace>' --scope user
codex plugin remove '<namespace>@<marketplace>'
claude plugin marketplace remove '<marketplace>'
codex plugin marketplace remove '<marketplace>'
```

再删除 Codex `agents/` 中属于该 `namespace` 且首行标有 `Managed by cuijiao-bridge` 的文件，以及该账号的生成目录。确认不再使用后在平台撤销 Token，再删除对应凭证文件。插件卸载不会删除平台资源，撤销 Token 也不会清除已保存在本地的提示词副本。

## 验证

```sh
npm test
npm run check

# 独立 CLI 业务闭环：连接隔离的真实后端，不使用 LLM、MCP 或模型宿主
BRIDGE_TEST_ORIGIN=http://127.0.0.1:18083 npm run test:cli:e2e

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

请求使用 `Authorization: Bearer <用户 API Token>`，Token 为 `hd_` 加 43 位 URL-safe Base64。接口必须在服务端鉴权并检查资源归属，不能只依赖插件校验。删除成功返回 204，其余成功响应为 JSON；无效/已撤销 Token 返回 401，跨用户 ID 返回 404。创建素材时不接受客户端指定 `user_id` 或伪造来源。
