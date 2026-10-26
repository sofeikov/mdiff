export interface ShellOptions {
  /** The value for the CSP `*-src` directives, for example the webview's `cspSource`. */
  cspSource: string;
  nonce: string;
  katexCss: string;
  previewCss: string;
  previewJs: string;
  /** Data to show at once, for the standalone page. The webview sends it in a message instead. */
  initial?: UpdateMessage;
}

export interface UpdateMessage {
  type: 'update';
  title: string;
  labelA: string;
  labelB: string;
  html: string;
  hunks: number;
  added: number;
  removed: number;
  changed: number;
  /** The rows that `html` joins, one element each. */
  rows?: string[];
  /** True when a different file is shown, so the view scrolls to the top. */
  reset: boolean;
  error?: string;
}

/**
 * What the extension posts to the webview for an update: the rows, each as HTML or as the
 * index of an equal row in the rows that the webview shows already. On a live update most rows
 * are equal, so the webview keeps their elements and only parses the changed rows.
 */
export interface RowsMessage extends Omit<UpdateMessage, 'html' | 'rows'> {
  rows: (string | number)[];
  /** The number of this set of rows. */
  seq: number;
  /** The `seq` of the rows that the indexes refer to. Absent when every row is HTML. */
  base?: number;
}

/**
 * Turns an update into the message for the webview. A row that the webview shows already is
 * sent as its index there, not as its HTML.
 */
export function toRowsMessage(message: UpdateMessage, shown: { seq: number; rows: string[] } | undefined, seq: number): RowsMessage {
  const { html: _html, rows = [], ...rest } = message;
  if (!shown || message.reset || message.error) return { ...rest, rows, seq };
  // The indexes of each row text in the shown rows, in order, so that equal rows map one to one.
  const where = new Map<string, number[]>();
  shown.rows.forEach((row, i) => {
    const list = where.get(row);
    if (list) list.push(i);
    else where.set(row, [i]);
  });
  const patch = rows.map((row) => where.get(row)?.shift() ?? row);
  return { ...rest, rows: patch, seq, base: shown.seq };
}

/** The HTML page that shows the side-by-side rendered diff. */
export function buildShell(o: ShellOptions): string {
  const initial = o.initial ? `<script nonce="${o.nonce}">window.__MDIFF_INITIAL__ = ${JSON.stringify(o.initial).replace(/</g, '\\u003c')};</script>` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${o.cspSource} https: data:; style-src ${o.cspSource} 'unsafe-inline'; font-src ${o.cspSource} data:; script-src 'nonce-${o.nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Rendered diff</title>
<link rel="stylesheet" href="${o.katexCss}">
<link rel="stylesheet" href="${o.previewCss}">
</head>
<body>
<header class="bar">
  <span class="file" id="title"></span>
  <span class="stats" id="stats"></span>
  <span class="tools">
    <button id="prev" title="Previous change (p)">&#x2191;</button>
    <span id="pos"></span>
    <button id="next" title="Next change (n)">&#x2193;</button>
    <label title="Show only the changed blocks (o)"><input type="checkbox" id="only"> Only changes</label>
  </span>
</header>
<div class="labels"><div class="cell a" id="label-a"></div><div class="cell b" id="label-b"></div></div>
<main id="content"></main>
${initial}
<script nonce="${o.nonce}" src="${o.previewJs}"></script>
</body>
</html>`;
}
