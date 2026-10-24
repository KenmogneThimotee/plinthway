import { beforeEach, describe, expect, it, vi } from 'vitest';

import { asProfileId, type WorkProfile } from '@plinthway/shared';
import type { ProfileValidationResult } from '@plinthway/profiles';

const prompts = vi.hoisted(() => ({
  answers: [] as string[][],
  errors: [] as string[],
  runValidation: true,
}));

vi.mock('@inquirer/prompts', () => ({
  input: vi.fn(
    async (config: {
      readonly message: string;
      readonly validate?: (value: string) => boolean | string | Promise<boolean | string>;
    }) => {
      const answers = prompts.answers.shift();
      if (answers === undefined) throw new Error(`No answers configured for ${config.message}`);
      for (const answer of answers) {
        if (!prompts.runValidation || config.validate === undefined) return answer;
        const result = await config.validate(answer);
        if (result === true) return answer;
        prompts.errors.push(String(result));
      }
      throw new Error(`No valid answer configured for ${config.message}`);
    },
  ),
}));

import { runCli, type CliApplication, type CliContext } from '../../src/application.js';

function existingProfile(id = 'default'): WorkProfile {
  return {
    schemaVersion: 1,
    id: asProfileId(id),
    name: id,
    model: { fallback: [], parameters: {} },
    mcp: { enabled: [] },
    tools: { defaultPolicy: 'deny', rules: [] },
    agent: { maxSteps: 10 },
    session: { persist: true },
  };
}

function fixture(
  options: {
    readonly existing?: readonly WorkProfile[];
    readonly validate?: (
      profile: WorkProfile,
    ) => ProfileValidationResult | Promise<ProfileValidationResult>;
  } = {},
) {
  let stdout = '';
  let stderr = '';
  const createProfile = vi.fn().mockResolvedValue(undefined);
  const application = {
    listProfiles: vi.fn().mockResolvedValue(options.existing ?? []),
    validateProfile: vi.fn(
      options.validate ?? (() => ({ valid: true, issues: [] }) satisfies ProfileValidationResult),
    ),
    createProfile,
  } as unknown as CliApplication;
  const context: CliContext = {
    application,
    stdout: { write: (value) => (stdout += value) },
    stderr: { write: (value) => (stderr += value) },
    stdin: { isTTY: true } as NodeJS.ReadStream,
    env: {},
    initializeHome: vi.fn().mockResolvedValue(undefined),
  };
  return { application, context, createProfile, stdout: () => stdout, stderr: () => stderr };
}

beforeEach(() => {
  prompts.answers = [];
  prompts.errors = [];
  prompts.runValidation = true;
});

describe('interactive profile creation', () => {
  it('re-prompts invalid identity fields and creates a trimmed model-less profile', async () => {
    prompts.answers = [
      ['Invalid ID', 'default', ' local '],
      ['   ', 'x'.repeat(101), ' Local profile '],
      ['chatgtp', '   '],
    ];
    const value = fixture({ existing: [existingProfile()] });

    expect(await runCli(['profile', 'create'], value.context)).toBe(0);
    expect(prompts.errors).toEqual([
      'Use lowercase letters, numbers, and hyphens, starting with a letter.',
      'Profile default already exists.',
      'Profile name must contain 1-100 characters.',
      'Profile name must contain 1-100 characters.',
      'Enter a model as provider/model, or leave it blank to configure later.',
    ]);
    expect(value.createProfile).toHaveBeenCalledWith({
      schemaVersion: 1,
      id: 'local',
      name: 'Local profile',
      model: { fallback: [], parameters: {} },
      mcp: { enabled: [] },
      tools: { defaultPolicy: 'deny', rules: [] },
      agent: { maxSteps: 10 },
      session: { persist: true },
    });
    expect(value.stdout()).toBe('Created profile local\n');
    expect(value.stderr()).toBe('');
  });

  it('re-prompts unavailable models and persists an available trimmed model reference', async () => {
    prompts.answers = [['local'], ['Local'], ['missing/model', ' openai/gpt-test ']];
    const value = fixture({
      validate: (profile) =>
        profile.model.primary === 'missing/model'
          ? {
              valid: false,
              issues: [
                {
                  code: 'provider-not-found',
                  path: 'model.primary',
                  message: 'Provider missing is not configured',
                },
              ],
            }
          : { valid: true, issues: [] },
    });

    expect(await runCli(['profile', 'create'], value.context)).toBe(0);
    expect(prompts.errors).toEqual(['Provider missing is not configured']);
    expect(value.createProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'local',
        model: { primary: 'openai/gpt-test', fallback: [], parameters: {} },
      }),
    );
  });

  it('returns PROFILE_INVALID when a prompt bypasses validation', async () => {
    prompts.runValidation = false;
    prompts.answers = [['local'], ['Local'], ['chatgtp']];
    const value = fixture();

    expect(await runCli(['profile', 'create'], value.context)).toBe(2);
    expect(value.stderr()).toContain('PROFILE_INVALID: Profile input is invalid');
    expect(value.stderr()).toContain('model.primary:');
    expect(value.createProfile).not.toHaveBeenCalled();
  });
});
