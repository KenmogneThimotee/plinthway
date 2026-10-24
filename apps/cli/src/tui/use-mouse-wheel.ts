import { useEffect, useRef } from 'react';
import { useStdin, useStdout } from 'ink';

export type MouseWheelDirection = 'up' | 'down';

const ENABLE_MOUSE = '\u001B[?1000h\u001B[?1006h';
const DISABLE_MOUSE = '\u001B[?1006l\u001B[?1000l';
// SGR mouse reports are CSI control sequences emitted directly by the terminal.
// eslint-disable-next-line no-control-regex
const SGR_MOUSE = /\u001B\[<(\d+);\d+;\d+[Mm]/gu;

export function useMouseWheel(
  onWheel: (direction: MouseWheelDirection) => void,
  enabled: boolean,
): void {
  const { stdin, isRawModeSupported } = useStdin();
  const { stdout } = useStdout();
  const onWheelRef = useRef(onWheel);
  onWheelRef.current = onWheel;

  useEffect(() => {
    if (!enabled || !isRawModeSupported) return;

    let pending = '';
    const handleData = (chunk: unknown): void => {
      pending += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      SGR_MOUSE.lastIndex = 0;
      let consumed = 0;
      for (let match = SGR_MOUSE.exec(pending); match !== null; match = SGR_MOUSE.exec(pending)) {
        consumed = match.index + match[0].length;
        const button = Number(match[1]);
        if ((button & 64) === 0 || (button & 128) !== 0) continue;
        onWheelRef.current((button & 1) === 0 ? 'up' : 'down');
      }

      const remainder = pending.slice(consumed);
      const incompleteStart = remainder.lastIndexOf('\u001B[<');
      pending = incompleteStart < 0 ? '' : remainder.slice(incompleteStart, incompleteStart + 64);
    };

    stdout.write(ENABLE_MOUSE);
    stdin.on('data', handleData);
    return () => {
      stdin.off('data', handleData);
      stdout.write(DISABLE_MOUSE);
    };
  }, [enabled, isRawModeSupported, stdin, stdout]);
}
