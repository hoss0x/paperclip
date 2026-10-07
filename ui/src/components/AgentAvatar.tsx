import { agentAvatarUrl, customAgentAvatarUrl } from "@/lib/agent-avatar-url";
import { useState } from "react";
import { resolveAgentAppearance, type AgentAppearance, type AgentAvatarSize, type CharacterState } from "@paperclipai/shared";
import { cn } from "@/lib/utils";
import { deriveInitials } from "./Identity";

export type AvatarAgent = { id?: string; name?: string; appearance?: AgentAppearance | null; avatarUrl?: string | null };
export const avatarSizeClasses: Record<AgentAvatarSize, string> = {
  16: "size-4", 20: "size-5", 24: "size-6", 32: "size-8", 40: "size-10", 48: "size-12",
  64: "size-16", 96: "size-24", 128: "size-32", 256: "size-64", 512: "size-128",
};
export interface AgentAvatarProps {
  agent?: AvatarAgent | null;
  appearance?: AgentAppearance | null;
  size?: AgentAvatarSize;
  name?: string;
  label?: string;
  pose?: CharacterState;
  muted?: boolean;
  className?: string;
}
export function AgentAvatar({ agent, appearance, size = 24, name, label, pose = "rest", muted = false, className }: AgentAvatarProps) {
  const identity = resolveAgentAppearance(appearance ?? agent?.appearance, agent?.id);
  const customUrl = customAgentAvatarUrl(agent);
  const generatedUrl = agentAvatarUrl(identity, size, 1, pose, muted);
  const [failedCustomUrl, setFailedCustomUrl] = useState<string | null>(null);
  const useCustom = !!customUrl && failedCustomUrl !== customUrl;
  const src = useCustom ? customUrl : generatedUrl;
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return (
    <span data-slot="agent-avatar" className={cn("relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted align-middle", avatarSizeClasses[size], className)}
      role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {failedUrl === src ? <span className="text-xs text-muted-foreground">{deriveInitials(name ?? agent?.name ?? "Agent")}</span> :
        <img src={src} srcSet={useCustom ? undefined : `${agentAvatarUrl(identity, size, 2, pose, muted)} 2x`} alt="" width={size} height={size}
          decoding="async" loading="lazy" className={cn("size-full", useCustom ? "object-cover" : "object-contain")} onError={() => useCustom ? setFailedCustomUrl(src) : setFailedUrl(src)} />}
    </span>
  );
}
