import { describe, expect, it } from 'vitest';

import type { ModelMetadata } from './normalizer.js';
import { ProfileModelCatalog } from './profile-catalog.js';

const catalogModel: ModelMetadata = {
  id: 'openai/gpt-test',
  providerId: 'openai',
  modelId: 'gpt-test',
  name: 'GPT Test',
  contextLimit: 8192,
  capabilities: { toolCalls: true, reasoning: false, structuredOutput: true },
};

describe('ProfileModelCatalog', () => {
  it('uses Models.dev metadata for configured providers and overlays profile declarations', async () => {
    const catalog = new ProfileModelCatalog(
      {
        get: (id) =>
          id === catalogModel.id
            ? Promise.resolve(catalogModel)
            : Promise.reject(Object.assign(new Error('missing'), { code: 'MODEL_NOT_FOUND' })),
      },
      {
        openai: {
          models: { 'gpt-test': { name: 'Profile GPT', reasoning: true } },
        },
      },
    );

    await expect(catalog.get('openai/gpt-test')).resolves.toMatchObject({
      name: 'Profile GPT',
      contextLimit: 8192,
      capabilities: { toolCalls: true, reasoning: true, structuredOutput: true },
    });
  });

  it('resolves manually declared custom models without Models.dev metadata', async () => {
    const catalog = new ProfileModelCatalog(
      {
        get: () => Promise.reject(Object.assign(new Error('missing'), { code: 'MODEL_NOT_FOUND' })),
      },
      {
        local: {
          models: {
            'llama-3': {
              name: 'Llama 3',
              contextLimit: 4096,
              toolCalls: false,
              reasoning: false,
              structuredOutput: true,
            },
          },
        },
      },
    );

    await expect(catalog.get('local/llama-3')).resolves.toEqual({
      id: 'local/llama-3',
      providerId: 'local',
      modelId: 'llama-3',
      name: 'Llama 3',
      contextLimit: 4096,
      capabilities: { toolCalls: false, reasoning: false, structuredOutput: true },
    });
  });

  it('lists account-discovered ChatGPT declarations without Models.dev metadata', async () => {
    const catalog = new ProfileModelCatalog(
      {
        get: () => Promise.reject(Object.assign(new Error('missing'), { code: 'MODEL_NOT_FOUND' })),
      },
      {
        chatgpt: {
          models: {
            'gpt-test': { name: 'GPT Test', toolCalls: true },
          },
        },
      },
    );

    const declared = await catalog.listDeclared('chatgpt');
    expect(declared).toHaveLength(1);
    expect(declared[0]).toMatchObject({
      id: 'chatgpt/gpt-test',
      name: 'GPT Test',
      capabilities: { toolCalls: true },
    });
  });
});
