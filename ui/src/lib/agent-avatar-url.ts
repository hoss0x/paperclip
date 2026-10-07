// Storybook replaces this module at build time with its packaged-image resolver.
export { agentAvatarUrl } from "@paperclipai/shared";

/** Only server-issued asset paths can replace a generated agent identity. */
export function customAgentAvatarUrl(agent?: { avatarUrl?: string | null } | null): string | undefined {
  return agent?.avatarUrl?.match(/^\/api\/assets\/[a-f0-9-]+\/content$/i)?.[0];
}
