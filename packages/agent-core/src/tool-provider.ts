import {
  PlinthwayError,
  type JsonValue,
  type ToolDescriptor,
  type ToolInvocationDescription,
  type ToolInvocationOptions,
  type ToolInvocationResult,
  type ToolProvider,
} from '@plinthway/shared';

interface OwnedTool {
  readonly descriptor: ToolDescriptor;
  readonly provider: ToolProvider;
}

export class CompositeToolProvider implements ToolProvider {
  readonly #providers: readonly ToolProvider[];

  constructor(providers: readonly ToolProvider[]) {
    this.#providers = [...providers];
  }

  #catalog(): ReadonlyMap<string, OwnedTool> {
    const catalog = new Map<string, OwnedTool>();
    for (const provider of this.#providers) {
      for (const descriptor of provider.listTools()) {
        if (catalog.has(descriptor.name)) {
          throw new PlinthwayError('CONFIG_INVALID', `Duplicate tool ${descriptor.name}`, {
            toolName: descriptor.name,
          });
        }
        catalog.set(descriptor.name, { descriptor, provider });
      }
    }
    return catalog;
  }

  listTools(): readonly ToolDescriptor[] {
    return [...this.#catalog().values()]
      .map(({ descriptor }) => descriptor)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  invoke(
    toolName: string,
    argumentsValue: unknown,
    options: ToolInvocationOptions,
  ): Promise<ToolInvocationResult> {
    const owner = this.#catalog().get(toolName);
    if (owner === undefined) {
      return Promise.reject(
        new PlinthwayError('TOOL_NOT_FOUND', `Tool ${toolName} is not available`, { toolName }),
      );
    }
    return owner.provider.invoke(toolName, argumentsValue, options);
  }

  describeInvocation(
    toolName: string,
    argumentsValue: JsonValue,
  ): Promise<ToolInvocationDescription> {
    const owner = this.#catalog().get(toolName);
    if (owner === undefined) {
      return Promise.reject(
        new PlinthwayError('TOOL_NOT_FOUND', `Tool ${toolName} is not available`, { toolName }),
      );
    }
    if (owner.provider.describeInvocation !== undefined) {
      return owner.provider.describeInvocation(toolName, argumentsValue);
    }
    const readOnlyHint = owner.descriptor.annotations?.readOnlyHint === true;
    return Promise.resolve({
      targets: [],
      readOnlyHint,
      sideEffects: readOnlyHint ? 'none anticipated' : 'may modify external state',
    });
  }
}
