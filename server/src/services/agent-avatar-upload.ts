import sharp from "sharp";
import { isUuidLike } from "@paperclipai/shared";
import { and, eq } from "drizzle-orm";
import { agents, assets, type Db } from "@paperclipai/db";
import { unprocessable, notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import type { StorageService, PutFileResult } from "../storage/types.js";

const imageFormats: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpeg", "image/jpg": "jpeg",
  "image/webp": "webp", "image/gif": "gif", "image/avif": "heif",
};

/** Decode and re-encode raster uploads: no active content, URLs or EXIF metadata. */
export async function prepareAgentAvatar(bytes: Buffer, contentType: string): Promise<Buffer> {
  const format = imageFormats[contentType.toLowerCase()];
  if (!format || !bytes.length) throw unprocessable("Choose a PNG, JPEG, WebP, GIF or AVIF image");
  try {
    // Retain sharp's standard decompression limit and decode the first frame only.
    const image = sharp(bytes, { failOn: "warning" });
    const metadata = await image.metadata();
    if (metadata.format !== format) throw new Error("Image type does not match its content");
    return await image.rotate().resize(512, 512, { fit: "cover" }).webp().toBuffer();
  } catch {
    throw unprocessable("Image could not be read. Choose a valid image file.");
  }
}

export function agentAvatarUploadService(db: Db, storage: StorageService) {
  async function cleanup(assetId: string, companyId: string) {
    const [old] = await db.select().from(assets).where(and(eq(assets.id, assetId), eq(assets.companyId, companyId)));
    if (!old) return;
    try {
      await storage.deleteObject(companyId, old.objectKey);
      await db.delete(assets).where(eq(assets.id, old.id));
    } catch (err) {
      // Keep the asset record when backend deletion fails, so the file remains tracked.
      logger.warn({ err, assetId, companyId }, "Failed to clean up replaced agent avatar");
    }
  }

  async function associate(agentId: string, companyId: string, stored: PutFileResult | null, actor: { agentId: string | null; userId: string | null }) {
    let previous: string | null = null;
    let avatarAssetId: string | null = null;
    try {
      await db.transaction(async (tx) => {
        const [agent] = await tx.select().from(agents)
          .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId))).for("update");
        if (!agent) throw notFound("Agent not found");
        previous = agent.avatarAssetId;
        if (stored) {
          const [asset] = await tx.insert(assets).values({ ...stored, companyId,
            createdByAgentId: actor.agentId, createdByUserId: actor.userId }).returning();
          avatarAssetId = asset!.id;
        }
        await tx.update(agents).set({ avatarAssetId, updatedAt: new Date() }).where(eq(agents.id, agent.id));
      });
    } catch (err) {
      if (stored) await storage.deleteObject(companyId, stored.objectKey);
      throw err;
    }
    if (previous) await cleanup(previous, companyId);
    return { avatarAssetId, avatarUrl: avatarAssetId ? `/api/assets/${avatarAssetId}/content` : null };
  }

  return {
    getAgent: async (id: string) => {
      if (!isUuidLike(id)) return null;
      const [agent] = await db.select().from(agents).where(eq(agents.id, id));
      return agent ?? null;
    },
    upload: async (agentId: string, companyId: string, bytes: Buffer, contentType: string, actor: { agentId: string | null; userId: string | null }) => {
      const body = await prepareAgentAvatar(bytes, contentType);
      const stored = await storage.putFile({ companyId, namespace: "assets/agent-avatars", originalFilename: "avatar.webp", contentType: "image/webp", body });
      return associate(agentId, companyId, stored, actor);
    },
    remove: (agentId: string, companyId: string) => associate(agentId, companyId, null, { agentId: null, userId: null }),
  };
}
