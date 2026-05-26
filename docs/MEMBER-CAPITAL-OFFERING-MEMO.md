# Member Capital / Fundraise Instrument Memo (Draft)

**Not legal advice.** Securities counsel must select and document the offering before any solicitation.

## Context

Public beta + cooperative formation + Phase 2 capital raise. Audience: cooperative members and aligned community investors.

## Instrument options

| Instrument | Typical use | Disclosure burden |
|------------|-------------|-------------------|
| **Member shares** (state co-op exemption) | Members only; capped raise | State filing + OM |
| **Regulation Crowdfunding (Reg CF)** | Non-accredited investors via portal | Form C, ongoing reports |
| **Regulation A+** | Broader public; mini-IPO | Form 1-A, audited financials (Tier 2) |

## Recommendation for POC → Phase 2

1. **Near term:** Member-only capital under state cooperative exemption (if available) with written subscription agreement.
2. **If non-members invest:** Reg CF with licensed funding portal — do not self-host “invest” buttons on the Pod.

## Required documents (counsel)

- Offering memorandum / private placement memorandum
- Subscription agreement
- Risk factors (must reference `docs/THREAT-MODEL.md`)
- Form of member share or patronage certificate

## KYC / AML

If accepting funds online: integrate compliant payment + identity vendor (Stripe Identity, etc.). **Out of scope** for code POC unless counsel requires.

## Website gating

- `/membership` — join + use Pod
- `/invest` — password or counsel-approved PDF only; no live payment until qualified
