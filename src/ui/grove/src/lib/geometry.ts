import { CLEARING_BOUNDS, OFFSCREEN_MARGIN } from "./constants";

export type Point = { x: number; y: number };
export type Direction8 =
  | "north"
  | "north-east"
  | "east"
  | "south-east"
  | "south"
  | "south-west"
  | "west"
  | "north-west";

export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

export function randInt(min: number, max: number): number {
  return Math.floor(rand(min, max + 1));
}

export function randomPointInBounds(): Point {
  const x = rand(CLEARING_BOUNDS.left, CLEARING_BOUNDS.right);
  const y = rand(CLEARING_BOUNDS.top, CLEARING_BOUNDS.bottom);
  return { x, y };
}

export type Edge = "left" | "right" | "top" | "bottom";

export function randomEdgeSpawn(): { point: Point; edge: Edge } {
  const edges: Edge[] = ["left", "right", "top", "bottom"];
  const edge = edges[randInt(0, edges.length - 1)];

  switch (edge) {
    case "left":
      return {
        edge,
        point: {
          x: CLEARING_BOUNDS.left - OFFSCREEN_MARGIN,
          y: rand(CLEARING_BOUNDS.top, CLEARING_BOUNDS.bottom),
        },
      };
    case "right":
      return {
        edge,
        point: {
          x: CLEARING_BOUNDS.right + OFFSCREEN_MARGIN,
          y: rand(CLEARING_BOUNDS.top, CLEARING_BOUNDS.bottom),
        },
      };
    case "top":
      return {
        edge,
        point: {
          x: rand(CLEARING_BOUNDS.left, CLEARING_BOUNDS.right),
          y: CLEARING_BOUNDS.top - OFFSCREEN_MARGIN,
        },
      };
    case "bottom":
    default:
      return {
        edge: "bottom",
        point: {
          x: rand(CLEARING_BOUNDS.left, CLEARING_BOUNDS.right),
          y: CLEARING_BOUNDS.bottom + OFFSCREEN_MARGIN,
        },
      };
  }
}

export function nearestExitPoint(current: Point): Point {
  const leftDist = Math.abs(current.x - CLEARING_BOUNDS.left);
  const rightDist = Math.abs(CLEARING_BOUNDS.right - current.x);
  const topDist = Math.abs(current.y - CLEARING_BOUNDS.top);
  const bottomDist = Math.abs(CLEARING_BOUNDS.bottom - current.y);

  const min = Math.min(leftDist, rightDist, topDist, bottomDist);

  if (min === leftDist) {
    return { x: CLEARING_BOUNDS.left - OFFSCREEN_MARGIN, y: current.y };
  }
  if (min === rightDist) {
    return { x: CLEARING_BOUNDS.right + OFFSCREEN_MARGIN, y: current.y };
  }
  if (min === topDist) {
    return { x: current.x, y: CLEARING_BOUNDS.top - OFFSCREEN_MARGIN };
  }
  return { x: current.x, y: CLEARING_BOUNDS.bottom + OFFSCREEN_MARGIN };
}

export function isOffscreen(p: Point): boolean {
  return (
    p.x < -OFFSCREEN_MARGIN ||
    p.x > 100 + OFFSCREEN_MARGIN ||
    p.y < -OFFSCREEN_MARGIN ||
    p.y > 100 + OFFSCREEN_MARGIN
  );
}

export function directionFromPoints(from: Point, to: Point): Direction8 {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) {
    return "south";
  }

  // Snap to cardinals (east/west/north/south) to avoid diagonal mis-facing.
  // Screen y increases downward.
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? "east" : "west";
  }
  return dy >= 0 ? "south" : "north";
}
