import { Command, CommanderError } from 'commander';

import {
  PlinthwayError,
  PLINTHWAY_VERSION,
  redact,
  type EffectiveProfile,
  type LLMEvent,
  type SessionId,
  type ToolDescriptor,
  type WorkProfile,
} from '@plinthway/shared';
import type {
  AuthService,
  ChatGptConnectionSummary,
  ChatGptLoginOptions,
  ChatGptModel,
} from '@plinthway/auth';
import type { McpServerConfig } from '@plinthway/config';
import type { McpManager } from '@plinthway/mcp-client';
import type { ModelMetadata, ModelRegistry } from '@plinthway/model-registry';
import type { StoredSession } from '@plinthway/sessions';
import type { ProfileValidationResult, SanitizedProfileExport } from '@plinthway/profiles';
import type { ProfileProvider } from '@plinthway/profiles';
import type {
  ConfiguredMcpServerStatus,
  ProfileModelCatalogSnapshot,
  ResumeResult,
} from '@plinthway/app-core';
import type { ApprovalPromptRouter } from '@plinthway/policy';

import { registerAuthCommands } from './commands/auth.js';
import { registerInitCommand } from './commands/init.js';
import { registerMcpCommands } from './commands/mcp.js';
import { registerModelCommands } from './commands/models.js';
import { registerProfileCommands } from './commands/profile.js';
import { registerRunCommand } from './commands/run.js';
import { registerSessionCommands } from './commands/sessions.js';

export interface TextWriter {
  write(value: string): unknown;
}

export interface CliApplication {
  initialize(): Promise<WorkProfile | EffectiveProfile | undefined>;
  switchProfile(
    id: string,
    busy: { readonly onBusy: 'wait' | 'cancel' },
  ): Promise<WorkProfile | EffectiveProfile>;
  deactivateProfile(busy: { readonly onBusy: 'wait' | 'cancel' }): Promise<void>;
  listProfiles(): Promise<readonly WorkProfile[]>;
  listTools(): readonly ToolDescriptor[];
  getProfile(id: string): Promise<WorkProfile>;
  validateProfile(profile: WorkProfile): Promise<ProfileValidationResult>;
  createProfile(profile: WorkProfile): Promise<void>;
  updateProfile(id: string, profile: WorkProfile): Promise<void>;
  addMcpServer(
    profileId: string,
    serverId: string,
    server: McpServerConfig,
    options?: { readonly replace?: boolean },
  ): Promise<void>;
  setMcpServerLabel(profileId: string, serverId: string, label: string | undefined): Promise<void>;
  setMcpServerEnabled(profileId: string, serverId: string, enabled: boolean): Promise<void>;
  removeMcpServer(profileId: string, serverId: string): Promise<void>;
  listMcpServers(profileId?: string): Promise<readonly ConfiguredMcpServerStatus[]>;
  deleteProfile(id: string): Promise<void>;
  exportProfile(id: string): Promise<SanitizedProfileExport>;
  configureProvider(input: {
    readonly profileId: string;
    readonly providerId: string;
    readonly provider: ProfileProvider;
    readonly apiKey?: string;
    readonly primaryModel?: string;
  }): Promise<void>;
  configureChatGptProvider(input: {
    readonly profileId: string;
    readonly connectionId: string;
    readonly model: ChatGptModel;
  }): Promise<void>;
  listAvailableModels(profileId: string): Promise<readonly ModelMetadata[]>;
  getModelCatalog(profileId: string): Promise<ProfileModelCatalogSnapshot>;
  refreshModelCatalogAccounts(profileId: string): Promise<ProfileModelCatalogSnapshot>;
  signInChatGpt(options: ChatGptLoginOptions): Promise<ChatGptConnectionSummary>;
  listChatGptAccounts(): Promise<readonly ChatGptConnectionSummary[]>;
  listChatGptModels(connectionId: string, signal?: AbortSignal): Promise<readonly ChatGptModel[]>;
  disconnectChatGpt(connectionId: string): Promise<{ readonly revocationConfirmed: boolean }>;
  selectModels(profileId: string, primary: string, fallback?: readonly string[]): Promise<void>;
  activateModelSelection(input: {
    readonly profileId: string;
    readonly modelRef: string;
    readonly setup?: {
      readonly providerId: string;
      readonly provider: ProfileProvider;
      readonly apiKey?: string;
    };
  }): Promise<StoredSession>;
  setProviderApiKey(profileId: string, providerId: string, secret: string): Promise<void>;
  deleteProviderCredential(profileId: string, providerId: string): Promise<void>;
  providerCredentialStatus(profileId: string, providerId: string): Promise<boolean>;
  prepareMcp(profileId?: string): Promise<void>;
  run(
    prompt: string,
    options?: {
      readonly profileId?: string;
      readonly sessionId?: SessionId;
      readonly signal?: AbortSignal;
    },
  ): Promise<{ readonly session: StoredSession; readonly events: AsyncGenerator<LLMEvent> }>;
  newSession(options?: {
    readonly profileId?: string;
    readonly modelOverride?: string;
  }): Promise<StoredSession>;
  listSessions(): Promise<readonly StoredSession[]>;
  resumeSession(id: SessionId): Promise<ResumeResult>;
  branchSession(
    id: SessionId,
    options: { readonly profileId: string; readonly skipDependencyPreparation?: boolean },
  ): Promise<StoredSession>;
  readonly models: ModelRegistry | undefined;
  readonly auth: AuthService | undefined;
  readonly mcp: McpManager | undefined;
  readonly approvalPrompts: ApprovalPromptRouter | undefined;
}

export interface CliContext {
  readonly application: CliApplication;
  readonly stdout: TextWriter;
  readonly stderr: TextWriter;
  readonly stdin: NodeJS.ReadStream;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly initializeHome: (force: boolean) => Promise<void>;
  readonly editor?: (editor: string, file: string) => Promise<void>;
  readonly signal?: AbortSignal;
}

export function jsonMode(command: Command): boolean {
  return command.optsWithGlobals<{ json?: boolean }>().json === true;
}

export function writeRecord(
  context: CliContext,
  command: Command,
  value: unknown,
  text: string,
): void {
  context.stdout.write(jsonMode(command) ? `${JSON.stringify(redact(value))}\n` : `${text}\n`);
}

export function requireService<T>(service: T | undefined, name: string): T {
  if (service === undefined) {
    throw new PlinthwayError('CONFIG_INVALID', `${name} service is not configured`);
  }
  return service;
}

function isUnknownRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function configurationIssueText(details: unknown): string {
  if (!isUnknownRecord(details)) return '';
  const issues = details['issues'];
  if (!Array.isArray(issues)) return '';
  return issues
    .flatMap((issue) => {
      if (!isUnknownRecord(issue)) return [];
      const message = issue['message'];
      if (typeof message !== 'string') return [];
      const path = issue['path'];
      return [typeof path !== 'string' || path.length === 0 ? message : `${path}: ${message}`];
    })
    .join('; ');
}

export function exitCodeFor(error: unknown): number {
  if (error instanceof CommanderError) return error.exitCode;
  if (!(error instanceof PlinthwayError)) return 1;
  if (
    error.code.startsWith('CONFIG_') ||
    error.code.startsWith('PROFILE_') ||
    error.code === 'MODEL_NOT_FOUND' ||
    error.code === 'MODEL_NOT_CONFIGURED' ||
    error.code === 'PROVIDER_NOT_CONFIGURED' ||
    error.code === 'CAPABILITY_UNSUPPORTED'
  ) {
    return 2;
  }
  if (
    error.code === 'CREDENTIAL_MISSING' ||
    error.code === 'AUTH_FAILED' ||
    error.code === 'KEYRING_UNAVAILABLE'
  )
    return 3;
  if (
    error.code.startsWith('MCP_') ||
    error.code === 'NETWORK_DENIED' ||
    error.code === 'REGISTRY_UNAVAILABLE' ||
    error.code === 'REGISTRY_INVALID' ||
    error.code === 'ADAPTER_UNSUPPORTED' ||
    error.code === 'RATE_LIMITED' ||
    error.code === 'PROVIDER_ERROR'
  ) {
    return 4;
  }
  if (
    error.code === 'TOOL_DENIED' ||
    error.code === 'CANCELLED' ||
    error.code === 'APPROVAL_REQUIRED'
  ) {
    return 5;
  }
  return 1;
}

export function createCliProgram(context: CliContext): Command {
  const program = new Command();
  program
    .name('plinthway')
    .description('Plinthway — local-first, policy-controlled AI runtime')
    .version(PLINTHWAY_VERSION)
    .option('--json', 'emit stable JSON or NDJSON')
    .exitOverride()
    .configureOutput({
      writeOut: (value) => context.stdout.write(value),
      writeErr: (value) => context.stderr.write(value),
    });
  registerInitCommand(program, context);
  registerProfileCommands(program, context);
  registerModelCommands(program, context);
  registerAuthCommands(program, context);
  registerMcpCommands(program, context);
  registerRunCommand(program, context);
  registerSessionCommands(program, context);
  program
    .command('chat')
    .description('open the interactive terminal interface')
    .action(async () => {
      const { startTui } = await import('./tui/app.js');
      await startTui(context.application, { stdin: context.stdin });
    });
  return program;
}

export async function runCli(arguments_: readonly string[], context: CliContext): Promise<number> {
  try {
    await createCliProgram(context).parseAsync([...arguments_], { from: 'user' });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    const safe =
      error instanceof PlinthwayError
        ? error.toJSON()
        : { name: 'Error', code: 'INTERNAL_ERROR', message: 'Command failed' };
    const jsonRequested = arguments_.includes('--json');
    const issueText =
      jsonRequested || !('details' in safe) ? '' : configurationIssueText(safe.details);
    context.stderr.write(
      jsonRequested
        ? `${JSON.stringify(safe)}\n`
        : `${String(safe.code)}: ${String(safe.message)}${issueText.length === 0 ? '' : ` (${issueText})`}\n`,
    );
    return exitCodeFor(error);
  }
}
