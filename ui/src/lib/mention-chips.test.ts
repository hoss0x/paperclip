// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { appearanceForPalette, agentAvatarUrl, legacyAgentAppearance } from "@paperclipai/shared";
import { applyMentionChipDecoration, clearMentionChipDecoration, mentionChipInlineStyle, parseMentionChipHref } from "./mention-chips";

describe("agent mention avatars", () => {
  it("uses the agent's selected appearance instead of the saved legacy icon", () => {
    const appearance = appearanceForPalette("electric-grove");
    const style = mentionChipInlineStyle({ kind: "agent", agentId: "agent", icon: "code", appearance });
    expect(style).toEqual({ "--paperclip-mention-avatar-image": `url("${agentAvatarUrl(appearance, 16, 2)}")` });
  });

  it("uses uploaded avatars in mention chips", () => {
    const avatarUrl = "/api/assets/11111111-1111-4111-8111-111111111111/content";
    expect(mentionChipInlineStyle({ kind: "agent", agentId: "agent", icon: null, avatarUrl })).toEqual({ "--paperclip-mention-avatar-image": `url("${avatarUrl}")` });
  });
  it("ignores external image URLs in mention chips", () => {
    expect(mentionChipInlineStyle({ kind: "agent", agentId: "agent", icon: null, avatarUrl: "https://example.com/photo.png" })).toEqual({ "--paperclip-mention-avatar-image": expect.stringContaining("/api/agent-avatars/") });
  });
  it("keeps old icon-bearing mentions readable with the agent's stable default avatar", () => {
    const parsed = parseMentionChipHref("agent://agent-old?icon=crown");
    expect(parsed?.kind).toBe("agent");
    expect(mentionChipInlineStyle(parsed!)).toEqual({
      "--paperclip-mention-avatar-image": `url("${agentAvatarUrl(legacyAgentAppearance("agent-old"), 16, 2)}")`,
    });
  });

  it("clears the avatar and any old icon decoration when an anchor stops being a mention", () => {
    const anchor = document.createElement("a");
    anchor.style.setProperty("--paperclip-mention-icon-mask", "old-icon");
    applyMentionChipDecoration(anchor, { kind: "agent", agentId: "agent", icon: "code" });
    expect(anchor.style.getPropertyValue("--paperclip-mention-icon-mask")).toBe("");
    expect(anchor.style.getPropertyValue("--paperclip-mention-avatar-image")).toContain("/api/agent-avatars/");
    clearMentionChipDecoration(anchor);
    expect(anchor.hasAttribute("data-mention-kind")).toBe(false);
    expect(anchor.style.getPropertyValue("--paperclip-mention-avatar-image")).toBe("");
  });
});
