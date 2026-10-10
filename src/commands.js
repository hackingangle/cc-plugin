import { z } from "zod";
import { BridgeError } from "./client.js";

const id = z.number().int().positive().safe();
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

function command(name, cli, description, shape, method, path, body) {
  commands.push({
    name,
    cli,
    description,
    schema: z.object(shape).strict(),
    method,
    path,
    body,
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
  "分页列出项目素材摘要；按 total/page/page_size 继续取下一页。全文使用 get_material。",
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
  "读取素材全文和元数据。",
  { material_id: id },
  "GET",
  (a) => `/api/materials/${a.material_id}`,
);
command(
  "create_material",
  "materials create",
  "在项目中创建文本素材，来源由后端标记为 api；不负责 PDF 文件上传。",
  { project_id: id, ...materialFields },
  "POST",
  (a) => `/api/projects/${a.project_id}/materials`,
  ({ project_id, ...fields }) => fields,
);
command(
  "update_material",
  "materials update",
  "修改素材标题、正文或原文链接。",
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
  "删除指定素材。仅在用户已明确要求删除该素材时调用。",
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
  "创建平台 agent，使用 harness 自身模型；不会创建或导出模型凭证。",
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
  return client.request(
    command.method,
    command.path(parsed.data),
    command.body?.(parsed.data),
  );
}
