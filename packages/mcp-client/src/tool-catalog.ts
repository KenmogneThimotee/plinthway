import { canonicalJson, PlinthwayError, type JsonValue } from '@plinthway/shared';

import type { McpConnectionPort, McpTool, NativeMcpTool } from './contracts.js';
import { compileToolValidator, type ToolArgumentValidator } from './validation.js';

interface CatalogEntry {
  readonly connection: McpConnectionPort;
  readonly tool: McpTool;
  readonly validate: ToolArgumentValidator;
}

function normalizeSchema(serverId: string, tool: NativeMcpTool, schema: unknown): JsonValue {
  try {
    return JSON.parse(canonicalJson(schema)) as JsonValue;
  } catch (error) {
    throw new PlinthwayError(
      'MCP_PROTOCOL_ERROR',
      `MCP server ${serverId} returned a non-JSON schema`,
      { serverId, toolName: tool.name },
      { cause: error },
    );
  }
}

export class ToolCatalog {
  readonly #entries = new Map<string, CatalogEntry>();

  add(connection: McpConnectionPort, nativeTool: NativeMcpTool): void {
    if (nativeTool.name.length === 0 || nativeTool.name.includes('\0')) {
      throw new PlinthwayError('MCP_PROTOCOL_ERROR', 'MCP tool name is invalid', {
        serverId: connection.serverId,
      });
    }
    const name = `${connection.serverId}.${nativeTool.name}`;
    if (this.#entries.has(name)) {
      throw new PlinthwayError('MCP_PROTOCOL_ERROR', `MCP server returned duplicate tool ${name}`, {
        serverId: connection.serverId,
        toolName: nativeTool.name,
      });
    }
    const validate = compileToolValidator(
      connection.serverId,
      nativeTool.name,
      nativeTool.inputSchema,
    );
    this.#entries.set(name, {
      connection,
      validate,
      tool: {
        name,
        nativeName: nativeTool.name,
        serverId: connection.serverId,
        ...(nativeTool.description === undefined ? {} : { description: nativeTool.description }),
        ...(nativeTool.title === undefined ? {} : { title: nativeTool.title }),
        inputSchema: normalizeSchema(connection.serverId, nativeTool, nativeTool.inputSchema),
        ...(nativeTool.outputSchema === undefined
          ? {}
          : {
              outputSchema: normalizeSchema(
                connection.serverId,
                nativeTool,
                nativeTool.outputSchema,
              ),
            }),
        ...(nativeTool.annotations === undefined ? {} : { annotations: nativeTool.annotations }),
        ...(nativeTool.icons === undefined
          ? {}
          : { icons: nativeTool.icons.map((icon) => ({ ...icon })) }),
        ...(nativeTool.meta === undefined ? {} : { meta: { ...nativeTool.meta } }),
        ...(nativeTool.taskSupport === undefined ? {} : { taskSupport: nativeTool.taskSupport }),
      },
    });
  }

  get(name: string): CatalogEntry | undefined {
    return this.#entries.get(name);
  }

  remove(connection: McpConnectionPort): void {
    for (const [name, entry] of this.#entries) {
      if (entry.connection === connection) this.#entries.delete(name);
    }
  }

  list(): readonly McpTool[] {
    return [...this.#entries.values()]
      .map((entry) => entry.tool)
      .sort((left, right) => left.name.localeCompare(right.name));
  }
}
