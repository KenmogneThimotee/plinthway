import { Box, Text, useBoxMetrics, type DOMElement } from 'ink';
import { useEffect, useRef, useState } from 'react';

import type { ConversationTone, TuiConversationItem } from '../reducer.js';
import { Markdown } from './markdown.js';

export type ConversationScrollAction = 'page-up' | 'page-down' | 'end';

export interface ConversationScrollRequest {
  readonly id: number;
  readonly action: ConversationScrollAction;
}

export function nextScrollTop(input: {
  readonly current: number;
  readonly maximum: number;
  readonly pageSize: number;
  readonly action: ConversationScrollAction;
}): number {
  if (input.action === 'end') return input.maximum;
  const delta = Math.max(1, input.pageSize);
  return Math.max(
    0,
    Math.min(input.maximum, input.current + (input.action === 'page-up' ? -delta : delta)),
  );
}

function colorFor(tone: ConversationTone): 'gray' | 'green' | 'yellow' | 'red' | undefined {
  if (tone === 'muted') return 'gray';
  if (tone === 'success') return 'green';
  if (tone === 'warning') return 'yellow';
  if (tone === 'error') return 'red';
  return undefined;
}

function label(item: TuiConversationItem): string {
  if (item.kind === 'user') return 'you';
  if (item.kind === 'assistant') return 'agent';
  if (item.kind === 'tool') return 'tool';
  if (item.kind === 'error') return 'error';
  return 'system';
}

function ConversationLine({ item }: { readonly item: TuiConversationItem }) {
  const labelColor =
    item.kind === 'user' ? 'blue' : item.kind === 'assistant' ? 'cyan' : colorFor(item.tone);
  const textColor = colorFor(item.tone);
  return (
    <Box>
      <Text bold {...(labelColor === undefined ? {} : { color: labelColor })}>
        {label(item)}:{' '}
      </Text>
      {item.kind === 'assistant' ? (
        <Markdown>{item.text}</Markdown>
      ) : (
        <Text {...(textColor === undefined ? {} : { color: textColor })}>{item.text}</Text>
      )}
    </Box>
  );
}

const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

function LoadingIndicator() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((current) => (current + 1) % spinnerFrames.length);
    }, 80);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return (
    <Box>
      <Text bold color="cyan">
        agent:{' '}
      </Text>
      <Text color="yellow">thinking… {spinnerFrames[frame]}</Text>
    </Box>
  );
}

export function Conversation({
  items,
  height,
  loading = false,
  scrollRequest,
}: {
  readonly items: readonly TuiConversationItem[];
  readonly height?: number;
  readonly loading?: boolean;
  readonly scrollRequest?: ConversationScrollRequest;
}) {
  const viewportRef = useRef<DOMElement>(null);
  const contentRef = useRef<DOMElement>(null);
  const viewport = useBoxMetrics(viewportRef);
  const content = useBoxMetrics(contentRef);
  const [requestedScrollTop, setRequestedScrollTop] = useState<number>();
  const maximum = Math.max(0, content.height - viewport.clientHeight);
  const scrollTop = Math.min(requestedScrollTop ?? maximum, maximum);
  const following = requestedScrollTop === undefined || scrollTop >= maximum;

  useEffect(() => {
    if (scrollRequest === undefined) return;
    const next = nextScrollTop({
      current: scrollTop,
      maximum,
      pageSize: Math.max(1, viewport.clientHeight - 1),
      action: scrollRequest.action,
    });
    setRequestedScrollTop(next >= maximum ? undefined : next);
  }, [scrollRequest?.id]);

  return (
    <Box
      flexDirection="column"
      flexGrow={height === undefined ? 1 : 0}
      {...(height === undefined ? {} : { height })}
    >
      <Box
        ref={viewportRef}
        flexDirection="column"
        flexGrow={1}
        overflow="hidden"
        contentOffsetY={scrollTop}
      >
        <Box ref={contentRef} flexDirection="column" flexShrink={0} paddingX={1}>
          {items.length === 0 && !loading ? (
            <Text dimColor>Start a conversation, or type /help.</Text>
          ) : (
            items.map((item) => <ConversationLine key={item.id} item={item} />)
          )}
          {loading && <LoadingIndicator />}
        </Box>
      </Box>
      {!following && (
        <Text dimColor>
          history {String(scrollTop + 1)}/{String(maximum + 1)} · PageUp/PageDown · End live
        </Text>
      )}
    </Box>
  );
}
