# Native organization integration — 2026-10-19

Baseline: hoss0x/paperclip b1c9317c2d1dce209deba38ff6fd436c4f30e0cd.
Branch: feat/company-os-native-integration. No master merge or production deployment.

Extend the existing company model with long-term mission and restrictive organizational policy. Keep immutable employee contract revisions, adding structured permissions and service exposure scopes. Apply policy inside domain transactions after company/employee validation; policies only restrict existing authorization. Reserved lifecycle events are domain-only and carry explicit origin/provenance.

Replace recent-ID context filtering with ordered, bounded stream pages and successful-run cursor advancement. Include mission-linked goals regardless of employee ownership. Extract bounded knowledge retrieval behind a replaceable interface, prioritizing explicit references, current graph neighbors and scoped search. Derive events from existing activity/work-product/approval/run evidence without recursive logging.

Retire the Company OS sidebar/page. Reuse its editors as scoped native panels: employee contracts/context in Agent detail, missions/workstreams/knowledge in Projects, receipts in Inbox, operational events in existing Activity/Audit, immutable packs in Run detail. Company settings owns company mission/policy.

Forward migrations only. Focused backend tests cover policies, reserved events, 100-event backlog, scoped specialists, relevance and evidence ingestion; UI tests cover destinations/removal. Then affected compatibility tests and isolated real Antigravity/OpenCode acceptance smoke. Preserve earlier baseline evidence; do not repeat unrelated full-suite validation blindly.
