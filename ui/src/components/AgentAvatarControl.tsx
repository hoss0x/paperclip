import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { AgentAvatar } from "./AgentAvatar";
import { Button } from "./ui/button";

export function AgentAvatarControl({ agent }: { agent: Agent }) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const queryClient = useQueryClient();
  useEffect(() => { setFile(null); }, [agent.id]);
  useEffect(() => {
    if (!file) { setPreview(null); return; }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const mutation = useMutation({
    mutationFn: (action: "upload" | "remove") => action === "upload" && file
      ? agentsApi.uploadAvatar(agent.id, file) : agentsApi.removeAvatar(agent.id),
    onSuccess: async () => {
      setFile(null);
      await queryClient.invalidateQueries({ queryKey: ["agents"] });
    },
  });
  return <section className="space-y-3" aria-label="Agent profile photo">
    <div className="flex items-center gap-4">
      {preview ? <img src={preview} alt="New avatar preview" className="size-16 shrink-0 rounded-full bg-muted object-cover" />
        : <AgentAvatar agent={agent} size={64} label={`${agent.name} avatar`} />}
      <div className="min-w-0 space-y-2">
        <p className="text-sm font-medium">Profile photo</p>
        <p className="text-xs text-muted-foreground">PNG, JPEG, WebP, GIF or AVIF. The image is cropped to a square.</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" disabled={mutation.isPending} onClick={() => input.current?.click()}>
            {agent.avatarAssetId || file ? "Replace photo" : "Upload photo"}
          </Button>
          {file ? <>
            <Button size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate("upload")}>Save photo</Button>
            <Button variant="ghost" size="sm" disabled={mutation.isPending} onClick={() => setFile(null)}>Cancel</Button>
          </> : agent.avatarAssetId ? <Button variant="ghost" size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate("remove")}>Remove photo</Button> : null}
        </div>
      </div>
    </div>
    <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" aria-label="Choose profile photo" disabled={mutation.isPending} className="hidden"
      onChange={(event) => { mutation.reset(); setFile(event.target.files?.[0] ?? null); event.target.value = ""; }} />
    {mutation.isPending ? <p role="status" className="text-xs text-muted-foreground">Saving photo…</p> : null}
    {mutation.error ? <p role="alert" className="text-sm text-destructive">{mutation.error.message}</p> : null}
  </section>;
}
