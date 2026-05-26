# Forum Data Cooperative — Governance Operating Model (Pilot)

Aligned with Wernfeldt five-layer blueprint and Articles v2.

## Layer 1 — Strategic mandate

- Entity: The Forum Data Cooperative Association (Maine Title 13 Ch. 85, in formation).
- Pilot scope: formation-pilot memo; no public marketing until Data Policy v1 + counsel review.

## Layer 2 — Decision authority

| Domain | Owner | Decides |
|--------|-------|---------|
| Member Pod (civic RDF) | Member (WebID) | Read/write own `civic/` container |
| Cooperative ingest | Member opt-in + bridge | Export via signed bundle only |
| Aggregate report | Board / Data Council | Publish after 7-day review |
| AI classify inputs | Board + tech steward | Ollama profile / prompt changes |

## Layer 3 — Forums

- **Report review** (Art VII): 7-day window before public egress.
- **Data Council**: cross-domain disputes (quarterly).

## Layer 4 — Operational execution

- RDF vocabulary versioned in `src/civic-vocab.js`.
- Listener `/api/civic/export` requires `consent: true` + Ed25519 signature.

## Layer 5 — KPIs

- Opt-in count on each egress report.
- Raw wipe confirmations (`wiped_at` in `forum_inbound`).
- Review-period compliance (no `latest` KV until published).
