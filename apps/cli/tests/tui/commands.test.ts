import { describe, expect, it } from 'vitest';

import { commandSuggestions, parseComposerInput } from '../../src/tui/commands.js';

describe('parseComposerInput', () => {
  it.each([
    ['/profile', 'profile'],
    ['/profile new', 'profile'],
    ['/model', 'model'],
    ['/mcp', 'mcp'],
    ['/tools', 'tools'],
    ['/sessions', 'sessions'],
    ['/new', 'new'],
    ['/auth', 'auth'],
    ['/status', 'status'],
    ['/help', 'help'],
  ])('parses %s as the %s command', (input, name) => {
    expect(parseComposerInput(input)).toMatchObject({ kind: 'command', name });
  });

  it('treats escaped slash and ordinary text as messages', () => {
    expect(parseComposerInput('//literal')).toEqual({ kind: 'message', text: '/literal' });
    expect(parseComposerInput('use the research profile')).toEqual({
      kind: 'message',
      text: 'use the research profile',
    });
  });

  it('suggests up to three commands without sending unknown input', () => {
    expect(parseComposerInput('/profle')).toEqual({
      kind: 'unknown-command',
      input: '/profle',
      suggestions: ['/profile'],
    });
  });

  it('returns described slash-menu entries filtered by the typed prefix', () => {
    expect(commandSuggestions('/m')).toEqual([
      { command: '/model', description: 'Choose the active model' },
      { command: '/mcp', description: 'Inspect MCP servers and activity' },
    ]);
  });
});
