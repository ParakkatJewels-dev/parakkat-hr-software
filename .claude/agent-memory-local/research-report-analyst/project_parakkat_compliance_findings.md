---
name: project-parakkat-compliance-findings
description: Non-obvious Kerala/Indian statutory compliance findings from the 2026-07-27 HR/payroll research report, worth knowing before further build or research work
metadata:
  type: project
---

From a full-day, multi-agent research pass (2026-07-27) producing a compliance gap report for Parakkat Jewels' in-house HR/payroll software. Full report: [[reference-parakkat-compliance-report]]. These are the findings that are surprising, hard to re-derive, or change the shape of the software's data model — not a repeat of standard EPF/ESI facts.

**Kerala has no standalone Professional Tax Act.** PT is levied by whichever local self-government body (Panchayat/Municipality/Corporation) each branch sits in, under Section 200 of the Kerala Panchayat Raj Act, 1994 — not a single state authority. With ~46 branches, this means PT is potentially dozens of separate remittance relationships, not one filing. Current slabs per G.O. (Sadha) No. 1149/2024/LSGD, effective 1 Oct 2024 (half-yearly, ₹320–₹1,250 depending on income band). **Implication:** the compliance data model needs a branch→local-body mapping table, not a flat state-level PT setting.

**Kerala has publicly refused to implement the 2020 Labour Codes.** Kerala's Labour Minister V. Sivankutty stated in reporting tied to a Dec 2025 "Labour Conclave" that Kerala will not implement the new labour codes (called them "anti-worker"); the state's Dec 2021 draft rules remain draft. The 4 Labour Codes were notified nationally 21 Nov 2025, but **Kerala's existing central Acts (EPF Act, ESI Act, Payment of Bonus Act, Payment of Gratuity Act, Kerala Shops & Commercial Establishments Act) remain the operative regime** for Parakkat, not the new Codes. This is a live, politically contested situation — re-verify before any go-live decision that depends on Labour Code provisions (e.g., the reported 2-day full & final settlement rule, or the "50% basic wage" rule for PF/gratuity computation).

**POSH Act likely requires a separate Internal Complaints Committee per branch, not one centralized ICC.** Practitioner sources describe a Jan 2026 case where an entire ICC proceeding was invalidated at a retail chain over a lapsed branch-committee member's term. With ~46 branches across Kerala's 14 districts, annual POSH reports must also be filed per-district with each District Officer — a head-office filing does not substitute. This is flagged as the single highest legal-exposure item found in the whole report, given the branch count.

**Goldsmiths/craft artists are a legally distinct minimum-wage category** ("Manufacture of Gold and Silver Ornaments," last revised via G.O.(P) No.9/2026/LBR, 3 Feb 2026, ~₹17,940–21,360/month + piece-rate wages by weight/complexity of gold/silver worked) — separate from the general "Shops and Commercial Establishments" category covering retail staff. A single blanket minimum-wage floor across all 242 employees would be legally incorrect.

**No jewellery-specific sales-commission data exists publicly anywhere** (Tanishq/Kalyan/Malabar structures are unpublished) — confirmed as a genuine research gap after extensive searching, not an oversight. If commission-engine work comes up again, don't expect to find a benchmark; it needs to be a policy exercise with the client's sales leadership instead.

**Competitive benchmark note:** none of the 6 major Indian HR SaaS platforms (greytHR, Keka, Zoho People/Payroll, Darwinbox, RazorpayX Payroll, Kredily) offer a sales-commission module either — this is a separate software category everywhere, so it isn't a build-vs-buy question. Also: true multi-entity support (Parakkat's core architectural strength) is commonly gated to Enterprise tiers even at these vendors — Darwinbox is the strongest commercial option for multi-entity but has no public pricing and no retail/jewellery evidence.
