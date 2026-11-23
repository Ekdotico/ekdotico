// Which side of the selection the formatting toolbar stands on. Above, unless
// the space between the top of the text surface and the line the selection
// starts on cannot hold the toolbar and its gap: what lies over the surface
// (the hint, the image picker and its upload status) would then be covered.
// The decision is of measured space, never of "the first line", so a tall
// heading or a narrow phone (where the toolbar wraps to more rows) is judged
// by what it needs.
export function toolbarSide(roomAbove: number, toolbarHeight: number, gap: number): 'above' | 'below' {
  return roomAbove >= toolbarHeight + gap ? 'above' : 'below';
}
