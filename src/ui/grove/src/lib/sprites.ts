import { Direction8 } from "./geometry";

export const DIRECTIONS: Direction8[] = [
  "south",
  "south-east",
  "east",
  "north-east",
  "north",
  "north-west",
  "west",
  "south-west",
];

export type RoleKey = "bloom" | "worker" | "planner" | "auditor";

export interface SpriteAnimRef {
  base: string; // path relative to assetBase (no leading slash), e.g. "characters/Worker/animations/breathing-idle"
  frames: number;
  dir?: string; // defaults to "south"
}

export interface SpriteSet {
  idleFacingBase: string; // e.g. "characters/Worker/rotations"
  walkBase: string;       // e.g. "characters/Worker/animations/walking-8-frames"
  walkFrames: number;     // frames per direction
  idleAnims?: SpriteAnimRef[];
  walkFrameMs?: number;
  idleFrameMs?: number;
}

export const DEFAULT_WALK_FRAME_MS = 110;
export const DEFAULT_IDLE_FRAME_MS = 140;

export function makeFacing(assetBase: string, base: string): Record<Direction8, string> {
  const prefix = assetBase.replace(/\/$/, "");
  return DIRECTIONS.reduce((acc, dir) => {
    acc[dir] = `${prefix}/${base}/${dir}.png`;
    return acc;
  }, {} as Record<Direction8, string>);
}

export function makeWalk(
  assetBase: string,
  base: string,
  frames = 8,
): Record<Direction8, string[]> {
  const prefix = assetBase.replace(/\/$/, "");
  return DIRECTIONS.reduce((acc, dir) => {
    acc[dir] = Array.from({ length: frames }).map(
      (_, idx) => `${prefix}/${base}/${dir}/frame_${String(idx).padStart(3, "0")}.png`,
    );
    return acc;
  }, {} as Record<Direction8, string[]>);
}

export function makeAnim(assetBase: string, anim: SpriteAnimRef): string[] {
  const prefix = assetBase.replace(/\/$/, "");
  const dir = anim.dir ?? "south";
  return Array.from({ length: anim.frames }).map(
    (_, idx) => `${prefix}/${anim.base}/${dir}/frame_${String(idx).padStart(3, "0")}.png`,
  );
}

const BLOOM_BASE = "characters/bloommind";
const PLANNER_BASE = "characters/planner";
const WORKER_BASE = "characters/Worker";
const AUDITOR_BASE = "characters/auditor";

export const DEFAULT_SPRITE_SETS: Record<RoleKey, SpriteSet> = {
  bloom: {
    idleFacingBase: `${BLOOM_BASE}/rotations`,
    walkBase: `${BLOOM_BASE}/animations/walking-8-frames`,
    walkFrames: 8,
    idleAnims: [
      { base: `${BLOOM_BASE}/animations/custom-Finger guns + wink`, frames: 16 },
      { base: `${BLOOM_BASE}/animations/custom-Spore bubble gum (blows a spore bubble, it pops in`, frames: 16 },
      { base: `${BLOOM_BASE}/animations/custom-Character does an energetic praise moment: quick b`, frames: 16 },
      { base: `${BLOOM_BASE}/animations/custom-Summons a tiny cupcake. admires it, it vanishes`, frames: 16 },
      { base: `${BLOOM_BASE}/animations/custom-Tiny mushrooms applaud (little side mushrooms`, frames: 16, dir: "tend/south" },
      { base: `${BLOOM_BASE}/animations/drinking`, frames: 6 },
      { base: `${BLOOM_BASE}/animations/picking-up`, frames: 5 },
    ],
    walkFrameMs: 110,
    idleFrameMs: 140,
  },
  worker: {
    idleFacingBase: `${WORKER_BASE}/rotations`,
    walkBase: `${WORKER_BASE}/animations/walking-8-frames`,
    walkFrames: 8,
    idleAnims: [{ base: `${WORKER_BASE}/animations/breathing-idle`, frames: 4 }],
    walkFrameMs: 110,
    idleFrameMs: 140,
  },
  planner: {
    idleFacingBase: `${PLANNER_BASE}/rotations`,
    walkBase: `${PLANNER_BASE}/animations/walking-8-frames`,
    walkFrames: 8,
    walkFrameMs: 110,
    idleFrameMs: 140,
  },
  auditor: {
    idleFacingBase: `${AUDITOR_BASE}/rotations`,
    walkBase: `${AUDITOR_BASE}/animations/walking-8-frames`,
    walkFrames: 8,
    walkFrameMs: 110,
    idleFrameMs: 140,
  },
};
