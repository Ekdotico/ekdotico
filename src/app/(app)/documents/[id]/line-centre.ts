// The vertical middle of the line a caret stands on, by the line box and not by the glyphs: the caret's
// own rectangle is the text's font box, whose middle sits a little above the middle of a line that has
// leading (2 px at 17 px on a 28 px line). Lines of a block are `lineHeight` apart from the top of its
// content box; with no numeric line height (`normal`) the caret's own middle is the best there is.
export function lineCentre(
  caretTop: number,
  caretBottom: number,
  contentTop: number,
  lineHeight: number,
): number {
  const middle = (caretTop + caretBottom) / 2;
  if (!Number.isFinite(lineHeight) || lineHeight <= 0) return middle;
  const line = Math.max(0, Math.floor((middle - contentTop) / lineHeight));
  return contentTop + (line + 0.5) * lineHeight;
}
