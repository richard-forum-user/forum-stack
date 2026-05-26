# Requirements traceability (published work → implementation)

| Source | Requirement | Implementation |
|--------|-------------|----------------|
| Articles Art II | Non-custodial fiduciary; member owns data | Solid Pod + WAC; opt-in bridge only |
| Articles Art VII.1 | Wipe raw after aggregation | `report_lifecycle.py` wipe pass |
| Articles Art VII.2 | 7-day review before listing | `report_lifecycle` + `push.py` gate + egress Worker |
| Blueprint L2 | Named domain owners | `governance-operating-model.md` |
| Pentland Rule 1 | Meaningful consent | Opt-in checkbox + `consent: true` on export |
| Data Coop Report | DAR / property rights | WebID + Pod URL as digital registry |
| ForumAI WhitePaper | Personal pod vs cooperative intelligence | `1.3-solid-webauthn` build; Local SQL + opt-in egress |

Sources: `Supporting Documents/` in this repo.
