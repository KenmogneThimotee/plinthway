import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { globalConfigSchema, type GlobalConfig } from '@plinthway/config';
import type { ModelMetadata } from '@plinthway/model-registry';
import {
  asProfileId,
  PlinthwayError,
  type EffectiveProfile,
  type WorkProfile,
} from '@plinthway/shared';

export function profile(overrides: Partial<WorkProfile> = {}): WorkProfile {
  return {
    schemaVersion: 1,
    id: asProfileId('coding'),
    name: 'Coding',
    model: {
      primary: 'openai/gpt-test',
      fallback: ['openai/gpt-fallback'],
      parameters: { temperature: 0.2, maxOutputTokens: 1024 },
    },
    mcp: { enabled: ['files'] },
    tools: {
      defaultPolicy: 'deny',
      rules: [
        { tool: 'files.read', action: 'allow' },
        { tool: 'builtin.clock', action: 'allow' },
      ],
    },
    agent: {
      instructionsFile: '../../instructions/coding.md',
      maxSteps: 12,
      toolTimeoutSeconds: 30,
    },
    session: { persist: true },
    ...overrides,
  };
}

export function globalConfig(): GlobalConfig {
  return globalConfigSchema.parse({
    schemaVersion: 1,
    providers: {
      openai: { adapter: 'openai', authPlugin: 'openai-key' },
    },
    mcpServers: {
      files: {
        transport: 'stdio',
        command: process.execPath,
        args: ['${WORKSPACE}'],
        env: [],
      },
    },
    security: {},
  });
}

export class FakeRegistry {
  readonly models = new Set(['openai/gpt-test', 'openai/gpt-fallback', 'openai/gpt-override']);

  get(id: string): Promise<ModelMetadata> {
    if (!this.models.has(id)) {
      return Promise.reject(
        new PlinthwayError('MODEL_NOT_FOUND', `Model ${id} was not found`, { modelId: id }),
      );
    }
    const [providerId = '', modelId = ''] = id.split('/', 2);
    return Promise.resolve({
      id,
      providerId,
      modelId,
      name: id,
      capabilities: { toolCalls: true, reasoning: false, structuredOutput: true },
    });
  }
}

export class MemoryActiveProfileStore {
  active: EffectiveProfile | undefined;

  get(): Promise<EffectiveProfile | undefined> {
    return Promise.resolve(this.active);
  }
}

export async function createProfileLayout(root: string): Promise<{
  readonly profiles: string;
  readonly instructions: string;
}> {
  const profiles = path.join(root, 'profiles');
  const instructions = path.join(root, 'instructions');
  await mkdir(profiles, { recursive: true });
  await mkdir(instructions, { recursive: true });
  await writeFile(path.join(instructions, 'coding.md'), 'Follow project conventions.\n', 'utf8');
  return { profiles, instructions };
}
