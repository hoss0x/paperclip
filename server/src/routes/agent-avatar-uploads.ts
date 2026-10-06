import { Router } from "express";
import multer from "multer";
import type { Db } from "@paperclipai/db";
import type { StorageService } from "../storage/types.js";
import { agentAvatarUploadService } from "../services/agent-avatar-upload.js";
import { logActivity } from "../services/activity-log.js";
import { assertBoard, getAccessibleResource, getActorInfo } from "./authz.js";
import { formatAttachmentSize, MAX_ATTACHMENT_BYTES } from "../attachment-types.js";

export function agentAvatarUploadRoutes(db: Db, storage: StorageService) {
  const router = Router();
  const svc = agentAvatarUploadService(db, storage);
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 } });

  router.post("/agents/:agentId/avatar", async (req, res) => {
    const agent = await getAccessibleResource(req, res, svc.getAgent(req.params.agentId as string), "Agent not found");
    if (!agent) return;
    assertBoard(req);
    try {
      await new Promise<void>((resolve, reject) => upload.single("file")(req, res, (err) => err ? reject(err) : resolve()));
    } catch (err) {
      if (!(err instanceof multer.MulterError)) throw err;
      res.status(err.code === "LIMIT_FILE_SIZE" ? 422 : 400).json({ error: err.code === "LIMIT_FILE_SIZE"
        ? `Image is larger than the ${formatAttachmentSize(MAX_ATTACHMENT_BYTES)} limit` : err.message });
      return;
    }
    if (!req.file) { res.status(400).json({ error: "Missing file field 'file'" }); return; }
    const actor = getActorInfo(req);
    const result = await svc.upload(agent.id, agent.companyId, req.file.buffer, req.file.mimetype,
      { agentId: actor.agentId, userId: actor.actorType === "user" ? actor.actorId : null });
    await logActivity(db, { companyId: agent.companyId, ...actor, action: "agent.avatar_updated", entityType: "agent", entityId: agent.id,
      details: { avatarAssetId: result.avatarAssetId } });
    res.status(201).json(result);
  });

  router.delete("/agents/:agentId/avatar", async (req, res) => {
    const agent = await getAccessibleResource(req, res, svc.getAgent(req.params.agentId as string), "Agent not found");
    if (!agent) return;
    assertBoard(req);
    const result = await svc.remove(agent.id, agent.companyId);
    await logActivity(db, { companyId: agent.companyId, ...getActorInfo(req), action: "agent.avatar_removed", entityType: "agent", entityId: agent.id });
    res.json(result);
  });
  return router;
}
