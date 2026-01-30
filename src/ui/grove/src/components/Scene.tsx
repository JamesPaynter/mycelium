import React from "react";
import { useGroveRuntimeStore } from "../store/runtimeStore";
import { useGroveStore } from "../store/groveStore";
import AgentSprite from "./AgentSprite";

export default function Scene() {
  const assetBase = useGroveRuntimeStore((s) => s.assetBase);
  const agents = useGroveStore((s) => s.agents);
  const bubbles = useGroveStore((s) => s.bubbles);

  const backgroundUrl = `${assetBase.replace(/\/$/, "")}/backgrounds/forest-clearing.png`;

  return (
    <div className="mycelium-grove-scene" style={{ backgroundImage: `url(${backgroundUrl})` }}>
      <div className="mycelium-grove-layer">
        {agents.map((agent) => (
          <AgentSprite key={agent.id} agent={agent} />
        ))}
      </div>

      <div className="mycelium-grove-layer">
        {bubbles.map((bubble) => {
          const agent = agents.find((a) => a.id === bubble.agentId);
          if (!agent) return null;
          const zIndex = 4000 + Math.round(agent.y * 10);
          return (
            <div
              key={bubble.id}
              className={`mycelium-grove-bubble mycelium-grove-bubble--${bubble.kind}`}
              style={{ left: `${agent.x}%`, top: `${agent.y}%`, zIndex }}
              title={bubble.text}
            >
              {bubble.text}
            </div>
          );
        })}
      </div>
    </div>
  );
}
