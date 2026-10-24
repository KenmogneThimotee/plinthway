export interface TuiKeymap {
  readonly commandPalette: string;
  readonly submit: string;
  readonly newline: string;
  readonly close: string;
  readonly cancel: string;
  readonly complete: string;
}

export type KeyAction =
  | 'submit'
  | 'newline'
  | 'close'
  | 'cancel'
  | 'palette'
  | 'complete'
  | 'scroll-up'
  | 'scroll-down'
  | 'scroll-end';

export interface KeyInput {
  readonly name?: string;
  readonly return?: boolean;
  readonly escape?: boolean;
  readonly tab?: boolean;
  readonly ctrl?: boolean;
  readonly shift?: boolean;
  readonly meta?: boolean;
  readonly pageUp?: boolean;
  readonly pageDown?: boolean;
  readonly end?: boolean;
}

export const defaultKeymap: TuiKeymap = {
  commandPalette: 'ctrl+p',
  submit: 'enter',
  newline: 'shift+enter',
  close: 'escape',
  cancel: 'ctrl+c',
  complete: 'tab',
};

function keyName(input: KeyInput): string | undefined {
  let name: string | undefined;
  if (input.pageUp === true) name = 'pageup';
  else if (input.pageDown === true) name = 'pagedown';
  else if (input.end === true) name = 'end';
  else if (input.return === true) name = 'enter';
  else if (input.escape === true) name = 'escape';
  else if (input.tab === true) name = 'tab';
  else name = input.name?.toLowerCase();
  if (name === undefined) return undefined;

  const modifiers: string[] = [];
  if (input.ctrl === true) modifiers.push('ctrl');
  if (input.shift === true) modifiers.push('shift');
  if (input.meta === true) modifiers.push('alt');
  return [...modifiers, name].join('+');
}

export function resolveKeyAction(
  input: KeyInput,
  keymap: TuiKeymap = defaultKeymap,
): KeyAction | undefined {
  const key = keyName(input);
  if (key === undefined) return undefined;
  const mappings: readonly [string, KeyAction][] = [
    ['pageup', 'scroll-up'],
    ['pagedown', 'scroll-down'],
    ['end', 'scroll-end'],
    [keymap.newline, 'newline'],
    [keymap.submit, 'submit'],
    [keymap.close, 'close'],
    [keymap.cancel, 'cancel'],
    [keymap.commandPalette, 'palette'],
    [keymap.complete, 'complete'],
  ];
  return mappings.find(([configured]) => configured.toLowerCase() === key)?.[1];
}
