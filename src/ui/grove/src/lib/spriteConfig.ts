import type { RoleKey, SpriteAnimRef, SpriteSet } from "./sprites";
import { DEFAULT_SPRITE_SETS } from "./sprites";

export type ActionName = string;

export type SpriteActionOverrides = Partial<
  Pick<SpriteSet, "idleFacingBase" | "walkBase" | "walkFrames" | "idleFrameMs" | "walkFrameMs">
> & {
  idleFacingFrames?: number;
  idleAnim?: SpriteAnimRef;
  idleAnims?: SpriteAnimRef[];
};

export type SpriteActionsConfig = {
  version: number;
  roles?: Partial<Record<RoleKey, Record<ActionName, SpriteActionOverrides>>>;
};

type ResolvedConfig = {
  roles: Record<RoleKey, Record<ActionName, SpriteSet>>;
};

let cached: { assetBase: string; config: ResolvedConfig } | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeAssetBase(assetBase: string): string {
  if (!assetBase) return "/grove";
  return assetBase.endsWith("/") ? assetBase.slice(0, -1) : assetBase;
}

function mergeSet(base: SpriteSet, overrides: SpriteActionOverrides | undefined): SpriteSet {
  if (!overrides) return base;

  const merged: SpriteSet = {
    ...base,
    ...overrides,
  };

  if (overrides.idleAnim) {
    merged.idleAnims = [overrides.idleAnim];
  } else if (overrides.idleAnims) {
    merged.idleAnims = overrides.idleAnims;
  }

  return merged;
}

export async function loadSpriteActionsConfig(assetBase: string): Promise<ResolvedConfig> {
  const normalized = normalizeAssetBase(assetBase);
  if (cached?.assetBase === normalized) return cached.config;

  const defaults: ResolvedConfig = {
    roles: {
      bloom: { default: DEFAULT_SPRITE_SETS.bloom },
      worker: { default: DEFAULT_SPRITE_SETS.worker },
      planner: { default: DEFAULT_SPRITE_SETS.planner },
      auditor: { default: DEFAULT_SPRITE_SETS.auditor },
    },
  };

  const url = `${normalized}/sprite-actions.json`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      cached = { assetBase: normalized, config: defaults };
      return defaults;
    }

    const parsed = (await res.json()) as SpriteActionsConfig;
    const roles = isRecord(parsed?.roles) ? parsed.roles : {};

    const resolved: ResolvedConfig = {
      roles: {
        bloom: { default: DEFAULT_SPRITE_SETS.bloom },
        worker: { default: DEFAULT_SPRITE_SETS.worker },
        planner: { default: DEFAULT_SPRITE_SETS.planner },
        auditor: { default: DEFAULT_SPRITE_SETS.auditor },
      },
    };

    for (const roleKey of Object.keys(resolved.roles) as RoleKey[]) {
      const roleOverrides = isRecord((roles as Record<string, unknown>)[roleKey])
        ? ((roles as Record<string, unknown>)[roleKey] as Record<string, unknown>)
        : {};
      const defaultOverrides = isRecord(roleOverrides.default)
        ? (roleOverrides.default as SpriteActionOverrides)
        : undefined;
      const roleDefault = mergeSet(DEFAULT_SPRITE_SETS[roleKey], defaultOverrides);
      resolved.roles[roleKey].default = roleDefault;

      for (const [action, overrides] of Object.entries(roleOverrides)) {
        if (action === "default") continue;
        const actionOverrides = isRecord(overrides)
          ? (overrides as SpriteActionOverrides)
          : undefined;
        resolved.roles[roleKey][action] = mergeSet(roleDefault, actionOverrides);
      }
    }

    cached = { assetBase: normalized, config: resolved };
    return resolved;
  } catch {
    cached = { assetBase: normalized, config: defaults };
    return defaults;
  }
}

export function getSpriteSetForAction(
  cfg: ResolvedConfig,
  role: RoleKey,
  action: ActionName | undefined,
): SpriteSet {
  const roleCfg = cfg.roles[role] ?? cfg.roles.worker;
  if (!action) return roleCfg.default;
  return roleCfg[action] ?? roleCfg.default;
}
