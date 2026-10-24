import { PlinthwayError } from '@plinthway/shared';

import type {
  McpConnectionPort,
  McpPrompt,
  McpResource,
  McpResourceTemplate,
  NativeMcpPrompt,
  NativeMcpResource,
  NativeMcpResourceTemplate,
} from './contracts.js';

export interface PromptCatalogEntry {
  readonly connection: McpConnectionPort;
  readonly prompt: McpPrompt;
}

export interface ResourceCatalogEntry {
  readonly connection: McpConnectionPort;
  readonly resource: McpResource;
}

export interface ResourceTemplateCatalogEntry {
  readonly connection: McpConnectionPort;
  readonly resourceTemplate: McpResourceTemplate;
}

export interface CapabilityCatalogInput {
  readonly prompts: readonly NativeMcpPrompt[];
  readonly resources: readonly NativeMcpResource[];
  readonly resourceTemplates: readonly NativeMcpResourceTemplate[];
}

function resourceKey(serverId: string, uri: string): string {
  return JSON.stringify([serverId, uri]);
}

export class CapabilityCatalogs {
  readonly #prompts = new Map<string, PromptCatalogEntry>();
  readonly #resources = new Map<string, ResourceCatalogEntry>();
  readonly #resourceTemplates = new Map<string, ResourceTemplateCatalogEntry>();

  add(connection: McpConnectionPort, input: CapabilityCatalogInput): void {
    for (const nativePrompt of input.prompts) {
      const name = `${connection.serverId}.${nativePrompt.name}`;
      if (this.#prompts.has(name)) this.#duplicate(connection.serverId, 'prompt', name);
      this.#prompts.set(name, {
        connection,
        prompt: {
          ...nativePrompt,
          name,
          nativeName: nativePrompt.name,
          serverId: connection.serverId,
        },
      });
    }
    for (const nativeResource of input.resources) {
      const key = resourceKey(connection.serverId, nativeResource.uri);
      if (this.#resources.has(key)) {
        this.#duplicate(connection.serverId, 'resource', nativeResource.uri);
      }
      this.#resources.set(key, {
        connection,
        resource: { ...nativeResource, serverId: connection.serverId },
      });
    }
    for (const nativeTemplate of input.resourceTemplates) {
      const key = resourceKey(connection.serverId, nativeTemplate.uriTemplate);
      if (this.#resourceTemplates.has(key)) {
        this.#duplicate(connection.serverId, 'resource template', nativeTemplate.uriTemplate);
      }
      this.#resourceTemplates.set(key, {
        connection,
        resourceTemplate: { ...nativeTemplate, serverId: connection.serverId },
      });
    }
  }

  #duplicate(serverId: string, kind: string, identity: string): never {
    throw new PlinthwayError('MCP_PROTOCOL_ERROR', `MCP server returned duplicate ${kind}`, {
      serverId,
      identity,
    });
  }

  remove(connection: McpConnectionPort): void {
    for (const [key, entry] of this.#prompts) {
      if (entry.connection === connection) this.#prompts.delete(key);
    }
    for (const [key, entry] of this.#resources) {
      if (entry.connection === connection) this.#resources.delete(key);
    }
    for (const [key, entry] of this.#resourceTemplates) {
      if (entry.connection === connection) this.#resourceTemplates.delete(key);
    }
  }

  getPrompt(name: string): PromptCatalogEntry | undefined {
    return this.#prompts.get(name);
  }

  getResource(serverId: string, uri: string): ResourceCatalogEntry | undefined {
    return this.#resources.get(resourceKey(serverId, uri));
  }

  getResourceTemplate(
    serverId: string,
    uriTemplate: string,
  ): ResourceTemplateCatalogEntry | undefined {
    return this.#resourceTemplates.get(resourceKey(serverId, uriTemplate));
  }

  listPrompts(): readonly McpPrompt[] {
    return [...this.#prompts.values()]
      .map(({ prompt }) => prompt)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  listResources(): readonly McpResource[] {
    return [...this.#resources.values()]
      .map(({ resource }) => resource)
      .sort((left, right) =>
        resourceKey(left.serverId, left.uri).localeCompare(resourceKey(right.serverId, right.uri)),
      );
  }

  listResourceTemplates(): readonly McpResourceTemplate[] {
    return [...this.#resourceTemplates.values()]
      .map(({ resourceTemplate }) => resourceTemplate)
      .sort((left, right) =>
        resourceKey(left.serverId, left.uriTemplate).localeCompare(
          resourceKey(right.serverId, right.uriTemplate),
        ),
      );
  }
}
