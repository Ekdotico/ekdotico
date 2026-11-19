// Whether a pointer is near a box: within `reach` pixels of its nearest edge, and so also anywhere inside
// it. The Insert control appears by this (./insert-button.tsx).
export interface Point {
  x: number;
  y: number;
}

export interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** How near the pointer comes to the Insert control before it appears, in CSS pixels. */
export const REACH = 64;

export function isNear(point: Point, box: Box, reach = REACH): boolean {
  const dx = Math.max(box.left - point.x, 0, point.x - box.right);
  const dy = Math.max(box.top - point.y, 0, point.y - box.bottom);
  return Math.hypot(dx, dy) <= reach;
}
