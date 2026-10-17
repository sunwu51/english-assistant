function cells(line) {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  const values = [];
  let value = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && (text[i + 1] === '\\' || text[i + 1] === '|')) {
      value += text[i + 1] === '|' ? '|' : '\\\\'; i++;
    } else if (text[i] === '|') { values.push(value.trim()); value = ''; }
    else value += text[i];
  }
  values.push(value.trim());
  return values;
}

export function parseMarkdownTable(text) {
  const lines = text.trimEnd().split(/\r?\n/);
  if (lines.length < 2) return null;
  const header = cells(lines[0]), rules = cells(lines[1]);
  if (header.length < 2 || rules.length !== header.length || !rules.every(rule => /^:?-{3,}:?$/.test(rule))) return null;
  const rows = lines.slice(2).map(cells);
  if (rows.some(row => row.length !== header.length)) return null;
  return { header, rows };
}

// These widths only apportion space. Ink wraps and paints each cell inside its
// own Box, so combining marks or emoji cannot push a border outside the pane.
function textWidth(text) {
  let width = 0;
  for (const char of text) {
    if (/[\p{Mark}\u200d\ufe0e\ufe0f]/u.test(char)) continue;
    const code = char.codePointAt(0);
    width += /\p{Extended_Pictographic}/u.test(char) || code >= 0x1100 && (
      code <= 0x115f || code >= 0x2e80 && code <= 0xa4cf || code >= 0xac00 && code <= 0xd7a3 ||
      code >= 0xf900 && code <= 0xfaff || code >= 0xfe10 && code <= 0xfe6f ||
      code >= 0xff01 && code <= 0xff60 || code >= 0xffe0 && code <= 0xffe6 || code >= 0x20000
    ) ? 2 : 1;
  }
  return width;
}

export function renderTerminalTable(table, columns, { Box, Text, Markdown }) {
  const count = table.header.length;
  const available = Math.floor(columns) - 4 - (count - 1) * 2;
  if (available < count * 3) {
    // A very narrow pane cannot accommodate borders and even minimal cells.
    return Box({ flexDirection: 'column', width: columns, children: table.rows.flatMap(row => row.flatMap((value, i) => [
      Text({ bold: true, children: [table.header[i]] }), Markdown({ text: value || ' ' }),
    ])) });
  }
  const desired = table.header.map((title, i) => Math.max(3, textWidth(title), ...table.rows.map(row => textWidth(row[i]))));
  const total = desired.reduce((a, b) => a + b, 0);
  let widths = desired;
  if (total > available) {
    const remaining = available - count * 3, weight = total - count * 3;
    widths = desired.map(size => 3 + Math.floor((size - 3) * remaining / weight));
    let spare = available - widths.reduce((a, b) => a + b, 0);
    for (let i = 0; spare > 0; i = (i + 1) % count) if (widths[i] < desired[i]) { widths[i]++; spare--; }
  }
  const rowWidth = widths.reduce((a, b) => a + b, 0) + (count - 1) * 2;
  const rows = [table.header, ...table.rows];
  return Box({ flexDirection: 'column', width: rowWidth + 4, flexShrink: 0, borderStyle: 'single', paddingX: 1, children: rows.flatMap((row, index) => [
    Box({ flexDirection: 'row', alignItems: 'stretch', width: rowWidth, columnGap: 2,
      children: row.map((value, i) => Box({ flexDirection: 'column', flexShrink: 0, width: widths[i],
        children: [index === 0 ? Text({ bold: true, children: [value] }) : Markdown({ text: value || ' ' })],
      })),
    }),
    ...(index < rows.length - 1 ? [Text({ dimColor: true, children: ['─'.repeat(rowWidth)] })] : []),
  ]),
  });
}
