import { stripVTControlCharacters } from 'node:util';

import { Box, Text } from 'ink';
import { marked, type Token, type Tokens } from 'marked';
import { Fragment, useMemo, type ReactNode } from 'react';

function clean(value: string): string {
  return stripVTControlCharacters(value);
}

function inline(tokens: readonly Token[]): ReactNode[] {
  return tokens.map((token, index) => {
    const key = `${token.type}-${String(index)}`;
    if (token.type === 'text') {
      const text = token as Tokens.Text;
      return (
        <Fragment key={key}>
          {text.tokens === undefined ? clean(text.text) : inline(text.tokens)}
        </Fragment>
      );
    }
    if (token.type === 'escape')
      return <Fragment key={key}>{clean((token as Tokens.Escape).text)}</Fragment>;
    if (token.type === 'strong') {
      const strong = token as Tokens.Strong;
      return (
        <Text key={key} bold>
          {inline(strong.tokens)}
        </Text>
      );
    }
    if (token.type === 'em') {
      const emphasis = token as Tokens.Em;
      return (
        <Text key={key} italic>
          {inline(emphasis.tokens)}
        </Text>
      );
    }
    if (token.type === 'del') {
      const deleted = token as Tokens.Del;
      return (
        <Text key={key} strikethrough>
          {inline(deleted.tokens)}
        </Text>
      );
    }
    if (token.type === 'codespan')
      return (
        <Text key={key} color="yellow">
          {clean((token as Tokens.Codespan).text)}
        </Text>
      );
    if (token.type === 'link') {
      const link = token as Tokens.Link;
      return (
        <Fragment key={key}>
          <Text color="blue" underline>
            {inline(link.tokens)}
          </Text>
          <Text dimColor> ({clean(link.href)})</Text>
        </Fragment>
      );
    }
    if (token.type === 'image') {
      const image = token as Tokens.Image;
      return (
        <Text key={key} dimColor>
          [image: {clean(image.text)}] ({clean(image.href)})
        </Text>
      );
    }
    if (token.type === 'br') return <Fragment key={key}>{'\n'}</Fragment>;
    if (token.type === 'html')
      return <Fragment key={key}>{clean((token as Tokens.HTML).text)}</Fragment>;
    if ('tokens' in token && Array.isArray(token.tokens))
      return <Fragment key={key}>{inline(token.tokens)}</Fragment>;
    return <Fragment key={key}>{clean(token.raw)}</Fragment>;
  });
}

function listItem(item: Tokens.ListItem, marker: string, key: string) {
  const children = item.tokens.flatMap((token) =>
    token.type === 'text' && token.tokens !== undefined ? token.tokens : [token],
  );
  return (
    <Box key={key} paddingLeft={1}>
      <Text color="cyan">{marker} </Text>
      <Text>{inline(children)}</Text>
    </Box>
  );
}

function blocks(tokens: readonly Token[]): ReactNode[] {
  return tokens.flatMap((token, index): ReactNode[] => {
    const key = `${token.type}-${String(index)}`;
    if (token.type === 'space') return [];
    if (token.type === 'heading') {
      const heading = token as Tokens.Heading;
      return [
        <Box key={key} marginTop={index === 0 ? 0 : 1}>
          <Text bold {...(heading.depth <= 2 ? { color: 'cyan' as const } : {})}>
            {inline(heading.tokens)}
          </Text>
        </Box>,
      ];
    }
    if (token.type === 'paragraph') {
      const paragraph = token as Tokens.Paragraph;
      return [
        <Box key={key} marginBottom={1}>
          <Text>{inline(paragraph.tokens)}</Text>
        </Box>,
      ];
    }
    if (token.type === 'code') {
      const code = token as Tokens.Code;
      return [
        <Box key={key} borderStyle="round" borderColor="gray" flexDirection="column" paddingX={1}>
          {code.lang !== undefined && <Text dimColor>{clean(code.lang)}</Text>}
          <Text color="green">{clean(code.text)}</Text>
        </Box>,
      ];
    }
    if (token.type === 'blockquote') {
      const quote = token as Tokens.Blockquote;
      return [
        <Box
          key={key}
          borderStyle="single"
          borderTop={false}
          borderRight={false}
          borderBottom={false}
          borderColor="gray"
          paddingLeft={1}
          flexDirection="column"
        >
          {blocks(quote.tokens)}
        </Box>,
      ];
    }
    if (token.type === 'list') {
      const list = token as Tokens.List;
      const start = typeof list.start === 'number' ? list.start : 1;
      return list.items.map((item, itemIndex) =>
        listItem(
          item,
          list.ordered ? `${String(start + itemIndex)}.` : '•',
          `${key}-${String(itemIndex)}`,
        ),
      );
    }
    if (token.type === 'hr')
      return [
        <Text key={key} dimColor>
          {'─'.repeat(24)}
        </Text>,
      ];
    if (token.type === 'table') {
      const table = token as Tokens.Table;
      const rows = [table.header, ...table.rows];
      return rows.map((row, rowIndex) => (
        <Text key={`${key}-${String(rowIndex)}`} bold={rowIndex === 0}>
          {row.flatMap((cell, cellIndex) => [
            ...(cellIndex === 0 ? [] : [' │ ']),
            ...inline(cell.tokens),
          ])}
        </Text>
      ));
    }
    if (token.type === 'html') return [<Text key={key}>{clean((token as Tokens.HTML).text)}</Text>];
    if ('tokens' in token && Array.isArray(token.tokens)) return blocks(token.tokens);
    return [<Text key={key}>{clean(token.raw)}</Text>];
  });
}

export function Markdown({ children }: { readonly children: string }) {
  const content = useMemo(() => {
    try {
      return blocks(marked.lexer(children, { gfm: true, breaks: true }));
    } catch {
      return [<Text key="fallback">{clean(children)}</Text>];
    }
  }, [children]);
  return <Box flexDirection="column">{content}</Box>;
}
