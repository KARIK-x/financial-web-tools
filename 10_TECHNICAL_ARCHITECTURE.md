# Technical Architecture Recommendation

**Date:** 2026-10-24 · Verified pricing as of research date.

## 1. Recommended Stack (primary)

| Layer | Choice | Why |
|---|---|---|
| Frontend | **Next.js 15 + TypeScript + Tailwind** | One framework for dashboard + member mobile web; responsive; large hiring pool among Pulchowk students; Vercel-free-tier or cheap VPS hosting |
| Backend API | **FastAPI (Python)** for OCR/import workers; **Supabase** for standard CRUD via PostgREST + RLS | Python is the native ecosystem for OCR/CV; keep business-CRUD on Postgres where possible |
| Database | **PostgreSQL via Supabase Pro** ($25/mo: 8GB DB, 100GB storage, Auth 100k MAU, daily backups, no auto-pause) | Relational integrity is the product's core promise; RLS gives DB-enforced authz; $25/mo realistic total (makerkit.dev/uibakery.io verified 2026) |
| AuthN/Z | Supabase Auth + custom RBAC tables + RLS policies | Free at this scale; org-scoped; 2FA (TOTP) available |
| Document storage | Supabase Storage private buckets (content-addressed keys) | Included in $25; signed URLs; exportable to S3/MinIO later via same key scheme |
| OCR | **PaddleOCR PP-OCRv5** (Devanagari+English model, self-hosted, CPU-capable, free) + Tesseract ensemble; optional Google Document AI escalation ($0.10/doc, FM opt-in) | Only credible free Devanagari option (verified PP-OCRv5 language table); zero marginal cost on 5,000-doc backlog |
| Background jobs | **pg-boss** (Postgres job queue) | No Redis to operate; retry/schedule built-in; fits minimal-infra goal |
| Notifications | DB-driven in-app + email via Resend/Supabase edge functions | Free tier sufficient; SMS deferred (cost) |
| Hosting | Vercel free (frontend) + one small VPS ($5–10/mo, e.g., Hetzner) for FastAPI worker + OCR, or Railway/Render | Total ≈ **$30–40/month** |
| Observability | Supabase logs + Sentry free tier (frontend+API errors) | — |
| Backups | Supabase daily (7d) + weekly pg_dump to off-site encrypted storage | Restore drill quarterly (doc 09) |

## 2. Alternatives considered

| Alternative | Verdict |
|---|---|
| **Full self-host on VPS** (Postgres+MinIO+Caddy, $5–10/mo) | Cheapest but FINANCE TRACKER has no sysadmin; backups/patching become someone's unpaid job → rejected for v1, revisit if costs matter in year 3 |
| **Firebase** | NoSQL hurts relational financial integrity; per-op pricing surprises; egress pricier (metacto.com comparison 2026-05) → rejected |
| **Neon/Xata + separate auth/storage** | ~$14–26/mo for DB alone; adding Auth+Storage+CDN approaches Supabase price with more assembly (makerkit.dev 2026-06) → viable fallback, not better |
| **Django monolith instead of Next+FastAPI** | Reasonable; rejected only because Next.js+Supabase gets auth/storage/RLS for near-zero work and the OCR worker still needs Python anyway → hybrid above |
| **Microservices / Kubernetes / message buses** | Overengineering for <50 concurrent users; rejected |

## 3. Key architectural decisions & trade-offs

1. **DB-enforced integrity over app-enforced**: money math and state machines in Postgres constraints/triggers — a buggy deploy must not be able to corrupt finances. Trade-off: more SQL discipline upfront.
2. **Documents outside the DB, linked by immutable IDs**: portability (move to MinIO/S3 by copying keys), DB stays small/fast. Trade-off: two stores to back up (mitigated: both in Supabase, plus off-site dump of metadata).
3. **Monolith + single worker, not services**: one deployable web app + one worker process. Trade-off: worker deploys coupled to repo — acceptable.
4. **Offline behavior**: P1 = draft persistence in browser (IndexedDB) so a photo taken offline isn't lost; submission requires connectivity. Full offline sync is a P4+ decision with real conflict complexity — deliberately deferred.
5. **Poor-connectivity design**: compressed thumbnails everywhere (original fetched on demand), paginated lists, receipt capture compresses client-side to ≤1MB before upload.
6. **Testing**: pytest (worker/API) + Playwright (critical flows: submit→approve→reimburse; import→review→baseline); seeded synthetic dataset; CI on every PR; migration tests for constraint changes.
7. **Migration path**: schema versioned (Alembic for worker-side, Supabase migrations for DB); full CSV/JSON export guarantees no lock-in — the export format is itself a spec'd deliverable in P1.
