import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import type { Command } from 'commander';
import { input } from '@inquirer/prompts';
import { parseDocument, stringify } from 'yaml';

import { profileIdSchema } from '@plinthway/config';
import { PlinthwayError, type WorkProfile } from '@plinthway/shared';
import { workProfileSchema } from '@plinthway/profiles';

import type { CliContext } from '../application.js';
import { writeRecord } from '../application.js';

async function readProfile(file: string): Promise<WorkProfile> {
  const source = await readFile(path.resolve(file), 'utf8');
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new PlinthwayError('PROFILE_INVALID', 'Profile YAML is invalid');
  }
  const parsed = workProfileSchema.safeParse(document.toJS());
  if (!parsed.success) {
    throw new PlinthwayError('PROFILE_INVALID', 'Profile failed schema validation', {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}

function guidedProfileInput(id: string, name: string, model: string): unknown {
  return {
    schemaVersion: 1,
    id,
    name,
    model: {
      ...(model.length === 0 ? {} : { primary: model }),
      fallback: [],
      parameters: {},
    },
    mcp: { enabled: [] },
    tools: { defaultPolicy: 'deny', rules: [] },
    agent: { maxSteps: 10 },
    session: { persist: true },
  };
}

function parseGuidedProfile(id: string, name: string, model: string): WorkProfile {
  const parsed = workProfileSchema.safeParse(guidedProfileInput(id, name, model));
  if (!parsed.success) {
    throw new PlinthwayError('PROFILE_INVALID', 'Profile input is invalid', {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}

async function guidedProfile(application: CliContext['application']): Promise<WorkProfile> {
  const profiles = await application.listProfiles();
  const rawId = await input({
    message: 'Profile ID',
    validate: (value) => {
      const candidate = value.trim();
      if (!profileIdSchema.safeParse(candidate).success) {
        return 'Use lowercase letters, numbers, and hyphens, starting with a letter.';
      }
      return profiles.some((profile) => profile.id === candidate)
        ? `Profile ${candidate} already exists.`
        : true;
    },
  });
  const id = rawId.trim();
  const rawName = await input({
    message: 'Profile name',
    default: id,
    validate: (value) => {
      const candidate = value.trim();
      const parsed = workProfileSchema.safeParse(guidedProfileInput(id, candidate, ''));
      return parsed.success || !parsed.error.issues.some((issue) => issue.path[0] === 'name')
        ? true
        : 'Profile name must contain 1-100 characters.';
    },
  });
  const name = rawName.trim();
  const promptAbort = new AbortController();
  let validationFailure: { readonly error: unknown } | undefined;
  let rawModel: string;
  try {
    rawModel = await input(
      {
        message: 'Primary model (provider/model, leave blank to configure later)',
        validate: async (value) => {
          const candidate = value.trim();
          if (candidate.length === 0) return true;
          const parsed = workProfileSchema.safeParse(guidedProfileInput(id, name, candidate));
          if (!parsed.success) {
            return 'Enter a model as provider/model, or leave it blank to configure later.';
          }
          try {
            const result = await application.validateProfile(parsed.data);
            if (result.valid) return true;
            return (
              result.issues.find((issue) => issue.path === 'model.primary')?.message ??
              'The selected model is not available for this profile.'
            );
          } catch (error) {
            validationFailure = { error };
            promptAbort.abort(error);
            return true;
          }
        },
      },
      { signal: promptAbort.signal },
    );
  } catch (error) {
    if (validationFailure !== undefined) throw validationFailure.error;
    throw error;
  }
  return parseGuidedProfile(id, name, rawModel.trim());
}

function defaultEditor(editor: string, file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(editor, [file], { shell: false, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new PlinthwayError('PROFILE_INVALID', `Editor exited with ${String(code)}`));
    });
  });
}

export function registerProfileCommands(program: Command, context: CliContext): void {
  const profile = program.command('profile').description('manage work profiles');
  profile.command('list').action(async (_options, command: Command) => {
    const values = await context.application.listProfiles();
    writeRecord(
      context,
      command,
      values,
      values.map((value) => `${value.id}\t${value.model.primary ?? 'not configured'}`).join('\n'),
    );
  });
  profile.command('show <id>').action(async (id: string, _options, command: Command) => {
    const value = await context.application.getProfile(id);
    writeRecord(context, command, value, stringify(value).trimEnd());
  });
  profile
    .command('create')
    .option('--from <yaml>')
    .action(async (options: { from?: string }, command: Command) => {
      let value: WorkProfile;
      if (options.from !== undefined) value = await readProfile(options.from);
      else if (context.stdin.isTTY) value = await guidedProfile(context.application);
      else {
        throw new PlinthwayError(
          'CONFIG_INVALID',
          'Non-interactive profile creation requires --from',
        );
      }
      await context.application.createProfile(value);
      writeRecord(context, command, value, `Created profile ${value.id}`);
    });
  profile.command('validate <id>').action(async (id: string, _options, command: Command) => {
    const value = await context.application.getProfile(id);
    const result = await context.application.validateProfile(value);
    writeRecord(
      context,
      command,
      result,
      result.valid
        ? `${id}: valid`
        : result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n'),
    );
    if (!result.valid) throw new PlinthwayError('PROFILE_INVALID', `Profile ${id} is invalid`);
  });
  profile
    .command('use <id>')
    .option('--cancel-active', 'cancel an active execution')
    .action(async (id: string, options: { cancelActive?: boolean }, command: Command) => {
      const active = await context.application.switchProfile(id, {
        onBusy: options.cancelActive === true ? 'cancel' : 'wait',
      });
      writeRecord(context, command, active, `Active profile: ${active.id}`);
    });
  profile
    .command('switch <id>')
    .option('--cancel-active', 'cancel an active execution')
    .action(async (id: string, options: { cancelActive?: boolean }, command: Command) => {
      const active = await context.application.switchProfile(id, {
        onBusy: options.cancelActive === true ? 'cancel' : 'wait',
      });
      writeRecord(context, command, active, `Active profile: ${active.id}`);
    });
  profile
    .command('delete <id>')
    .option('--deactivate', 'deactivate first if this profile is active')
    .action(async (id: string, options: { deactivate?: boolean }, command: Command) => {
      if (options.deactivate === true) {
        await context.application.deactivateProfile({ onBusy: 'wait' });
      }
      await context.application.deleteProfile(id);
      writeRecord(context, command, { deleted: id }, `Deleted profile ${id}`);
    });
  profile.command('export <id>').action(async (id: string, _options, command: Command) => {
    const value = await context.application.exportProfile(id);
    writeRecord(context, command, value, stringify(value).trimEnd());
  });
  profile.command('edit <id>').action(async (id: string, _options, command: Command) => {
    const value = await context.application.getProfile(id);
    const editor = context.env.EDITOR ?? context.env.VISUAL;
    if (editor === undefined || editor.length === 0) {
      throw new PlinthwayError('CONFIG_INVALID', 'EDITOR or VISUAL must be configured');
    }
    const directory = await mkdtemp(path.join(tmpdir(), 'plinthway-profile-'));
    const temporary = path.join(directory, `${id}.yaml`);
    try {
      await writeFile(temporary, stringify(value), { mode: 0o600 });
      await (context.editor ?? defaultEditor)(editor, temporary);
      const updated = await readProfile(temporary);
      await context.application.updateProfile(id, updated);
      writeRecord(context, command, updated, `Updated profile ${id}`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
