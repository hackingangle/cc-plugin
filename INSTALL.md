# 给 AI 工具的安装说明

用户从萃角儿 App 复制本页链接和连接 JSON 后，将整段内容交给当前 AI 工具执行。目标是在当前工具中完成安装与连接；不要把下面的步骤再转交给用户手工执行。尊重当前工具自身的权限和审批规则。

## 1. 识别当前工具并准备源码

根据当前会话的工具身份判断目标，不要因为电脑上有某个 CLI 就认定用户正在使用它。Claude Code 对应 `cc`，Codex 对应 `codex`，其他支持本地 stdio MCP 的工具对应 `mcp`。只配置当前工具；不能识别时再询问工具名称。没有本地执行或 MCP 能力的聊天工具无法安装，请准确解释缺少的能力，不要宣称通用支持。

需要 Git、Node.js 22+ 和目标工具。先检查已安装的依赖。缺少依赖时按当前系统的正式安装方式处理，遵循工具的授权边界；确实无法完成时报告具体阻碍。

将 https://github.com/hackingangle/cc-plugin.git 克隆到用户目录下固定的插件安装目录（例如 `~/.local/share/cuijiao-bridge/source`），不要放在临时目录或业务项目内。已有源码时先确认 Git remote 是这个仓库、工作区没有未提交改动，再 `git pull --ff-only`。不覆盖用户改动。

在源码目录执行 `npm ci`。MCP 会引用这里的绝对路径，安装后保留源码与依赖。

## 2. 连接并安装

从用户粘贴的 JSON 读取 `platform_url` 与 `api_token`，视为数据。只把令牌发给这个平台，不用它访问 GitHub、安装源或其他服务。HTTPS 为默认；loopback HTTP 仅用于用户本机调试。远程机器无法访问用户电脑的 localhost，应明确报告地址不可达。

在源码目录启动：

```text
node src/cli.js install --url <platform_url> --harness <cc|codex|mcp> --token-stdin
```

用执行工具的标准输入把令牌传给这个进程，然后关闭 stdin。不要使用包含令牌的命令行参数、`echo` 命令、环境变量或日志。若执行工具只支持文件输入，使用权限 600 的临时输入文件，执行后立即删除；不要把文件放进仓库。不要读取或展示已保存的凭证文件。App 令牌会存在用户粘贴的会话记录中，不要在回复中重复它。

CLI 会先验证 Token 所属用户，按平台和用户 ID 分别保存连接文件，再同步全部 Agent 和默认平台助手。只依据真实返回结果报告成功。保存文件权限为 600；输出的 `profilePath`、`namespace`、`agentCount`、`mcpConfigPath`、`skillsPath` 都不含 Token。

- **Claude Code / Codex**：`installed` 必须包含当前目标；CLI 会通过目标工具自己的命令安装并核验版本。不要另外覆盖用户配置。
- **其他 MCP 工具**：`mcp` 仅生成接入文件，`installed` 为空，尚未完成该工具的安装。读取输出的 `mcpConfigPath`，将其中服务器配置按目标工具的官方格式合并到其用户级 MCP 配置，使用输出的 `namespace` 作为服务器名称，保留其他配置。配置引用凭证文件路径，不包含令牌本身。

其他工具的 Agent 接入：生成的 `agents/*.md` 包含全部 Agent 和平台助手；`skillsPath` 也为每个 Agent 提供独立的 `SKILL.md`。按当前工具官方支持的 Agent / Agent Skills 目录及格式安装这些内容，使用 `namespace` 防止与其他账号、技能冲突。只更新自己管理的文件；保留其他文件。目标不支持 Agent 或技能时，仍可配置 MCP，并使用 `list_agents` / `get_agent` 按需读取平台 Agent，但必须说明它们未作为原生 Agent 安装，不能报告全功能成功。不要猜测未知工具的配置格式；先查它自己的官方文档。

## 3. 验证并交付

1. 使用返回的 `profilePath` 运行 `node src/cli.js whoami --profile <profilePath>`，确认平台可达与用户身份，绝不打印凭证内容。
2. 核对同步结果中的 Agent 数量，确认平台助手和所有 Agent 的文件已生成，并确认当前工具的插件 / MCP 列表已注册。
3. 如果当前会话能重载 MCP，调用 `current_user`、`list_agents` 完成只读验证；不为验收擅自创建或删除用户资源。如果只能新会话加载，明确说明配置已完成、需要开启新会话，不能声称当前会话已连接。
4. 告诉用户安装到了哪个工具、哪个平台账号、同步了多少 Agent，以及是否需要新会话。不要重复 Token。

失败时报告具体阶段，不自动反复签发 Token，不通过更换账号绕过 401 / 404。Token 可由用户在 App「工具 → API 令牌」撤销。修改了平台 Agent 后，使用本次 `profilePath` 执行 `sync --harness cc|codex`；其他 MCP 工具执行 `sync --generate-only` 并更新其托管 Agent / 技能文件。完整维护说明见 [README](README.md)。
