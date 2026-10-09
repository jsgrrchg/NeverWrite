# Math in Markdown live preview

Live preview renders mathematical LaTeX with the bundled KaTeX renderer. It works
offline and preserves the original Markdown when editing, saving, or switching
to source mode. No TeX installation is required.

## Syntax

Inline formulas use single dollars:

```markdown
The relation $E=mc^2$ and the fraction $\frac{a}{b}$.
```

Display formulas use double dollars, either on a single line or with opening and
closing delimiters on their own lines:

```markdown
$$E=mc^2$$

$$
\begin{pmatrix}
1 & 2 \\
3 & 4
\end{pmatrix}
$$
```

A standalone display formula is centered. An embedded `$$x$$` in a paragraph
uses display-style notation within the line. Wide formulas scroll horizontally;
pressing a formula's scrollbar scrolls it without revealing the source.

Multiline delimiters must sit on their own lines, indented at most three
spaces. Multiline display math inside blockquotes and callouts, after a list
marker, or indented four or more spaces stays literal; a single-line `$$x$$`
still renders in those places.

Inline formulas cannot span lines. The opening dollar must be followed by a
non-whitespace character; the closing dollar must follow a non-whitespace
character and cannot be immediately followed by a digit. An invalid closing
candidate terminates that match rather than consuming later formulas. This
keeps common prices such as `$20 and $30` literal. Dollar notation is inherently
ambiguous: use `\$` for a literal dollar, especially when writing paired dollar
signs such as `\$5\$`. Numeric formulas such as `$2+2$` are supported.

Unmatched delimiters and runs of three or more dollars remain literal. Math is
excluded from frontmatter, code spans and blocks, raw HTML, images, link
destinations/titles/reference definitions, wikilinks and embeds, and tables. Table math and the
alternative delimiters `\(...\)` and `\[...\]` are outside the initial scope.

## Editing and errors

Click a rendered formula or move the caret into its source range to reveal its
LaTeX, including delimiters. Moving the selection outside restores the rendered
formula. Any selection touching a formula reveals it, including secondary
cursors. Undo and redo operate on the Markdown source.

Invalid or unsupported commands display their source with an error color and a
hover explanation. Click to correct the source. Errors in one formula do not
prevent other formulas or the document from rendering.

KaTeX supports common fractions, roots, integrals, sums, matrices, and aligned
expressions. It is not a full LaTeX document compiler and cannot load arbitrary
packages. Consult [KaTeX's supported functions](https://katex.org/docs/supported).
Macros are local to each rendered formula. Rendering uses HTML plus MathML,
untrusted input mode, a 1,000-expansion limit and a maximum explicit size of 20em.

## Implementation and validation

`mathRanges.ts` collects math ranges outside excluded Markdown syntax nodes and
shares them through a CodeMirror state field. Background parsing refreshes the
ranges as more syntax becomes available. Selection changes reuse the parsed
ranges; notes without dollars skip the syntax walk entirely. Markdown inside a
formula is not styled, while syntax containing a whole formula, such as a
paragraph, list item or highlight, still renders around it. Inline widgets are built for the viewport; display blocks use a state
field because they change document layout. Unchanged widgets retain their DOM
when positions move. Rendering never rewrites document text.

From `apps/desktop`:

```sh
npx vitest run --maxWorkers=2 src/features/editor/extensions/mathRanges.test.ts src/features/editor/extensions/mathLivePreview.test.ts src/features/editor/extensions/livePreviewInline.test.ts src/features/editor/extensions/livePreviewBlocks.test.ts src/features/editor/extensions/livePreview.test.ts
npx playwright test --config e2e/playwright.config.ts e2e/tests/mathLivePreview.spec.ts
npm run build
```

The browser suite uses the production React editor with an in-memory vault. It
covers formula editing, tab restoration, source/preview switching, narrow layouts,
light/dark themes and scrolling through long notes. Native Electron packaging
and assistive-technology behavior still require a desktop smoke test.
