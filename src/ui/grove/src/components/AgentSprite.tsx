import React, { useEffect, useMemo, useState } from "react";
import { MOVE_TRANSITION_MS } from "../lib/constants";
import { DEFAULT_IDLE_FRAME_MS, DEFAULT_WALK_FRAME_MS, makeAnim, makeFacing, makeWalk } from "../lib/sprites";
import { getSpriteSetForAction } from "../lib/spriteConfig";
import { useGroveRuntimeStore } from "../store/runtimeStore";
import type { Agent } from "../store/groveStore";
import { getRoleLabel } from "../store/groveStore";

export default function AgentSprite({ agent }: { agent: Agent }) {
  const direction = agent.heading || "south";
  const isWalking = agent.state === "walking";

  const assetBase = useGroveRuntimeStore((s) => s.assetBase);
  const spriteConfig = useGroveRuntimeStore((s) => s.spriteConfig);

  const spriteSet = useMemo(() => {
    const cfg = spriteConfig;
    if (!cfg) {
      // Fallback: should be filled shortly after mount.
      return null;
    }
    return getSpriteSetForAction(cfg, agent.role, agent.action);
  }, [spriteConfig, agent.role, agent.action]);

  const walkFrameMs = (spriteSet?.walkFrameMs ?? DEFAULT_WALK_FRAME_MS);
  const idleFrameMs = (spriteSet?.idleFrameMs ?? DEFAULT_IDLE_FRAME_MS);

  const [frameIdx, setFrameIdx] = useState(0);
  const [idleFrames, setIdleFrames] = useState<string[] | null>(null);

  useEffect(() => {
    setFrameIdx(0);
  }, [direction, isWalking, agent.role, agent.action]);

  useEffect(() => {
    if (isWalking || !spriteSet) {
      setIdleFrames(null);
      return;
    }

    const anims = spriteSet.idleAnims || [];
    const choice = anims.length > 0 ? anims[Math.floor(Math.random() * anims.length)] || null : null;
    setIdleFrames(choice ? makeAnim(assetBase, choice) : null);
    setFrameIdx(0);
  }, [assetBase, isWalking, spriteSet]);

  useEffect(() => {
    if (!isWalking || !spriteSet) return;

    const walk = makeWalk(assetBase, spriteSet.walkBase, spriteSet.walkFrames);
    const frames = walk[direction] || [];
    if (frames.length === 0) return;

    const id = window.setInterval(() => {
      setFrameIdx((i) => (i + 1) % frames.length);
    }, walkFrameMs);

    return () => window.clearInterval(id);
  }, [assetBase, direction, isWalking, spriteSet, walkFrameMs]);

  useEffect(() => {
    if (isWalking) return;

    const frames = idleFrames ?? [];
    if (frames.length <= 1) return;

    const id = window.setInterval(() => {
      setFrameIdx((i) => (i + 1) % frames.length);
    }, idleFrameMs);

    return () => window.clearInterval(id);
  }, [isWalking, idleFrames, idleFrameMs]);

  const src = useMemo(() => {
    if (!spriteSet) {
      return "";
    }

    const facing = isWalking ? direction : agent.role === "bloom" ? "south" : direction;

    if (isWalking) {
      const walk = makeWalk(assetBase, spriteSet.walkBase, spriteSet.walkFrames);
      const frames = walk[facing] && walk[facing].length > 0 ? walk[facing] : walk.south;
      if (frames && frames.length > 0) return frames[frameIdx % frames.length];
    }

    const idle = idleFrames ?? [];
    if (idle.length > 0) {
      return idle[frameIdx % idle.length];
    }

    const idleFacing = makeFacing(assetBase, spriteSet.idleFacingBase);
    return idleFacing[facing] || idleFacing.south;
  }, [assetBase, direction, frameIdx, idleFrames, isWalking, spriteSet, agent.role]);

  const zIndex = 1000 + Math.round(agent.y * 10);
  const moveDurationMs = agent.moveDurationMs ?? MOVE_TRANSITION_MS;

  return (
    <div
      className={`mycelium-grove-agent mycelium-grove-agent--${agent.role}`}
      style={{ left: `${agent.x}%`, top: `${agent.y}%`, zIndex, transitionDuration: `${moveDurationMs}ms` }}
    >
      <img className="mycelium-grove-agent__sprite" src={src} alt={agent.role} />
      <div className="mycelium-grove-agent__label">{getRoleLabel(agent.role)}</div>
    </div>
  );
}
