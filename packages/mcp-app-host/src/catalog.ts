import {
  getToolUiResourceUri,
  isToolVisibilityAppOnly,
  isToolVisibilityModelOnly,
} from '@modelcontextprotocol/ext-apps/app-bridge';
import type { Tool } from '@modelcontextprotocol/client';

import { PlinthwayError, type JsonValue } from '@plinthway/shared';

export interface AppToolSource {
  readonly name: string;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly inputSchema?: unknown;
  readonly meta?: Readonly<Record<string, JsonValue>> | undefined;
}

export type AppToolVisibility = readonly ('model' | 'app')[];

export interface McpAppDescriptor {
  readonly serverId: string;
  readonly toolName: string;
  readonly qualifiedName: string;
  readonly resourceUri: string;
  readonly visibility: AppToolVisibility;
  readonly title?: string;
  readonly description?: string;
}

function asSdkTool(tool: AppToolSource): Partial<Tool> {
  return {
    name: tool.name,
    inputSchema: { type: 'object' },
    ...(tool.meta === undefined ? {} : { _meta: tool.meta }),
  };
}

export function toolVisibility(tool: AppToolSource): AppToolVisibility {
  const sdkTool = asSdkTool(tool);
  if (isToolVisibilityAppOnly(sdkTool)) return ['app'];
  if (isToolVisibilityModelOnly(sdkTool)) return ['model'];
  return ['model', 'app'];
}

export function isModelVisibleTool(tool: AppToolSource): boolean {
  return toolVisibility(tool).includes('model');
}

export function isAppVisibleTool(tool: AppToolSource): boolean {
  return toolVisibility(tool).includes('app');
}

export function discoverAppTools(
  serverId: string,
  tools: readonly AppToolSource[],
): readonly McpAppDescriptor[] {
  const result: McpAppDescriptor[] = [];
  for (const tool of tools) {
    let resourceUri: string | undefined;
    try {
      resourceUri = getToolUiResourceUri(asSdkTool(tool));
    } catch (error) {
      throw new PlinthwayError(
        'MCP_PROTOCOL_ERROR',
        `MCP App resource for ${serverId}.${tool.name} must use a ui:// URI`,
        { serverId, toolName: tool.name },
        { cause: error },
      );
    }
    if (resourceUri === undefined) continue;
    result.push({
      serverId,
      toolName: tool.name,
      qualifiedName: `${serverId}.${tool.name}`,
      resourceUri,
      visibility: toolVisibility(tool),
      ...(tool.title === undefined ? {} : { title: tool.title }),
      ...(tool.description === undefined ? {} : { description: tool.description }),
    });
  }
  return result;
}
