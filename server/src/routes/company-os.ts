import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { saveEmployeeContractSchema, missionSchema, workstreamSchema, receiptSchema, contextEventSchema, knowledgeEntitySchema, knowledgeRelationshipSchema } from "@paperclipai/shared";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { companyOsService } from "../services/company-os.js";

const id = z.string().uuid();
const version = z.number().int().min(0);
const filterSchema = z.object({ missionId: id.optional(), agentId: id.optional(), entityId: id.optional(), correlationId: id.optional(), before: z.iso.datetime().optional() });

export function companyOsRoutes(db: Db) {
  const root = Router();
  const router = Router({ mergeParams: true });
  const svc = companyOsService(db);
  const company = (req: { params: Record<string, unknown> }) => id.parse(req.params.companyId);
  const resourceId = (req: { params: Record<string, unknown> }) => id.parse(req.params.id);
  router.use((req, _res, next) => { assertCompanyAccess(req, company(req)); next(); });
  router.get("/contracts/:id", async (req, res) => { res.json(await svc.currentContract(company(req), resourceId(req))); });
  router.get("/contracts/:id/history", async (req, res) => { res.json(await svc.contractHistory(company(req), resourceId(req))); });
  router.put("/contracts/:id", async (req, res) => {
    assertBoard(req);
    const input = saveEmployeeContractSchema.parse(req.body);
    res.json(await svc.saveContract(company(req), resourceId(req), input.contract, input.expectedVersion, getActorInfo(req)));
  });
  router.get("/missions", async (req, res) => { res.json(await svc.listMissions(company(req))); });
  router.get("/missions/:id", async (req, res) => { res.json(await svc.getMission(company(req), resourceId(req))); });
  router.post("/missions", async (req, res) => { res.status(201).json(await svc.saveMission(company(req), null, missionSchema.parse(req.body), 0, getActorInfo(req))); });
  router.put("/missions/:id", async (req, res) => {
    const input = z.object({ data: missionSchema, expectedVersion: version }).strict().parse(req.body);
    res.json(await svc.saveMission(company(req), resourceId(req), input.data, input.expectedVersion, getActorInfo(req)));
  });
  router.get("/missions/:id/workstreams", async (req, res) => {
    await svc.getMission(company(req), resourceId(req));
    res.json(await svc.listWorkstreams(company(req), resourceId(req)));
  });
  router.post("/missions/:id/workstreams", async (req, res) => { res.status(201).json(await svc.saveWorkstream(company(req), resourceId(req), null, workstreamSchema.parse(req.body), 0, getActorInfo(req))); });
  router.put("/missions/:missionId/workstreams/:id", async (req, res) => {
    const input = z.object({ data: workstreamSchema, expectedVersion: version }).strict().parse(req.body);
    res.json(await svc.saveWorkstream(company(req), id.parse(req.params.missionId), resourceId(req), input.data, input.expectedVersion, getActorInfo(req)));
  });
  router.get("/receipts", async (req, res) => { res.json(await svc.listReceipts(company(req), filterSchema.parse(req.query))); });
  router.get("/receipts/:id", async (req, res) => { res.json(await svc.getReceipt(company(req), resourceId(req))); });
  router.post("/receipts", async (req, res) => { res.status(201).json(await svc.sendReceipt(company(req), receiptSchema.parse(req.body), getActorInfo(req))); });
  router.post("/receipts/:id/acknowledge", async (req, res) => { res.json(await svc.acknowledgeReceipt(company(req), resourceId(req), getActorInfo(req))); });
  router.get("/events", async (req, res) => { res.json(await svc.listEvents(company(req), filterSchema.parse(req.query))); });
  router.post("/events", async (req, res) => { res.status(201).json(await svc.appendEvent(company(req), contextEventSchema.parse(req.body), getActorInfo(req))); });
  router.get("/knowledge", async (req, res) => { res.json(await svc.listKnowledge(company(req), z.string().max(200).optional().parse(req.query.q))); });
  router.post("/knowledge", async (req, res) => { res.status(201).json(await svc.saveKnowledge(company(req), null, knowledgeEntitySchema.parse(req.body), 0, getActorInfo(req))); });
  router.put("/knowledge/:id", async (req, res) => {
    const input = z.object({ data: knowledgeEntitySchema, expectedVersion: version }).strict().parse(req.body);
    res.json(await svc.saveKnowledge(company(req), resourceId(req), input.data, input.expectedVersion, getActorInfo(req)));
  });
  router.get("/relationships", async (req, res) => { res.json(await svc.listRelationships(company(req), req.query.history === "true")); });
  router.post("/relationships", async (req, res) => { res.status(201).json(await svc.addRelationship(company(req), knowledgeRelationshipSchema.parse(req.body), getActorInfo(req))); });
  router.get("/context-packs/:id", async (req, res) => { res.json(await svc.getPack(company(req), resourceId(req))); });
  root.use("/companies/:companyId/organization", router);
  return root;
}
