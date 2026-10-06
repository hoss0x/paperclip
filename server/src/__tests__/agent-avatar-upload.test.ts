import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { agents, assets, companies, createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentAvatarUploadService, prepareAgentAvatar } from "../services/agent-avatar-upload.js";
import { agentAvatarUploadRoutes } from "../routes/agent-avatar-uploads.js";
import { assetRoutes } from "../routes/assets.js";
import { MAX_ATTACHMENT_BYTES } from "../attachment-types.js";
import { Readable } from "node:stream";
import type { StorageService } from "../storage/types.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
const png = await sharp({ create: { width: 16, height: 24, channels: 3, background: "red" } }).png().toBuffer();

describe("avatar image validation", () => {
  it("decodes and crops uploads into a metadata-free square", async () => {
    const output = await prepareAgentAvatar(png, "image/png");
    expect(await sharp(output).metadata()).toMatchObject({ format: "webp", width: 512, height: 512 });
  });
  it.each(["jpeg", "webp", "gif", "avif"] as const)("accepts valid %s images", async (format) => {
    const bytes = await sharp(png).toFormat(format).toBuffer();
    const output = await prepareAgentAvatar(bytes, `image/${format}`);
    expect((await sharp(output).metadata()).format).toBe("webp");
  });
  it.each([[Buffer.from("bad"), "image/png"], [png, "image/jpeg"], [Buffer.from('<svg/>'), "image/svg+xml"], [Buffer.alloc(0), "image/png"]])("rejects invalid or mismatched files", async (bytes, type) => {
    await expect(prepareAgentAvatar(bytes, type)).rejects.toMatchObject({ status: 422 });
  });
});

describeDb("persisted agent avatars and access", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID(), otherCompanyId = randomUUID(), agentId = randomUUID();
  const objects = new Map<string, Buffer>();
  const storage: StorageService = {
    provider: "local_disk",
    putFile: vi.fn(async (input) => {
      const key = `${input.companyId}/${randomUUID()}`;
      const body = input.body as Buffer;
      objects.set(key, body);
      return { provider: "local_disk", objectKey: key, byteSize: body.length, sha256: "a".repeat(64), originalFilename: input.originalFilename, contentType: input.contentType };
    }),
    getObject: async (_companyId, key) => ({ stream: Readable.from(objects.get(key)!), contentLength: objects.get(key)!.length }),
    headObject: async (_companyId, key) => ({ exists: objects.has(key) }),
    deleteObject: vi.fn(async (_companyId, key) => { objects.delete(key); }),
  };
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-avatar-upload-");
    db = createDb(tempDb.connectionString);
    await db.insert(companies).values([{ id: companyId, name: "Avatars", issuePrefix: "AVT" }, { id: otherCompanyId, name: "Other", issuePrefix: "OTH" }]);
    await db.insert(agents).values({ id: agentId, companyId, name: "Omar" });
  }, 30_000);
  afterAll(async () => { await tempDb?.cleanup(); });

  function app(actor: any = { type: "board", source: "local_implicit", userId: "user-1" }) {
    const server = express();
    server.use((req, _res, next) => { req.actor = actor; next(); });
    server.use("/api", agentAvatarUploadRoutes(db, storage), assetRoutes(db, storage));
    server.use((err: any, _req: any, res: any, _next: any) => res.status(err.status ?? 500).json({ error: err.message }));
    return server;
  }

  it("uploads, persists, serves, replaces and removes the asset", async () => {
    const first = await request(app()).post(`/api/agents/${agentId}/avatar`).attach("file", png, { filename: "portrait.png", contentType: "image/png" });
    expect(first.status).toBe(201);
    const svc = agentAvatarUploadService(db, storage);
    expect((await svc.getAgent(agentId))!.avatarAssetId).toBe(first.body.avatarAssetId);
    const served = await request(app()).get(first.body.avatarUrl);
    expect(served.status).toBe(200);
    expect(served.headers["content-type"]).toBe("image/webp");
    expect(served.headers["cache-control"]).toContain("private");
    const second = await request(app()).post(`/api/agents/${agentId}/avatar`).attach("file", png, { filename: "new.png", contentType: "image/png" });
    expect(second.status).toBe(201);
    expect(second.body.avatarAssetId).not.toBe(first.body.avatarAssetId);
    expect(objects.size).toBe(1);
    expect(await db.select().from(assets).where(eq(assets.id, first.body.avatarAssetId))).toEqual([]);
    expect((await request(app()).get(first.body.avatarUrl)).status).toBe(404);
    expect((await request(app()).delete(`/api/agents/${agentId}/avatar`)).status).toBe(200);
    expect((await svc.getAgent(agentId))!.avatarAssetId).toBeNull();
    expect(objects.size).toBe(0);
    expect(await db.select().from(assets).where(eq(assets.id, second.body.avatarAssetId))).toEqual([]);
  });

  it("rejects invalid uploads before storage and preserves the current photo", async () => {
    const before = objects.size;
    const response = await request(app()).post(`/api/agents/${agentId}/avatar`).attach("file", Buffer.from("invalid"), { filename: "fake.png", contentType: "image/png" });
    expect(response.status).toBe(422);
    expect(objects.size).toBe(before);
    expect((await request(app()).post(`/api/agents/${agentId}/avatar`)).status).toBe(400);
  });
  it("uses the existing attachment byte ceiling and rejects malformed agent ids", async () => {
    expect((await request(app()).post(`/api/agents/${agentId}/avatar`).attach("file", Buffer.alloc(MAX_ATTACHMENT_BYTES + 1), { filename: "large.png", contentType: "image/png" })).status).toBe(422);
    expect((await request(app()).delete("/api/agents/not-an-id/avatar")).status).toBe(404);
  });
  it("denies agents, viewers, unauthenticated callers and cross-company access", async () => {
    for (const actor of [
      { type: "agent", companyId, agentId },
      { type: "board", source: "session", userId: "viewer", companyIds: [companyId], memberships: [{ companyId, status: "active", membershipRole: "viewer" }] },
      { type: "none" },
      { type: "board", source: "session", userId: "other", companyIds: [otherCompanyId] },
    ]) {
      const result = await request(app(actor)).delete(`/api/agents/${agentId}/avatar`);
      expect([401, 403, 404]).toContain(result.status);
      const uploadDenied = await request(app(actor)).post(`/api/agents/${agentId}/avatar`).attach("file", png, { filename: "portrait.png", contentType: "image/png" });
      expect([401, 403, 404]).toContain(uploadDenied.status);
    }
    const uploaded = await request(app()).post(`/api/agents/${agentId}/avatar`).attach("file", png, { filename: "portrait.png", contentType: "image/png" });
    const other = app({ type: "agent", companyId: otherCompanyId, agentId: randomUUID() });
    expect((await request(other).get(uploaded.body.avatarUrl)).status).toBe(404);
    await request(app()).delete(`/api/agents/${agentId}/avatar`);
  });
  it("serializes concurrent replacements and cleans both superseded files", async () => {
    const svc = agentAvatarUploadService(db, storage);
    await Promise.all([svc.upload(agentId, companyId, png, "image/png", { agentId: null, userId: null }), svc.upload(agentId, companyId, png, "image/png", { agentId: null, userId: null })]);
    expect(objects.size).toBe(1);
    await svc.remove(agentId, companyId);
    expect(objects.size).toBe(0);
  });
  it("retains an inspectable asset record if backend cleanup fails", async () => {
    const svc = agentAvatarUploadService(db, storage);
    const uploaded = await svc.upload(agentId, companyId, png, "image/png", { agentId: null, userId: null });
    vi.mocked(storage.deleteObject).mockRejectedValueOnce(new Error("Storage temporarily unavailable"));
    await svc.remove(agentId, companyId);
    expect((await svc.getAgent(agentId))!.avatarAssetId).toBeNull();
    const [tracked] = await db.select().from(assets).where(eq(assets.id, uploaded.avatarAssetId!));
    expect(tracked).toBeDefined();
    expect(objects.has(tracked.objectKey)).toBe(true);
    await storage.deleteObject(companyId, tracked.objectKey);
    await db.delete(assets).where(eq(assets.id, tracked.id));
  });
  it("cleans uploaded storage if the association fails", async () => {
    const svc = agentAvatarUploadService(db, storage);
    await expect(svc.upload(randomUUID(), companyId, png, "image/png", { agentId: null, userId: null })).rejects.toMatchObject({ status: 404 });
    expect(objects.size).toBe(0);
  });
});
