// The Markdown input of the editor (FR-ED-14): the thirteen rows of the
// requirement, each as the text that stands before the cursor in a block when
// its last key is pressed, and nothing else. The library's own set is not this
// list (it also reads `+`, any number before a full stop, `___`, `***`,
// `~~~`, a language after the fence, `__`, `_` and `==`), so its rules stay
// off and these are the only ones (../../app/(app)/documents/[id]/input-rules.ts).
//
// A rule reads text and writes a node or a mark of fixed attributes: nothing a
// person types reaches an attribute, apart from the count of `#`, which is
// one, two or three by the pattern itself (NFR-SE-06, A03).

// "The spacebar": the character it types, and the one some keyboards put in its place.
const SPACE = '[ \\u00a0]';
// "The Enter key": the editor hands a rule the key as a line feed.
const ENTER = '\\n';

export const MARKDOWN = {
  /** `#`, `##`, `###` + Space, at the start of a block. The level is the count. */
  heading: new RegExp(`^(#{1,3})${SPACE}$`),
  /** `-` or `*` + Space, at the start of a block. */
  bulletList: new RegExp(`^[-*]${SPACE}$`),
  /** `1.` + Space, at the start of a block: that number and no other. */
  orderedList: new RegExp(`^1\\.${SPACE}$`),
  /** `>` + Space, at the start of a block. */
  blockquote: new RegExp(`^>${SPACE}$`),
  /** `---` + Enter, the whole of the block before the cursor. */
  horizontalRule: new RegExp(`^---${ENTER}$`),
  /** Three backticks + Enter, the whole of the block before the cursor. */
  codeBlock: new RegExp(`^\`\`\`${ENTER}$`),
  // The four marks, "on closing": the closing sign is the last thing typed,
  // and the text between the signs holds none of them. A single sign does not
  // open where another stands before it, so `**text*` waits for its last `*`.
  bold: /\*\*([^*]+)\*\*$/,
  italic: /(?<!\*)\*([^*]+)\*$/,
  strike: /~~([^~]+)~~$/,
  code: /(?<!`)`([^`]+)`$/,
} as const;
