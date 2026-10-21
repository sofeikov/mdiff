# Markdown Rendered Diff

A VS Code extension that shows the diff of a Markdown file as rendered output.

When you click a Markdown file in the Source Control view, VS Code opens the source diff as usual. The extension also opens a second tab next to it with the two rendered versions side by side:

- The old version is on the left and the new version is on the right. Each block (paragraph, heading, list item, table, formula) is on the same row as its counterpart.
- Changed words are marked red on the left and green on the right.
- In a changed formula, only the changed parts are marked: for example one subscript, one added term or a renamed symbol. This works for inline formulas (`$…$`) and block formulas (`$$…$$`). When the two versions have too little in common, or the marked formula cannot render, the whole formula is marked. The `mdiff.formulaDiff` setting can mark the whole formula always.
- Tables are diffed row by row and cell by cell. An inserted or removed row has an empty placeholder on the other side.
- Each item of a top-level list is its own row.
- Code blocks are diffed line by line.
- YAML front matter (`title`, `subtitle`, `author`, `date`, `abstract`) shows as a title block and is diffed too. Other keys show in a small table.

## Install

```bash
npm install
npm run package
code --install-extension mdiff.vsix
```

## Use

- **Source Control view:** click a changed `.md` file. The rendered diff opens next to the source diff. The panel follows when you click another Markdown file.
- **Diff editor title bar:** the "Show Rendered Diff" button opens the panel for the active diff.
- **Explorer or editor tab context menu:** "Rendered Diff with HEAD" opens the source diff and the rendered diff of a file against `HEAD`.
- **Source Control context menu:** "Open Changes with Rendered Diff" works also when auto-open is off.

In the rendered diff:

| Key | Action |
|---|---|
| `n` or `j` | Next change |
| `p` or `k` | Previous change |
| `o` | Show only the changed blocks, or all blocks |

The panel updates when you edit the file.

## Settings

| Setting | Default | Description |
|---|---|---|
| `mdiff.autoOpen` | `true` | Open the rendered diff when a diff of a Markdown file opens. |
| `mdiff.formulaDiff` | `parts` | `parts`: mark only the changed parts of a formula. `whole`: mark the whole formula. |

## Development

| Command | Action |
|---|---|
| `npm run build` | Bundle the extension and the CLI into `dist/`. |
| `npm test` | Run the unit tests of the diff core. |
| `npm run test:integration` | Start VS Code with the extension and test it against a temporary Git repository. The test window runs on a hidden display, so `xvfb-run` must be installed (`sudo apt install xvfb`). Set `MDIFF_SHOW_WINDOW=1` to run it on your display instead. Set `VSCODE_BIN` to the VS Code (Electron) binary if it is not at `/snap/code/current/usr/share/code/code`. |
| `node dist/cli.js OLD.md NEW.md OUT.html` | Write the rendered diff of two files to an HTML page. |

The diff core is in `src/core/` and does not use the VS Code API:

- `markdown.ts`: the parser (markdown-it with the KaTeX plugin of the built-in preview) and the front matter.
- `blocks.ts`: splits a document into blocks.
- `diff.ts`: aligns the blocks of the two versions and renders the rows.
- `inline.ts`: the word diff inside a block. Code spans and images are single units. A removed formula and an added formula at the same place pair, and `formula.ts` diffs them.
- `formula.ts`: the diff inside a formula. It parses the LaTeX into a small tree, aligns the two trees and wraps each changed part in `\htmlClass`.
- `align.ts`: the sequence alignment that the block, word and formula diffs use.

## Limits

- Images with relative paths do not show.
- Mermaid diagrams and syntax highlighting of code blocks are not supported.
- A rewritten paragraph that has few words in common with the old one shows as a whole-block change.
