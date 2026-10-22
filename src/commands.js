import { z } from "zod";
import { BridgeError } from "./client.js";
import { transcribeAudio } from "./asr.js";

const id = z.number().int().positive().safe();
const idempotencyKey = z.string().min(1).max(128).regex(/^[!-~]+$/);
const nonBlankText = z.string().refine((value) => value.trim().length > 0);
const requirements = nonBlankText.refine(
  (value) => Buffer.byteLength(value, "utf8") <= (16 << 10),
);
const workContent = nonBlankText.refine(
  (value) => Buffer.byteLength(value, "utf8") <= (4 << 20),
);
const idempotencyHeaders = (input) => ({
  "Idempotency-Key": input.idempotency_key,
});
const title = z.string().min(1).max(1024);
const projectFields = {
  title,
  category: z.string().min(1).max(510).optional(),
  episode_no: id.max(2147483647).optional(),
};
const materialFields = {
  title,
  content: z.string().min(1),
  origin_url: z.string().max(1024).optional(),
};
const agentFields = {
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  system_prompt: z.string().min(1),
};
const patch = (fields) =>
  z
    .object(fields)
    .partial()
    .strict()
    .refine((value) => Object.keys(value).length > 0, "至少提供一个修改字段");

export const commands = [];

function command(name, cli, description, shape, method, path, body, headers) {
  commands.push({
    name,
    cli,
    description,
    schema: z.object(shape).strict(),
    method,
    path,
    body,
    headers,
  });
}

command(
  "current_user",
  "whoami",
  "查看此插件 Token 绑定的当前用户，不返回凭证。",
  {},
  "GET",
);
command(
  "list_projects",
  "projects list",
  "列出当前用户的全部项目。",
  {},
  "GET",
  () => "/api/projects",
);
command(
  "get_project",
  "projects get",
  "读取当前用户的项目。",
  { project_id: id },
  "GET",
  (a) => `/api/projects/${a.project_id}`,
);
command(
  "create_project",
  "projects create",
  "为当前用户创建项目。",
  projectFields,
  "POST",
  () => "/api/projects",
  (a) => a,
);
command(
  "update_project",
  "projects update",
  "修改项目指定字段，其余保持不变。",
  { project_id: id, changes: patch(projectFields) },
  "PATCH",
  (a) => `/api/projects/${a.project_id}`,
  (a) => a.changes,
);
command(
  "delete_project",
  "projects delete",
  "删除项目及其全部素材。仅在用户已明确要求删除该项目时调用。",
  { project_id: id },
  "DELETE",
  (a) => `/api/projects/${a.project_id}`,
);
command(
  "list_materials",
  "materials list",
  "分页列出项目素材摘要；按 total/page/page_size 继续取下一页，全文使用 get_material。摘要 id 与 create_material 返回的 id 均为全局唯一的素材编号 material_id，即用户说的「素材 N」（UI #N）；不是 project_id、current_asset_id、期数或列表位置，也不与「创作任务 N」的任务 id 混用。按素材编号访问遇到 http_404 时，向用户说明找不到该编号的素材，不换数字重试。",
  {
    project_id: id,
    page: id.default(1),
    page_size: id.max(100).default(100),
  },
  "GET",
  (a) =>
    `/api/projects/${a.project_id}/materials?page=${a.page}&page_size=${a.page_size}`,
);
command(
  "get_material",
  "materials get",
  "读取素材全文和元数据。用户说的「素材 N」（UI #N）就是全局唯一的 material_id，即 list_materials 摘要或 create_material 返回的 id；不是 project_id、current_asset_id、期数或列表位置，也不是「创作任务 N」的任务 id。遇到 http_404 时，向用户说明找不到该编号的素材，不换数字重试。",
  { material_id: id },
  "GET",
  (a) => `/api/materials/${a.material_id}`,
);
command(
  "create_material",
  "materials create",
  "在项目中创建文本素材，来源由后端标记为 api；不负责 PDF 文件上传。返回的 id 与 list_materials 摘要 id 均为全局唯一的素材编号 material_id，即用户说的「素材 N」（UI #N）；不是 project_id、current_asset_id、期数或列表位置，也不与「创作任务 N」的任务 id 混用。后续按素材编号访问遇到 http_404 时，向用户说明找不到该编号的素材，不换数字重试。",
  { project_id: id, ...materialFields },
  "POST",
  (a) => `/api/projects/${a.project_id}/materials`,
  ({ project_id, ...fields }) => fields,
);
command(
  "update_material",
  "materials update",
  "修改素材标题、正文或原文链接。用户说的「素材 N」（UI #N）就是全局唯一的 material_id，即 list_materials 摘要或 create_material 返回的 id；不是 project_id、current_asset_id、期数或列表位置，也不是「创作任务 N」的任务 id。遇到 http_404 时，向用户说明找不到该编号的素材，不换数字重试。",
  {
    material_id: id,
    changes: patch({ ...materialFields, content: z.string() }),
  },
  "PATCH",
  (a) => `/api/materials/${a.material_id}`,
  (a) => a.changes,
);
command(
  "delete_material",
  "materials delete",
  "删除指定素材。仅在用户已明确要求删除该素材时调用。用户说的「素材 N」（UI #N）就是全局唯一的 material_id，即 list_materials 摘要或 create_material 返回的 id；不是 project_id、current_asset_id、期数或列表位置，也不是「创作任务 N」的任务 id。遇到 http_404 时，向用户说明找不到该编号的素材，不换数字重试。",
  { material_id: id },
  "DELETE",
  (a) => `/api/materials/${a.material_id}`,
);
command(
  "list_agents",
  "agents list",
  "列出当前用户全部平台 agent；本地安装副本需重新运行 sync 更新。",
  {},
  "GET",
  () => "/api/agents",
);
command(
  "get_agent",
  "agents get",
  "读取平台 agent 的提示词和说明。",
  { agent_id: id },
  "GET",
  (a) => `/api/agents/${a.agent_id}`,
);
command(
  "create_agent",
  "agents create",
  "创建平台 agent 的提示词与说明，使用 harness 当前模型执行。",
  agentFields,
  "POST",
  () => "/api/agents",
  (a) => a,
);
command(
  "update_agent",
  "agents update",
  "修改平台 agent 的名称、说明或提示词；之后重新 sync 更新安装副本。",
  { agent_id: id, changes: patch(agentFields) },
  "PATCH",
  (a) => `/api/agents/${a.agent_id}`,
  (a) => a.changes,
);
command(
  "delete_agent",
  "agents delete",
  "删除平台 agent；之后重新 sync 清理安装副本。仅在用户明确要求时调用。",
  { agent_id: id },
  "DELETE",
  (a) => `/api/agents/${a.agent_id}`,
);
command(
  "create_creation_task",
  "creation create",
  "冻结 Agent 提示词、创作要求和所选素材全文，返回 awaiting_result 任务；使用 harness 当前模型生成后调用 complete_creation_task 保存候选稿。material_ids 填全局唯一的素材编号 material_id：用户说的「素材 N」（UI #N），即 list_materials 摘要或 create_material 返回的 id；不是 project_id、current_asset_id、期数或列表位置。「创作任务 N」指另一个任务 id，不与素材编号混用。按素材编号访问遇到 http_404 时，向用户说明找不到该编号的素材，不换数字重试。",
  {
    project_id: id,
    agent_id: id,
    material_ids: z.array(id).min(1).max(20).refine(
      (ids) => new Set(ids).size === ids.length,
    ),
    requirements,
    idempotency_key: idempotencyKey,
  },
  "POST",
  (a) => `/api/projects/${a.project_id}/creation-tasks`,
  ({ agent_id, material_ids, requirements }) => ({
    agent_id,
    material_ids,
    requirements,
  }),
  idempotencyHeaders,
);
command(
  "list_creation_tasks",
  "creation list",
  "列出项目创作任务，包含任务 ID、状态和候选版本 ID；冻结上下文全文使用 get_creation_task。",
  { project_id: id },
  "GET",
  (a) => `/api/projects/${a.project_id}/creation-tasks`,
);
command(
  "get_creation_task",
  "creation get",
  "读取创作任务的完整冻结上下文、状态和候选版本 ID；生成时使用这里的 Agent 提示词、要求和素材全文。",
  { task_id: id },
  "GET",
  (a) => `/api/creation-tasks/${a.task_id}`,
);
command(
  "complete_creation_task",
  "creation complete",
  "将 harness 生成的完整正文原子保存为 generated 候选版本并完成任务，返回 {task,version}；不会自动采用。相同任务、正文和幂等键可回查后重试。",
  { task_id: id, content: workContent, idempotency_key: idempotencyKey },
  "POST",
  (a) => `/api/creation-tasks/${a.task_id}/complete`,
  ({ content }) => ({ content }),
  idempotencyHeaders,
);
command(
  "get_work",
  "work get",
  "读取项目当前作品、版本摘要和采用历史；候选版本全文使用 get_work_version。",
  { project_id: id },
  "GET",
  (a) => `/api/projects/${a.project_id}/work`,
);
command(
  "get_work_version",
  "work version get",
  "读取指定作品版本的全文。",
  { project_id: id, version_id: id },
  "GET",
  (a) => `/api/projects/${a.project_id}/work/versions/${a.version_id}`,
);
command(
  "edit_work_version",
  "work edit",
  "在父版本基础上保存新的候选稿，保留原版本；expected_version 使用最新 get_work 的 version，不会自动采用。",
  {
    project_id: id,
    parent_version_id: id,
    expected_version: id,
    content: workContent,
    idempotency_key: idempotencyKey,
  },
  "POST",
  (a) => `/api/projects/${a.project_id}/work/versions`,
  ({ parent_version_id, expected_version, content }) => ({
    parent_version_id,
    expected_version,
    content,
  }),
  idempotencyHeaders,
);
for (const [action, name, description] of [
  [
    "adopt",
    "adopt_work_version",
    "采用候选版本为当前作品。仅在用户明确要求采用时调用；expected_version 使用最新 get_work 的 version。",
  ],
  [
    "restore",
    "restore_work_version",
    "恢复曾采用过的版本为当前作品。仅在用户明确要求恢复时调用；expected_version 使用最新 get_work 的 version。",
  ],
]) {
  command(
    name,
    `work ${action}`,
    description,
    {
      project_id: id,
      version_id: id,
      expected_version: id,
      idempotency_key: idempotencyKey,
    },
    "POST",
    (a) => `/api/projects/${a.project_id}/work/${action}`,
    ({ version_id, expected_version }) => ({ version_id, expected_version }),
    idempotencyHeaders,
  );
}
command(
  "asr_health",
  "asr health",
  "查看平台语音识别服务的状态和后端模式。",
  {},
  "GET",
  () => "/api/asr/health",
);
commands.push({
  name: "transcribe_audio",
  cli: "asr transcribe",
  description:
    "使用平台 ASR 识别本机 16kHz 单声道 pcm_s16le 文件（最长 5 分钟），返回最终文本与分段；音频会发送到平台配置的 ASR 服务。",
  schema: z.object({ audio_path: z.string().min(1) }).strict(),
  method: "POST",
  path: () => "/api/asr/tickets",
  execute: transcribeAudio,
});
export async function executeCommand(command, input, client) {
  const parsed = command.schema.safeParse(input);
  if (!parsed.success) {
    const fields = parsed.error.issues.map(
      (issue) => issue.path.join(".") || "input",
    );
    throw new BridgeError(
      `参数无效：${[...new Set(fields)].join(", ")}；运行对应命令 --help 查看格式。`,
      "invalid_arguments",
    );
  }
  // Recheck ownership before every operation, including writes.
  const user = await client.identity();
  if (command.name === "current_user") return user;
  if (command.execute)
    return command.execute(parsed.data, client, command.path(parsed.data));
  return client.request(
    command.method,
    command.path(parsed.data),
    command.body?.(parsed.data),
    command.headers?.(parsed.data),
  );
}
