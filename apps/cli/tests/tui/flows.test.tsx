import { describe, expect, it } from 'vitest';
import { renderToString } from 'ink';
import { createElement, type ComponentType } from 'react';

import { CommandHelper } from '../../src/tui/commands.js';
import { Conversation, nextScrollTop } from '../../src/tui/components/conversation.js';
import { Header } from '../../src/tui/components/header.js';
import { ApprovalOverlay } from '../../src/tui/overlays/approval.js';
import { McpOverlay, mcpInteractionNeedsResponse } from '../../src/tui/overlays/mcp.js';
import { ModelsOverlay } from '../../src/tui/overlays/models.js';
import { initialTuiState, tuiReducer } from '../../src/tui/reducer.js';

describe('TUI flows', () => {
  it('opens every contextual overlay only through explicit UI events', () => {
    for (const overlay of [
      'profiles',
      'models',
      'mcp',
      'tools',
      'sessions',
      'auth',
      'help',
    ] as const) {
      const state = tuiReducer(initialTuiState(), { type: 'overlay-opened', overlay });
      expect(state.overlay).toBe(overlay);
    }
  });

  it('records streaming assistant content and tool summaries', () => {
    let state = tuiReducer(initialTuiState(), { type: 'message-submitted', text: 'hello' });
    state = tuiReducer(state, { type: 'assistant-delta', text: 'hi ' });
    state = tuiReducer(state, { type: 'assistant-delta', text: 'there' });
    state = tuiReducer(state, {
      type: 'tool-summary',
      text: 'files.read denied',
      tone: 'warning',
    });
    expect(state.conversation.at(-2)).toMatchObject({ text: 'hi there' });
    expect(state.conversation.at(-1)).toMatchObject({ text: 'files.read denied' });
  });

  it('renders assistant Markdown as terminal structure without showing markup characters', () => {
    const output = renderToString(
      <Conversation
        items={[
          {
            id: 1,
            kind: 'assistant',
            tone: 'normal',
            text: '# Plan\n\nUse **bold** and `code`.\n\n- first\n- second\n\n[docs](https://example.com)',
          },
        ]}
      />,
    );

    expect(output).toContain('Plan');
    expect(output).toContain('• first');
    expect(output).toContain('docs (https://example.com)');
    expect(output).not.toContain('# Plan');
    expect(output).not.toContain('**bold**');
    expect(output).not.toContain('`code`');
  });

  it('shows an in-conversation activity indicator only while awaiting model output', () => {
    const renderConversation = (loading: boolean) =>
      renderToString(
        createElement(
          Conversation as ComponentType<{
            readonly items: readonly unknown[];
            readonly loading: boolean;
          }>,
          { items: [], loading },
        ),
      );

    expect(renderConversation(true)).toContain('agent: thinking');
    expect(renderConversation(false)).not.toContain('thinking');
  });

  it('moves a row-based conversation viewport by pages and returns to the live edge', () => {
    expect(nextScrollTop({ current: 20, maximum: 30, pageSize: 6, action: 'page-up' })).toBe(14);
    expect(nextScrollTop({ current: 14, maximum: 30, pageSize: 6, action: 'page-down' })).toBe(20);
    expect(nextScrollTop({ current: 14, maximum: 30, pageSize: 6, action: 'end' })).toBe(30);
  });

  it('renders a keyboard-selectable slash-command helper', () => {
    const output = renderToString(<CommandHelper input="/m" selected={1} />);

    expect(output).toContain('/model');
    expect(output).toContain('› /mcp');
    expect(output).toContain('Inspect MCP servers and activity');
  });

  it('explains how to select a different profile model', () => {
    const output = renderToString(
      <ModelsOverlay
        models={[
          {
            id: 'chatgpt/gpt-old',
            providerId: 'chatgpt',
            modelId: 'gpt-old',
            name: 'GPT Old',
            capabilities: { toolCalls: true, reasoning: true, structuredOutput: true },
          },
          {
            id: 'chatgpt/gpt-new',
            providerId: 'chatgpt',
            modelId: 'gpt-new',
            name: 'GPT New',
            capabilities: { toolCalls: true, reasoning: true, structuredOutput: true },
          },
        ]}
        selected={1}
        current="chatgpt/gpt-old"
      />,
    );

    expect(output).toContain('GPT New · chatgpt/gpt-new');
    expect(output).toContain('GPT Old · chatgpt/gpt-old · current');
    expect(output).toContain('Enter selects');
    expect(output).not.toContain('Model selection is restricted');
  });

  it('preserves an exact prompt while account configuration is opened and cancelled', () => {
    let state = tuiReducer(initialTuiState(), {
      type: 'composer-changed',
      value: 'preserve this exact prompt',
    });
    state = tuiReducer(state, { type: 'overlay-opened', overlay: 'provider-setup' });
    state = tuiReducer(state, { type: 'overlay-closed' });
    expect(state.composer).toBe('preserve this exact prompt');
  });

  it('keeps profile, model, MCP health, and execution state visible in the header', () => {
    const output = renderToString(
      <Header
        profile="coding"
        model="openai/test"
        mcpHealth="healthy"
        phase="running"
        narrow={false}
      />,
    );
    expect(output).toContain('profile: ');
    expect(output).toContain('coding');
    expect(output).toContain('model: openai/test');
    expect(output).toContain('mcp: healthy');
    expect(output).toContain('running');
  });

  it('renders exact approval arguments, targets, annotations, and only two decisions', () => {
    const output = renderToString(
      <ApprovalOverlay
        approval={{
          serverId: 'files',
          toolName: 'files.write',
          arguments: { path: '/tmp/a', contents: 'hello' },
          targets: ['/tmp/a'],
          readOnlyHint: false,
          sideEffects: 'may modify external state',
        }}
      />,
    );
    expect(output).toContain('files.write');
    expect(output).toContain('{"contents":"hello","path":"/tmp/a"}');
    expect(output).toContain('/tmp/a');
    expect(output).toContain('[A] Allow once   [D] Deny');
    expect(output).not.toContain('Always allow');
  });

  it('renders MCP catalogs, auth/deprecation status, logs, and pending interaction consent', () => {
    const output = renderToString(
      <McpOverlay
        statuses={[
          {
            serverId: 'docs',
            enabled: true,
            state: 'auth-required',
            authorization: { state: 'required', reason: 'login required' },
            deprecationWarnings: ['MCP logging is deprecated'],
          },
        ]}
        prompts={[{ name: 'docs.summarize', nativeName: 'summarize', serverId: 'docs' }]}
        resources={[{ uri: 'docs://guide', name: 'Guide', serverId: 'docs' }]}
        skills={[
          {
            serverId: 'docs',
            uri: 'skill://docs/review/SKILL.md',
            frontmatter: { name: 'review', description: 'Review changes' },
            resources: 'dynamic',
          },
        ]}
        activeSkills={[
          {
            serverId: 'docs',
            uri: 'skill://docs/review/SKILL.md',
            manifestHash: 'hash',
            context: 'origin-labelled',
          },
        ]}
        apps={[
          {
            serverId: 'docs',
            toolName: 'review-ui',
            qualifiedName: 'docs.review-ui',
            resourceUri: 'ui://docs/review',
            visibility: ['app'],
          },
        ]}
        appSessions={[
          {
            id: 'app-1',
            origin: 'http://127.0.0.1:30001',
            proxyOrigin: 'http://127.0.0.1:30002',
            url: 'http://127.0.0.1:30001/#token',
            token: 'token',
            descriptor: {
              serverId: 'docs',
              toolName: 'review-ui',
              qualifiedName: 'docs.review-ui',
              resourceUri: 'ui://docs/review',
              visibility: ['app'],
            },
            closed: false,
            close: () => Promise.resolve(),
            waitUntilClosed: () => Promise.resolve(),
          },
        ]}
        events={[{ type: 'logging', serverId: 'docs', level: 'warning', data: 'check' }]}
        tasks={[
          {
            serverId: 'docs',
            profileGenerationId: 'generation-1',
            toolName: 'docs.report',
            reference: {
              endpointId: 'endpoint-1',
              generation: 'v2',
              taskId: 'task-1',
              originalOperation: 'tools/call',
            },
            status: 'working',
            createdAt: '2026-10-18T00:00:00.000Z',
            updatedAt: '2026-10-18T00:00:01.000Z',
          },
        ]}
        interactions={[
          {
            id: 'interaction-1',
            serverId: 'docs',
            method: 'elicitation/create',
            params: { mode: 'url', url: 'https://example.com/consent' },
            deprecated: false,
          },
        ]}
      />,
    );
    expect(output).toContain('auth-required');
    expect(output).toContain('login required');
    expect(output).toContain('docs.summarize');
    expect(output).toContain('docs://guide');
    expect(output).toContain('skill · docs · review · active');
    expect(output).toContain('app · docs.review-ui · ui://docs/review');
    expect(output).toContain('app open · app-1');
    expect(output).toContain('warning');
    expect(output).toContain('task-1');
    expect(output).toContain('docs.report');
    expect(output).toContain('https://example.com/consent');
    expect(output).toContain('[A] Approve [D] Decline [X] Cancel');
    expect(output).not.toContain('› docs · auth-required');
  });

  it('renders configured MCP servers that are not connected', () => {
    const output = renderToString(
      <McpOverlay
        statuses={[
          { serverId: 'docs', label: 'Work Docs', enabled: true, state: 'ready' },
          { serverId: 'search', label: 'Web Search', enabled: false, state: 'disconnected' },
        ]}
        selectedServer={1}
      />,
    );

    expect(output).toContain('  Work Docs (docs) · ready');
    expect(output).toContain('› Web Search (search) · disconnected');
    expect(output).toContain('[Enter] Connect selected server');
    expect(output).toContain('↑/↓ Select server');
    expect(output).toContain('/mcp connect <server>');
    expect(output).toContain('/mcp disconnect <server>');
  });

  it('requires explicit JSON for form elicitation and sampling responses', () => {
    const form = {
      id: 'form-1',
      serverId: 'docs',
      method: 'elicitation/create' as const,
      params: { mode: 'form', message: 'Choose', requestedSchema: { type: 'object' } },
      deprecated: false,
    };
    const sampling = {
      id: 'sample-1',
      serverId: 'docs',
      method: 'sampling/createMessage' as const,
      params: { messages: [] },
      deprecated: true,
    };
    expect(mcpInteractionNeedsResponse(form)).toBe(true);
    expect(mcpInteractionNeedsResponse(sampling)).toBe(true);
    const output = renderToString(
      <McpOverlay
        statuses={[]}
        interactions={[form, sampling]}
        selectedInteraction={1}
        responseDraft={'{"role":"assistant","content":{"type":"text","text":"ok"}}'}
      />,
    );
    expect(output).toContain('Response JSON:');
    expect(output).toContain('sampling/createMessage');
    expect(output).toContain('[Enter] Approve response [D] Decline [X] Cancel');
  });
});
