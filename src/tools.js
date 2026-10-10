import { McpServer } from "@modelcontextprotocol/server";
import { commands } from "./commands.js";
import { BridgeError } from "./client.js";
import { runCli } from "./run-cli.js";

export function createServer(connection) {
  const server = new McpServer({ name: "cuijiao-bridge", version: "0.1.0" });
  for (const command of commands) {
    server.registerTool(
      command.name,
      {
        description: command.description,
        inputSchema: command.schema,
        annotations: {
          readOnlyHint: command.method === "GET",
          destructiveHint: command.method === "DELETE",
          openWorldHint: false,
        },
      },
      async (args) => {
        try {
          const data = await runCli(command.cli, args, connection);
          return {
            content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
          };
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: {
                    code:
                      error instanceof BridgeError ? error.code : "cli_failed",
                    message:
                      error instanceof BridgeError
                        ? error.message
                        : "平台 CLI 执行失败，请检查本地配置。",
                  },
                }),
              },
            ],
          };
        }
      },
    );
  }
  return server;
}
