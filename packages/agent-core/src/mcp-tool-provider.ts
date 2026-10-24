import type { McpManager, McpTool } from '@plinthway/mcp-client';
import type {
  ToolDescriptor,
  ToolInvocationOptions,
  ToolInvocationResult,
  ToolProvider,
} from '@plinthway/shared';

function descriptor(tool: McpTool): ToolDescriptor {
  return {
    name: tool.name,
    source: { kind: 'mcp', id: tool.serverId },
    ...(tool.description === undefined ? {} : { description: tool.description }),
    inputSchema: tool.inputSchema,
    ...(tool.annotations === undefined ? {} : { annotations: { ...tool.annotations } }),
  };
}

export class McpToolProvider implements ToolProvider {
  readonly #manager: McpManager;

  constructor(manager: McpManager) {
    this.#manager = manager;
  }

  listTools(): readonly ToolDescriptor[] {
    return this.#manager.listTools().map(descriptor);
  }

  listPreparedTools(): readonly ToolDescriptor[] {
    return this.#manager.listPreparedTools().map(descriptor);
  }

  listActiveSkillContexts(): readonly string[] {
    return this.#manager.listActiveSkillContexts();
  }

  async invoke(
    toolName: string,
    argumentsValue: unknown,
    options: ToolInvocationOptions,
  ): Promise<ToolInvocationResult> {
    const result = await this.#manager.invoke(toolName, argumentsValue, options);
    return {
      trusted: false,
      toolName: result.toolName,
      content: result.content,
      ...(result.structuredContent === undefined
        ? {}
        : { structuredContent: result.structuredContent }),
      isError: result.isError,
      ...(result.meta === undefined ? {} : { meta: result.meta }),
    };
  }
}
