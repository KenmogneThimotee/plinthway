import { Box, Text } from 'ink';

export type SlashCommand =
  | 'profile'
  | 'provider'
  | 'model'
  | 'mcp'
  | 'tools'
  | 'sessions'
  | 'new'
  | 'auth'
  | 'status'
  | 'help';

export type ParsedInput =
  | { readonly kind: 'message'; readonly text: string }
  | { readonly kind: 'command'; readonly name: SlashCommand; readonly args: readonly string[] }
  | {
      readonly kind: 'unknown-command';
      readonly input: string;
      readonly suggestions: readonly string[];
    };

interface CommandDescriptor {
  readonly name: SlashCommand;
  readonly command: `/${SlashCommand}`;
  readonly description: string;
}

export interface CommandSuggestion {
  readonly command: string;
  readonly description: string;
}

const commands = [
  { name: 'profile', command: '/profile', description: 'Switch or create a profile' },
  { name: 'provider', command: '/provider', description: 'Configure a model provider' },
  { name: 'model', command: '/model', description: 'Choose the active model' },
  { name: 'mcp', command: '/mcp', description: 'Inspect MCP servers and activity' },
  { name: 'tools', command: '/tools', description: 'Review available tools and policy' },
  { name: 'sessions', command: '/sessions', description: 'Resume a saved session' },
  { name: 'new', command: '/new', description: 'Start a fresh session' },
  { name: 'auth', command: '/auth', description: 'Manage provider authentication' },
  { name: 'status', command: '/status', description: 'Show the active runtime status' },
  { name: 'help', command: '/help', description: 'Open command help' },
] as const satisfies readonly CommandDescriptor[];

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution = previous[rightIndex - 1] ?? 0;
      const insertion = current[rightIndex - 1] ?? 0;
      const deletion = previous[rightIndex] ?? 0;
      current[rightIndex] = Math.min(
        deletion + 1,
        insertion + 1,
        substitution + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] ?? right.length;
}

function suggestionsFor(input: string): readonly string[] {
  const ranked = commands
    .map(({ name }) => ({ command: name, distance: editDistance(input, name) }))
    .filter(({ command, distance }) => distance <= Math.max(2, Math.floor(command.length / 3)))
    .sort(
      (left, right) => left.distance - right.distance || left.command.localeCompare(right.command),
    );
  return ranked.slice(0, 3).map(({ command }) => `/${command}`);
}

function parseSlashCommand(input: string): ParsedInput {
  const [rawName = '', ...args] = input.slice(1).trim().split(/\s+/u);
  const name = rawName.toLowerCase();
  if (commands.some((command) => command.name === name)) {
    return { kind: 'command', name: name as SlashCommand, args };
  }
  return { kind: 'unknown-command', input, suggestions: suggestionsFor(name) };
}

export function parseComposerInput(input: string): ParsedInput {
  if (input.startsWith('//')) return { kind: 'message', text: input.slice(1) };
  if (!input.startsWith('/')) return { kind: 'message', text: input };
  return parseSlashCommand(input);
}

export function commandCompletions(input: string): readonly string[] {
  return commandSuggestions(input).map(({ command }) => command);
}

export function commandSuggestions(input: string): readonly CommandSuggestion[] {
  if (!input.startsWith('/') || input.includes(' ')) return [];
  return commands
    .filter(({ command }) => command.startsWith(input.toLowerCase()))
    .map(({ command, description }) => ({ command, description }));
}

export function CommandHelper({ input, selected }: { readonly input: string; selected: number }) {
  const suggestions = commandSuggestions(input);
  const windowSize = 5;
  const start = Math.min(
    Math.max(0, selected - Math.floor(windowSize / 2)),
    Math.max(0, suggestions.length - windowSize),
  );
  const visible = suggestions.slice(start, start + windowSize);
  return (
    <Box borderStyle="single" borderColor="cyan" flexDirection="column" paddingX={1}>
      {visible.map((suggestion, index) => {
        const active = start + index === selected;
        return (
          <Box key={suggestion.command} columnGap={1}>
            <Text {...(active ? { color: 'cyan' as const } : {})} bold={active}>
              {active ? '›' : ' '} {suggestion.command}
            </Text>
            <Text dimColor>{suggestion.description}</Text>
          </Box>
        );
      })}
      <Text dimColor>↑↓ select · Tab complete · Enter run · Esc close</Text>
    </Box>
  );
}
