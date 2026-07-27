⚠️ *Disclaimer: This report is prepared for informational purposes only and does not constitute legal, financial, or professional advice. Statutory rates, thresholds, and legal-status claims below should be independently confirmed with a Kerala-licensed labour law consultant / chartered accountant before being encoded as fixed values in software, and before any compliance decision is made.*

# What Parakkat Jewels' HR/Payroll Software Legally Must Have, and What It Should Have
**Prepared for:** Abhishek, Parakkat Jewels — HR/Payroll Software Build
**Date:** July 27, 2026
**Report Type:** Statutory Compliance Gap Analysis + Competitive Feature Benchmark
**Brief Description:** A prioritised, citation-backed assessment of what a 242-employee, multi-entity Kerala jewellery retail group is legally required to build into its in-house HR/payroll system, benchmarked against what commercial Indian HR SaaS products offer and what matters most for a multi-branch retail operation.

---

## Executive Summary

Parakkat Jewels' in-house system already covers the operational core of HR/payroll — org structure, attendance, leave, a payroll engine, expense claims, assets, recruitment, and onboarding. This research found that **the highest-priority gaps are not features but statutory compliance calculation and filing capability**: EPF, ESI, Kerala Professional Tax, TDS (Section 192), Gratuity, and the Payment of Bonus Act. None of these are optional — each has a specific legal trigger that a 242-employee, multi-branch, multi-entity Kerala business almost certainly already crosses, and each carries financial penalties (interest, late fees, prosecution risk) for non-compliance, independent of whether the software supports it.

The single most operationally complex item is **Kerala Professional Tax**: unlike most states, Kerala has no standalone PT statute — it is levied by whichever of ~1,000+ local self-government bodies (panchayat, municipality, or corporation) each branch sits in, under the Kerala Panchayat Raj Act, 1994. With ~46 branches, this is a branch-to-local-body mapping problem the software does not yet solve. Close behind is **POSH Act compliance**: legal practice consistently indicates a separate Internal Complaints Committee is required per branch/location that crosses 10 employees, not one committee for the whole company — a real exposure across 46 locations that has led to invalidated proceedings elsewhere in India.

A second finding worth flagging prominently: **India's four new Labour Codes were notified nationally in November 2025, but Kerala's Labour Minister has publicly stated Kerala will not implement them**, and the state's December 2021 draft rules remain in draft as of this report [ThePrint, 2026]. This means, for now, Parakkat should build to the **existing EPF Act, ESI Act, Payment of Bonus Act, Payment of Gratuity Act, and Kerala Shops & Commercial Establishments Act** — not to the new Codes — while keeping rate/threshold values configurable rather than hard-coded, since this is a live and politically contested situation.

On the competitive side, benchmarking greytHR, Keka, Zoho People/Payroll, Darwinbox, RazorpayX Payroll, and Kredily shows that **automatic government-rate updates and one-click statutory filing (ECR, Form 16, Form 24Q, PT challans) are universal table stakes in Indian HR SaaS** — this is the single biggest risk-transfer argument for buying rather than building, and the area where Parakkat's custom build carries the most ongoing maintenance burden. Conversely, true multi-entity support (Parakkat's core requirement) is often a paid add-on even at these vendors, which validates the in-house approach for that specific need. No vendor — commercial or otherwise — offers a jewellery-specific sales-commission module; this remains a custom build regardless of build-vs-buy decisions.

This report is organized in three priority tiers, as requested: **(1) legally mandatory items that appear to be missing**, **(2) features every serious Indian HR SaaS competitor treats as baseline**, and **(3) high-value features specific to a multi-branch jewellery retailer**. Recommendations follow at the end, sequenced by legal risk and build complexity.

---

## Research Objective

Determine what a mid-size Indian retail business — specifically Parakkat Jewels (4 legal entities, ~46 branches + 1 factory, 242 employees, Kerala) — is legally required to have in its HR/payroll system, and what it practically needs to be competitive with commercial Indian HR SaaS and fit for a multi-branch jewellery retail operation. Scope: Kerala state law and central Indian labour/tax law as of July 2026; excludes items the software already has (see brief). Time horizon: current law plus a forward look at the Labour Codes 2020 transition.

---

## Methodology

- **Primary sources sought:** epfindia.gov.in, esic.gov.in, incometax.gov.in, labour.kerala.gov.in (Kerala Labour Commissionerate), Kerala Gazette notifications, PIB press releases.
- **Secondary sources used where primary text was not machine-readable or did not state a practical detail:** ClearTax, TaxGuru, greytHR/Keka/Zoho compliance wikis, TeamLease RegTech, Nexdigm, KPMG/EY flash alerts, LiveLaw, SCC Online, and vendor pricing/documentation pages (used directly for the competitor section).
- **Research method:** Four parallel research passes (statutory compliance — contributions/tax; statutory compliance — leave/safety/labour codes; competitor feature and pricing benchmarking; retail-specific and practical features), each cross-checking claims across 2–3 independent sources, followed by direct verification searches on the highest-stakes figures (EPF/ESI rates, Kerala PT slabs, Labour Code status).
- **Research period:** July 27, 2026 (single-day pass). Compliance rates and the Labour Codes' status can change without notice — this report should not be treated as current beyond a few months without re-verification.
- **Limitations:** Several official government PDFs (EPFO, ESIC Standard Note, Kerala Shops Act Rules, Kerala minimum wage notifications) could not be machine-parsed during this research and are cited via corroborating secondary sources instead — these are flagged individually below. No jewellery-sector-specific data exists in the public record for sales commission structures or festival-season staffing; general organized-retail data is used as an explicit proxy. Two of six competitor pricing pages (Keka, Zoho People) could not be fetched directly due to site errors and rely on cross-checked third-party aggregation.

---

# PART A — LEGALLY MANDATORY AND MISSING

These are statutory obligations that almost certainly already apply to Parakkat today, regardless of what the software supports. Each is presented as: what it is, why it matters, rough build complexity, and sourcing. Items are ordered roughly by combined legal-risk × likely-current-gap.

## A.0 Cross-cutting note: Multi-entity, multi-branch shape of every obligation

Before the individual items: almost every one of the obligations below has a different "unit of compliance" — and getting this wrong is the biggest structural risk to the software's data model, not any single rate or form.

| Obligation | Unit of compliance |
|---|---|
| EPF | Per legal entity (branches of one entity are pooled under Section 2A of the EPF Act) |
| ESI | Per legal entity |
| TDS (Section 192) | Per legal entity (each needs its own TAN) |
| Kerala Professional Tax | Per employee, per **local body** of their branch (~46 branches ≈ up to 46 different Panchayat/Municipality/Corporation remittance destinations) |
| Gratuity | Per legal entity, per employee's continuous service with that entity |
| Bonus Act | Per legal entity |
| Kerala Shops & Commercial Establishments Act | Per branch (each branch is its own registered "establishment") |
| POSH Act | Per branch/location that crosses 10 employees (see A.9) |
| Maternity Benefit Act crèche duty | Per legal entity (50+ employee threshold) |

**Recommendation:** the compliance module needs both an **entity dimension** and a **branch↔local-body mapping dimension** as first-class data, not a single flat "company" setting. This is the architectural implication that runs through nearly every item below.

Sources: [Section 2A, EPF Act — aaptaxlaw.com](https://www.aaptaxlaw.com/epf-act-1952/section-2a-epf-act-1952-establishment-to-include-all-departments-and-branches-section-2a-employees-provident-funds-miscellaneous-provisions-act-1952.html); [Clubbing of Units under Labour Laws — SCC Times, Sep 2025](https://www.scconline.com/blog/post/2025/09/24/clubbing-of-units-labour-laws-judicial-trends/); [Kerala Shops and Establishment Registration — IndiaFilings](https://www.indiafilings.com/learn/kerala-shops-and-establishment-registration).

---

## A.1 EPF (Employees' Provident Fund) — HIGH PRIORITY

**What it is:** Mandatory retirement-savings contribution under the EPF & Miscellaneous Provisions Act, 1952, for any establishment with 20+ employees. Employee contributes 12% of (basic+DA); employer contributes 12%, split 3.67% EPF + 8.33% EPS (capped at ₹1,250/month, based on the ₹15,000 wage ceiling) + 0.5% EDLI. Mandatory coverage applies up to ₹15,000/month basic+DA; above that, coverage is either voluntary or by employer policy (many employers cover all staff regardless). A **monthly ECR (Electronic Challan-cum-Return)** must be filed by the 15th of the following month, tied to each employee's UAN. A revamped ECR format took effect from wage month September 2025.

**Why it matters:** Non-filing/late filing draws damages and interest under Section 14B/7Q of the Act; each of Parakkat's three-to-four legal entities, given the group's combined 242 headcount, is almost certainly independently above the 20-employee threshold and mandatorily covered.

**Complexity:** Medium-High. Requires a per-entity contribution engine, UAN master data, wage-ceiling logic, and ECR 2.0-format file generation per entity per month. A real complication: following the Supreme Court's November 2022 ruling in *EPFO v. Sunil Kumar B.*, some employees may be entitled to opt for EPS contribution on actual (uncapped) wages rather than the ₹15,000 cap — this "higher pension" option needs to be modeled as an employee-level flag, not a global rule.

**Sources:** [EPFO — About EPFO](https://www.epfindia.gov.in/site_en/AboutEPFO.php); [EPFO — Introduction to ECR Version II](https://www.epfindia.gov.in/site_docs/PDFs/EPFOUnifiedPortal/Introduction_ECR2.0.pdf); [PF Contribution Rate 2026 — SalaryBox](https://salarybox.in/blog/pf-contribution-rate-2026-employer-employee-calculation-rules-exemptions/); [EPFO v. Sunil Kumar B., SC, 4 Nov 2022 — Indian Kanoon](https://indiankanoon.org/doc/14993351/). *(EPF rate/ceiling figures independently cross-checked via a second search pass, July 27, 2026 — consistent across sources.)*

---

## A.2 ESI (Employees' State Insurance) — HIGH PRIORITY

**What it is:** Health/social insurance for employees earning up to ₹21,000/month gross (₹25,000 for employees with disabilities), contribution 4% of wages total — employer 3.25%, employee 0.75%, unchanged since 1 July 2019. Kerala has been fully notified for ESI across all 14 districts since 1 February 2017, so location is not a barrier anywhere Parakkat operates. Applicability for shops/commercial establishments is by state notification; most states including Kerala have reduced the threshold to 10+ employees, though we could not independently pull the specific Kerala gazette setting this figure (flagged below). Monthly contribution filing is due by the 15th of the following month; a NIL return is required even when no contribution is payable.

**Why it matters:** Given Kerala's minimum wage bands for retail/shop staff (see A.7) frequently sit below or near the ₹21,000 ceiling, a large share of Parakkat's sales executives, cleaning staff, drivers, and possibly junior shop-in-charges are likely ESI-eligible. Non-registration/non-remittance carries penal interest and, in serious cases, prosecution risk.

**Complexity:** Medium. Similar shape to EPF — per-entity contribution engine and monthly return, but simpler wage-band logic (single ceiling, no analogous "higher option" complexity).

**Sources:** [ESI Contribution Rate 2026 — Tally Solutions](https://tallysolutions.com/business-guides/esi-contribution-rate-2026-current-percentage-for-employer-employee/); [ESIC Regional Office, Thrissur — About Us (Kerala coverage history)](https://rokerala.esic.gov.in/ro-sro-about-us); [ESI Salary Limit 2026 — futurexsolutions.com](https://futurexsolutions.com/esi-salary-limit-2026/). **Flagged for direct verification:** the exact Kerala gazette notification setting the 10-employee shops-and-establishments threshold, and the precise half-yearly ESIC return due dates (secondary sources gave inconsistent dates) — pull the ESIC "Standard Note on ESI Scheme as on 01.01.2025" directly from esic.gov.in before finalizing.

---

## A.3 Professional Tax — KERALA SPECIFIC — HIGH PRIORITY, HIGHEST OPERATIONAL COMPLEXITY

**What it is:** Kerala has **no standalone Professional Tax Act.** PT is levied under **Section 200 of the Kerala Panchayat Raj Act, 1994** (and the equivalent Kerala Municipality Act provision) by the local self-government body — Panchayat, Municipality, or Corporation — where each employee works, not by the state itself. Rates were revised via **G.O. (Sadha) No. 1149/2024/LSGD, dated 27 June 2024, effective 1 October 2024**, on a half-yearly income slab basis, deducted by the employer:

| Half-yearly income (₹) | Half-yearly PT (₹) |
|---|---|
| Up to 11,999 | Nil |
| 12,000 – 17,999 | 320 |
| 18,000 – 29,999 | 450 |
| 30,000 – 44,999 | 600 |
| 45,000 – 99,999 | 750 |
| 1,00,000 – 1,24,999 | 1,000 |
| 1,25,000 and above | 1,250 |

Returns/remittance are **half-yearly** (roughly April–September due by 31 August; October–March due by 28 February — exact dates should be pinned against the LSGD circular directly, see flag below).

**Why it matters:** This is the item with the widest gap between "simple on paper" and "hard to build," because of Parakkat's branch footprint. With ~46 branches likely spread across dozens of different Panchayats/Municipalities/Corporations, PT is not one filing — it is potentially **dozens of separate remittances to dozens of different local authorities**, each an independent registrant relationship. This is very unlikely to be something the current payroll engine's "configurable scoped deductions" already models correctly, since it needs a location-aware routing layer, not just a rate table.

**Complexity:** High. Needs: (1) a branch → local-body master table, (2) the uniform state slab engine, (3) per-local-body remittance/return tracking, (4) half-yearly cycle logic distinct from EPF/ESI's monthly cycle.

**Sources:** [Professional Tax Kerala — ClearTax](https://cleartax.in/s/professional-tax-kerala); [Kerala Professional Tax Updation October 2024 — Dictum & Netlc](https://www.dictumnetlc.com/kerala-professional-tax/); [Gazette notification on revision of PT rate in Kerala — Simpliance](https://www.simpliance.in/statutory-notifications/kerala/notification-regarding-revision-of-professional-tax-rate-in-kerala); [Kerala Panchayat Raj Act, 1994 — full text, IndiaCode](https://www.indiacode.nic.in/bitstream/123456789/17251/1/the-kerala-panchayat-raj-act-1994.pdf). **Flagged:** two conflicting secondary slab tables were found (an older, undated greythr table with lower figures appears stale); the table above reflects the post-2024-revision figures cross-checked against the named, dated G.O. — but the exact G.O. text should be pulled directly before this table is hard-coded, and the annual-vs-half-yearly figure inconsistency in one source (₹600×2 vs. a stated ₹900 annual figure for one slab) should be resolved against the primary notification.

---

## A.4 TDS on Salaries (Section 192, Income Tax Act) — HIGH PRIORITY

**What it is:** Employers must deduct tax at source on salary income, deposit it by the 7th of the following month (30 April for March), issue **Form 16** by **15 June** following the financial year, and file quarterly **Form 24Q** returns (FY2025-26 due dates: 31 Jul 2025, 31 Oct 2025, 31 Jan 2026, 31 May 2026). Since FY2023-24, the **new tax regime is the default** for payroll TDS (CBDT Circular 4/2023) — every employee must be asked, once per financial year, which regime they want used for TDS purposes (a mandatory intimation workflow distinct from the investment-declaration **Form 12BB**, which only matters if an employee opts for the old regime). Under the new regime for FY2025-26, salaried employees owe zero net tax up to roughly ₹12.75 lakh gross (₹12 lakh Section 87A rebate threshold + ₹75,000 standard deduction).

**Why it matters:** Late Form 24Q filing draws a ₹200/day fee (Section 234E) and penalties up to ₹1,00,000 (Section 271H); late Form 16 issuance draws ₹100/day. Given Parakkat's staff mix, most non-managerial employees will likely owe little or no tax under the new regime, but zonal/regional managers and accountants will need active computation, and any employee choosing the old regime needs Form 12BB-driven deduction tracking.

**Complexity:** High. This is the most computationally involved item — dual-regime slab logic, annual regime-intimation workflow, Form 16 (Parts A & B) generation, TRACES-compatible Form 24Q/FVU file generation, and correct handling of employees who transfer between Parakkat's own legal entities mid-year (each entity needs its own TAN and its own Form 24Q; a transferred employee effectively needs treatment similar to a job change for TDS purposes).

**Sources:** [Section 192 of the Income Tax Act — TaxBuddy](https://www.taxbuddy.com/blog/section-192-tds-on-salary); [Form 24Q Due Dates FY2025-26 — 5paisa](https://www.5paisa.com/stock-market-guide/tax/form-24q); [CBDT Circular 4/2023 summary — CAclubindia](https://www.caclubindia.com/articles/cbdt-issued-circular-on-tds-for-salaries-in-fy-2023-24-what-you-need-to-know-49458.asp); [Income Tax Slabs FY2025-26 — Axis Max Life](https://www.axismaxlife.com/blog/tax-savings/income-tax-slab-2025-26). **Flagged:** the FY2025-26 slab table and rebate figures are cross-checked across multiple secondary sources with consistent numbers, but could not be directly verified against incometax.gov.in in this pass — confirm against the official Finance Act 2025 notification before hard-coding.

---

## A.5 Gratuity (Payment of Gratuity Act, 1972) — MEDIUM-HIGH PRIORITY

**What it is:** A lump-sum payment to employees with 5+ years of continuous service on exit (waived for death/disability), calculated as (last drawn basic+DA) ÷ 26 × 15 × years of service, payable within 30 days of the triggering event, tax-exempt up to ₹20 lakh (Section 10(10)). Applies once an establishment has employed 10+ people on any day in the preceding 12 months (coverage persists even if headcount later drops).

**Why it matters — the part software teams often miss:** the Act itself only requires *payment* within 30 days of exit; it does not require ongoing accrual. But **accounting standards (AS 15 / Ind AS 19) require the liability to be actuarially valued and expensed progressively as a defined-benefit obligation**, and under **Section 40A(7) of the Income Tax Act, a mere book provision is not tax-deductible** — only actual payments or contributions to an **approved gratuity trust** are. This means the software's job is really two things: (1) track continuous service per employee per legal entity precisely enough to compute eligibility and the exit-trigger payment, and (2) surface the data an external actuary needs for the annual valuation — not attempt the actuarial valuation itself.

**Complexity:** Medium for the eligibility/payment-trigger piece (straightforward formula, standard exit-workflow integration); the actuarial valuation itself is out of scope for software and should stay with an external actuary/insurer (commonly LIC-administered gratuity trusts in India).

**Sources:** [Payment of Gratuity Act, Section 4 — IndianKanoon](https://indiankanoon.org/); [Gratuity Calculator/exemption — ClearTax](https://cleartax.in/s/gratuity-calculator); [AS-15 applicability — Kapadia & Kochrekar](https://kacindia.com/knowledge/applicability-as15); [Section 40A(7) gratuity provisioning — TaxGuru](https://taxguru.in/income-tax/understanding-gratuity-provisions-under-income-tax.html).

---

## A.6 Payment of Bonus Act, 1965 — MEDIUM PRIORITY

**What it is:** Mandatory annual bonus for employees earning up to ₹21,000/month who worked 30+ days in the accounting year, at minimum 8.33% (maximum 20%) of "bonus wage" — calculated on actual wages if ≤₹7,000/month, or capped at ₹7,000/month for calculation purposes if wages are between ₹7,000–21,000. Payable within 8 months of the financial year close (commonly by 30 November). Applies once 20+ employees are on the rolls on any day in the accounting year.

**Why it matters:** Bonus registers (Forms A, B, C) and an annual return (Form D) are statutorily required and — unlike Gratuity — this is a routine, guaranteed annual payroll-engine output, not an exit-triggered one, so it should be a natural extension of the existing payroll run rather than a separate system.

**Complexity:** Low-Medium. The eligibility/ceiling logic is well-defined; the main design decision is how "wages" is defined for commission-heavy sales-staff pay structures, which should be flagged for legal review rather than assumed.

**Sources:** [Payment of Bonus Act summary — TeamLease RegTech](https://teamleaseregtech.com/blogs/149/decoding-the-code-on-wages-2019); [Bonus Act eligibility/rates — Qandle](https://qandle.com/blog/payment-of-bonus-act). **Flagged:** the "₹7,000 or minimum wage, whichever is higher" calculation-ceiling proviso mentioned in some sources was not independently confirmed against the Act's amended text in this pass.

---

## A.7 Kerala Shops and Commercial Establishments Act, 1960 — HIGH PRIORITY (largest register/return burden)

**What it is:** Governs working hours (8 hrs/day, 48 hrs/week, spread-over capped near 10.5 hrs), overtime (total daily hours capped at 10, quarterly OT capped at 50 hours, paid at double rate), a mandatory weekly holiday, and statutory leave after 12 months' service (12 days earned leave accruable to 24, 12 days sick leave, 12 days casual leave) — plus a related Act, the Kerala Industrial Establishments (National and Festival Holidays) Act, mandating 13 paid holidays/year. Each shop is registered as its own "establishment" with the local labour office (registration renewed annually), and 10+ employee establishments file a **quarterly Form H return**. A 2018 amendment permits women to work night shifts (9pm–6am) subject to conditions (minimum 5 staff present with 2+ women, employer-arranged transport, seating).

**Why it matters:** This is the Act most directly governing day-to-day shop operations, and with ~46 branches, it very likely means **~46 separate establishment registrations, 46 renewal cycles, and — for any branch independently crossing 10 employees — 46 separate quarterly Form H filings**. This is a large, recurring administrative burden that the software could meaningfully reduce even though it can't eliminate the government-facing filing step itself.

**Complexity:** Medium. Much of this extends functionality the software already has (shift definitions, weekly-offs, holiday calendars, leave management) rather than requiring new domain logic — the work is adding OT-rate computation, register/Form H generation, and per-branch registration-renewal tracking.

**Sources:** [Labour Laws in Kerala 2026 — Asanify](https://asanify.com/blog/labour-laws/labour-laws-in-kerala-2026-minimum-wages-working-hours-benefits/); [Kerala Shops and Commercial Establishments Act — Keka compliance wiki](https://www.keka.com/compliance/acts/kerala-shops-and-commercial-establishments-act-1960); [Kerala amends Shops Act — women's night shifts, 2018 — The News Minute](https://www.thenewsminute.com/article/kerala-amends-shops-and-establishment-act-women-can-now-work-night-shifts-84194); [Kerala Shops and Establishment Registration — IndiaFilings](https://www.indiafilings.com/learn/kerala-shops-and-establishment-registration). **Flagged:** exact register form-letters (A/B/BB/D/E/F) and the precise Form H due-date, plus whether registration is legally mandated per-branch, rest on secondary compliance-vendor summaries — the primary Rules PDF (lc.kerala.gov.in) could not be machine-parsed in this research; confirm with Kerala Labour Commissionerate or counsel before finalizing the data model.

---

## A.8 Maternity Benefit Act, 1961 (as amended 2017) — MEDIUM PRIORITY

**What it is:** 26 weeks' paid maternity leave (12 weeks for a third child), for women who worked 80+ days in the preceding 12 months, at establishments with 10+ employees. Establishments with **50+ employees** must provide a crèche with 4 permitted visits/day. Post-leave work-from-home is an employer option (not mandatory) under Section 5(5).

**Why it matters:** All Parakkat entities are well above the 10-employee threshold. The 50-employee crèche threshold is worth checking **per legal entity** — if any single entity (not branch) crosses 50 employees, a crèche obligation likely attaches, which for a distributed retail workforce is typically handled via a centralized facility near head office plus a documented policy, rather than a crèche per branch — though this should be confirmed with counsel since the exact "prescribed distance" geography rules were not fully verifiable in this research.

**Complexity:** Low for the software (a leave-type + eligibility-rule addition to the existing leave engine); the crèche obligation itself is a facilities/policy decision outside the software's scope, though entity-level headcount monitoring to flag when the threshold is crossed is a natural software feature.

**Sources:** [The Maternity Benefit Act — iPleaders](https://blog.ipleaders.in/the-maternity-benefit-act); [Maternity Benefit Act applicability — indialawoffices.com](https://indialawoffices.com); [Section 5, Maternity Benefit Act — IndianKanoon](https://indiankanoon.org/doc/1130021).

---

## A.9 POSH Act, 2013 — HIGH PRIORITY given branch count (highest compliance-exposure item found)

**What it is:** Any workplace with 10+ employees (including contract/daily-wage staff) must constitute an Internal Complaints Committee (ICC). Legal-practitioner sources are consistent that **a single head-office ICC does not legally cover other branches/locations** — each administrative unit crossing the threshold needs its own ICC, and a January 2026 case reportedly saw an entire ICC proceeding invalidated at a retail chain because a branch-level committee member's term had lapsed. The ICC must file an **annual report with the District Officer having jurisdiction, by 31 January** — and if branches span multiple districts, **separate reports must go to each district's officer**; a head-office filing does not substitute. Employers must also display the POSH policy, run awareness training, and support ICC capacity-building (Section 19); non-compliance risks penalties up to ₹50,000 and escalating consequences on repeat violations.

**Why it matters for Parakkat specifically:** With ~46 branches across Kerala's 14 districts, this is very plausibly the single highest legal-exposure item in this whole report if handled incorrectly — it requires per-branch ICC composition and member-term tracking (the exact failure mode in the cited invalidation case) and district-wise (not centralized) annual report filing. A practitioner-recommended "Apex Committee + local committees" model exists for scaling this across locations, but this is convention, not settled statute — confirm the structure with counsel before the data model is finalized.

**Complexity:** Medium. Mostly a data-tracking problem (per-branch ICC composition, member term expiry alerts, confidential complaint register, training-completion logs, draft report generation mapped to Kerala's revenue districts) rather than a computational one — but the legal-risk-per-unit-of-effort is arguably the highest of any item in this report.

**Sources:** [Unifying Protection: Internal Committee Across Multiple Locations — MMJC](https://mmjc.in/unifying-protection-internal-committee-across-multiple-locations); [One Company, Multiple ICs: Decoding the POSH Act's "Every Location" Rule — PoshExpertSolutions](https://poshexpertsolutions.com/post/one-company-multiple-ics-decoding-the-posh-act-s-every-location-rule); [Annual POSH Compliance Report — Keka](https://www.keka.com/compliance/forms/annual-posh-compliance-report).

---

## A.10 Labour Codes 2020 — MONITOR, DO NOT BUILD TO YET (Kerala-specific finding)

**What it is:** The four Labour Codes (Wages, Industrial Relations, Social Security, OSH) were notified nationally on 21 November 2025, with central rules finalized by May 2026. **However, Kerala's Labour Minister V. Sivankutty has publicly and explicitly stated Kerala will not implement the new labour codes**, calling them "anti-worker," and confirmed the state's December 2021 draft rules "will remain a draft." Kerala convened a "Labour Conclave" with trade unions and other states' labour ministers around 19 December 2025 to explore alternatives [ThePrint, 2026]. Kerala's own Labour Commissionerate site (lc.kerala.gov.in, last updated 5 May 2026) lists final central-code texts and draft state rules, but does not confirm state-rule finalization, and this is consistent with the Minister's public position.

**Why it matters:** Until Kerala notifies its own state rules — which the state government has signaled it may never do in its current political form — **the existing central Acts (EPF, ESI, Payment of Bonus, Payment of Gratuity, Kerala Shops & Commercial Establishments Act) remain the operative compliance regime** for a Kerala employer, not the new Codes. The most consequential prospective change if Kerala ever does adopt them is the Code on Wages' "50% rule" (at least 50% of CTC must be basic+DA for PF/gratuity computation purposes) and a reported 2-working-day full & final settlement deadline (Section 17(2)) — neither of which should be built as a current requirement, but both of which the payroll engine's wage-definition and exit-settlement logic should be **architecturally ready to switch to** via configuration rather than a rebuild.

**Complexity:** N/A (no build required now) — but this materially de-risks over-engineering the Labour Codes into the software today, and argues for configurable wage-definition and settlement-timeline logic as a general design principle rather than a Labour-Codes-specific feature.

**Sources:** [Why Kerala is pushing back against Centre's new labour codes — ThePrint, 2026](https://theprint.in/india/governance/why-kerala-is-pushing-back-against-centres-new-labour-codes/2793520/); [Kerala Labour Commissionerate — What's New (updated 5 May 2026)](https://lc.kerala.gov.in/en/whats-new); [Kerala government under fire after draft linked to Centre's labour codes surfaces — Deccan Herald](https://www.deccanherald.com/india/kerala/kerala-government-under-fire-after-draft-linked-to-centres-labour-codes-surfaces-3810821); [Labour Codes 2026 Implementation: Complete Guide — iPleaders](https://blog.ipleaders.in/labour-codes-2026-implementation-complete-guide-to-what-is-in-force-what-changed-and-what-to-do-now/); [2-day full and final settlement under Labour Codes — Nexdigm](https://www.nexdigm.com/inthenews/2-day-full-and-final-settlement-post-employees-resignation-now-mandatory-under-labour-codes-what-it-means-for-employers/). **This is an actively developing political situation — re-verify before relying on it for any go-live decision.**

---

## A.11 Minimum Wages in Kerala — MEDIUM PRIORITY, TWO DIFFERENT CATEGORIES APPLY

**What it is:** Kerala sets minimum wages by "scheduled employment" category, revised roughly every six months via CPI-linked VDA. Two categories are directly relevant to Parakkat: **(1) "Shops and Commercial Establishments"** — covers sales staff, shop-in-charges, accountants, drivers, cleaning staff; **(2) "Manufacture of Gold and Silver Ornaments"** — a distinct, separate scheduled employment specifically covering goldsmiths/craft artists at the factory/production unit, most recently revised via **G.O.(P) No.9/2026/LBR, dated 3 February 2026**, with reported monthly ranges of roughly ₹17,940–₹21,360 plus **piece-rate wages** tied to the weight and complexity of gold/silver articles worked.

**Why it matters:** Applying one blanket minimum wage across all 242 employees would be incorrect — goldsmiths/craft artists are legally a separate wage category from retail staff, with piece-rate components layered on top of time-rated wages.

**Complexity:** Medium. Requires (1) an employee-to-scheduled-employment-category classification field, (2) a dated, versioned minimum-wage table per category (not a hardcoded constant, since it revises roughly every 6 months), and (3) piece-rate wage support for the gold/silver manufacturing category specifically — a genuinely different pay-computation model from the salaried/hourly logic the payroll engine likely already has.

**Sources:** [Kerala goldsmith/silver-ornament minimum wage revision — TeamLease RegTech](https://teamleaseregtech.com/updates/article/52956); [Kerala minimum wage summaries — CiteHR / wageindicator.org]. **Flagged — significant gap:** current, complete rupee figures for the general "Shops and Commercial Establishments" category could not be extracted from primary PDFs in this research (repeated fetch failures); only a stale 2016 base figure was recoverable. **Do not use any minimum-wage figure in this report as current** — pull the live notification from lc.kerala.gov.in directly before the software encodes any wage floor.

---

## A.12 Consolidated Statutory Registers & Returns — what can the software actually generate?

| Law | Registers to maintain | Returns to file | Frequency / to whom | Software-generatable? |
|---|---|---|---|---|
| Kerala Shops & Commercial Establishments Act | Employment register, service record, working-hours record, leave/holiday register | Quarterly Form H (10+ employee branches) | Local Labour Office, before 10th of month after quarter | Registers/draft return: yes. Filing: manual per branch. |
| Shops Act registration | Registration certificate per branch | Annual renewal | Local competent authority, per branch | Reminders/tracking: yes. Renewal itself: manual. |
| Payment of Bonus Act | Forms A/B/C (surplus, set-on/set-off, bonus paid) | Annual Form D | Inspector, ~30 days after payment | Yes — natural payroll-engine output. |
| Payment of Gratuity Act | Nomination records (Form F), notice of opening (Form A) | Exit-triggered notices | Controlling Authority | Tracking: yes. Actuarial valuation: external actuary required. |
| Maternity Benefit Act | Register of women availing benefit | Exit/claim-triggered | Internal/on demand | Yes. |
| POSH Act | ICC constitution order (per branch), complaints register, training log | Annual report (per district) | District Officer, by 31 Jan, per district | Data aggregation/draft: yes. Filing: manual, must not be centralized. |
| EPF | Employee master with UAN, wage register | Monthly ECR | EPFO portal, by 15th of following month | Yes — standard payroll-software output; portal submission can sometimes be API-integrated. |
| ESI | Employee register with IP numbers | Monthly contribution + periodic return | ESIC portal | Yes. |
| Minimum Wages (via Shops Act enforcement) | Wage register, overtime register | N/A | — | Yes, contingent on keeping the rate table current. |

**Pattern:** registers, computations, and draft returns are almost entirely in scope for the in-house build. Actual government-portal filing, physical registration renewals, POSH District Officer filings, and actuarial certification generally need either manual staff action or a portal-specific API integration layer — treat these as a distinct, later-phase workstream from the compliance calculation engine itself.

---

# PART B — TABLE STAKES IN INDIA (competitors all have it)

Benchmarked against greytHR, Keka, Zoho People/Payroll, Darwinbox, RazorpayX Payroll, and Kredily.

| Capability | Coverage | Note for Parakkat |
|---|---|---|
| PF/ESI/PT/TDS statutory calculation | 6/6 — universal, even on free tiers | Baseline; Part A above is the equivalent build list. |
| PF ECR file generation | 6/6 confirmed or strongly implied | Matches A.1. |
| TDS challan + Form 16 generation | 6/6 | Matches A.4. |
| Form 24Q generation | 6/6, automation depth varies | Matches A.4. |
| State-wise Professional Tax auto-calculation | 6/6 | All 6 handle 15+ states' PT natively — Kerala's local-body-routing complexity (A.3) is the one place even commercial vendors likely just apply the state slab and leave local-body remittance to the client. |
| Employee self-service (ESS) mobile app | 6/6 | Standard expectation in the Indian market; confirm current state of Parakkat's own ESS/mobile coverage. |
| **Automatic rate/rule updates when government changes PF/ESI/PT/TDS** | Marketed as standard 6/6, but **execution gaps exist even at top vendors** — Darwinbox reportedly needs a support ticket for state LWF slab changes rather than self-serve; greytHR's own compliance guidance warns un-patched installs can generate a Form 24Q rejected by TRACES' updated schema | **This is the single biggest ongoing-maintenance argument for a commercial product over a custom build** — every rate in Part A changes periodically (PT rates revised 2024, minimum wages ~6-monthly, income tax slabs annually) and someone has to own watching for and shipping each change. For Parakkat's build, this should become an explicit ownership responsibility (a person + a review cadence), not an assumption that "it's built once." |

**Common but not universal / frequently tier-gated:**

- **True multi-entity/multi-branch consolidation** — often an Enterprise-tier add-on (greytHR gates "group company support" to its top tier; Kredily gates it entirely to a custom Enterprise plan). Darwinbox is the strongest at this, explicitly built for organizations running 15–25 legal/organizational units. **Parakkat's in-house system already has this natively, at no tier premium — this is a genuine structural advantage of the custom build, worth recognizing explicitly rather than treating everything in this report as a gap.**
- **Document management + e-signature** — present on the four full-suite HRMS platforms (Zoho via Zoho Sign/Adobe Sign/DocuSign, Keka native e-sign, greytHR letter generation, Darwinbox); absent on the two payroll-only tools.
- **Appraisal/performance review cycles** (360, OKR) — present on all four full-suite platforms, absent on the two payroll-only tools. This matches Parakkat's own stated gap (goals/KRAs exist, no formal review cycles).
- **Loan/salary-advance management & F&F settlement automation** — commonly available but often gated to higher tiers (greytHR Enterprise, Kredily Enterprise). See Part C for detail — this is also a genuine gap for Parakkat today.
- **Shift rostering** — universally present at a basic level, but true retail-grade rostering (demand-based, multi-location, swap workflows) is unevenly executed even among the majors.
- **WhatsApp/chat notifications** — a real, named feature at Zoho People and Darwinbox specifically (not just a marketing claim — see Part C), but not confirmed as universal across all six.

**A gap across all six commercial platforms, not just Parakkat's build:** none offer a dedicated sales-incentive/commission engine. That capability sits in a separate software category (incentive compensation management) globally, not inside HR/payroll suites. **This means build-vs-buy is moot for this specific feature — Parakkat would have to build or separately buy this regardless of any HR SaaS decision.**

### Indicative pricing (for build-vs-buy judgment; see full source list for caveats on which figures are official vs. third-party)

| Platform | Entry pricing (per official/primary source where available) | Compliance depth | Multi-entity | Jewellery/retail evidence |
|---|---|---|---|---|
| greytHR | ₹2,495/mo (first 50 employees) + ₹45/employee above 50 (Essential); Enterprise custom | Strong (ECR, Form 16/24Q) | Top tier only | Hillson Footwear (multi-branch footwear retail) — no jewellery client found |
| Keka | ~₹9,999/mo (up to 100 employees), third-party sourced — official page not directly fetchable | Strongest claimed automation of the six | Not confirmed as native/free | Oliva (23-branch clinic chain), R for Rabbit — no jewellery client found |
| Zoho People / Payroll | People: ₹50–230/employee/mo; Payroll: free ≤10 employees, then from ₹1,250/mo (25 employees) | Strong, tier-gated digital signature on Form 16 | Not a headline feature | No HR-platform jewellery client; Zoho Creator (different product) has a Chennai jewellery manufacturer case study |
| Darwinbox | No public pricing; third-party estimates ₹200–600 PEPM | Broadest claimed stack (incl. POSH, gratuity, NPS) | Strongest of the six — built for 15–25 org units | None found; positioned for 500+ employee enterprises |
| RazorpayX Payroll | ₹2,499/mo (≤20 employees, Prime); ₹5,499/mo (≤100, Elite) | Strong, auto-files Form 24Q by default | Not a focus | None found; customer base skews startup/fintech-adjacent |
| Kredily | Free (unlimited employees, calculation only); ₹1,249/mo unlocks challans/Form 16 | Weakest documented depth of the six paid tiers | Enterprise tier only | None found |

**No jewellery-sector adoption evidence exists for any of the six platforms** — this is itself informative: jewellery retail is not a well-trodden vertical for Indian HR SaaS marketing, so Parakkat isn't missing an obvious off-the-shelf fit by building in-house.

---

# PART C — HIGH VALUE FOR THIS SPECIFIC BUSINESS

## C.1 Shift rostering / demand-based scheduling for variable branch staffing

**What it is:** Multi-location roster planning by department/designation/branch, with shift-swap workflows and (in more advanced tools) demand/footfall-based auto-scheduling. Parakkat's system has shift *definitions* and weekly-offs but not roster planning, forecasting, or swap workflows.

**Why it matters:** With ~46 branches of presumably differing footfall (flagship showroom vs. small-town branch), a single company-wide staffing template over- or under-staffs most locations most of the time; this compounds during festival season (see C.3).

**Complexity:** Medium — extends existing shift/attendance infrastructure rather than requiring a new domain.

**Sources:** [Zoho People — Employee Shift Management](https://www.zoho.com/people/employee-shift-management-software.html); [SalaryBox — Shift Scheduling & Roster Management for Multi-Shift Indian Businesses](https://salarybox.in/blog/shift-scheduling-roster-management-for-multi-shift-indian-businesses-complete-guide-2026/); [SmartShifts — Best Retail Store Scheduling Software for Multi-Location Chains](https://smartshifts.com/best-retail-store-scheduling-software-for-multi-location-chains-in-2026/).

## C.2 Sales incentive / commission calculation

**What it is:** No India-specific jewellery-sector commission data exists publicly (Tanishq/Kalyan/Malabar structures are not published) — this is a confirmed research gap, not an oversight. The best available proxy is general organized-retail practice: **target-based, tiered/slab commission** (higher % above a volume threshold) is more common than flat-percentage commission, sometimes blended with team-level pooled bonuses. US jewellery-specific trade sources (not directly transferable to India) describe commission ranging 5–20% of sale price, or hybrid models like base + 1% on repairs + 2% on product sales.

**Why it matters:** Highly relevant to jewellery retail specifically per the brief, and confirmed as a genuine gap: none of the six benchmarked HR SaaS platforms in Part B offer a commission engine either — it's a distinct software category everywhere, in India and globally.

**Complexity:** Medium-High — not because the math is hard, but because Parakkat will need to define its own commission policy (no external benchmark exists) before building against it; recommend this as a scoping/policy exercise with sales leadership before engineering work starts.

**Sources:** [JCK — The Savvy Jeweler's Guide to Compensation Packages](https://www.jckonline.com/article-long/jewelers-guide-to-compensation/) (US market, not India); [RetailDogma — Retail Incentive Program: Types, Examples & Considerations](https://www.retaildogma.com/retail-incentive-program/); [Xoxoday — Retail Commission Percentage: Best Models & Rates](https://blog.xoxoday.com/compass/retail-agents-sales-commission/).

## C.3 Attendance edge cases: multi-branch staff, festival overtime, split shifts

**Verified:** Kerala Shops Act overtime rules apply generically (daily cap 10 hrs incl. OT, quarterly OT cap 50 hrs, double-rate pay — see A.7); Onam and Akshaya Tritiya are confirmed as major Kerala/national jewellery-buying peaks, with Kalyan Jewellers reporting a 31% sales surge in an Akshaya Tritiya/wedding-season quarter and other jewellers reporting 30–40% jumps around Akshaya Tritiya specifically.

**Explicit gap found:** despite extensive searching, **no source anywhere connects Kerala's jewellery festival-buying seasons to documented staffing or overtime practice** — this appears to be genuinely undocumented, ad hoc industry practice governed only by the generic Shops Act overtime caps above, with no festival-specific carve-out. Similarly, no source addresses the specific scenario of an employee *informally* covering a second branch for a few days (as distinct from a formal transfer) — only formal transfer handling is vendor-documented.

**Why it matters:** This means Parakkat cannot benchmark against a known "best practice" here — the software needs to support the generic OT-cap/double-pay mechanics correctly (a compliance requirement, A.7) and give management a location-level cost/staffing view during known peak periods (Onam, Akshaya Tritiya, wedding season), but the specific policy choices are Parakkat's own to make, not an industry standard to copy.

**Complexity:** Low-Medium for the OT-compliance mechanics (extends A.7); Medium for a genuinely useful "temporary cross-branch coverage" attribution model, since no existing pattern to follow was found — recommend a simple actual-worked-branch field distinct from home-branch, feeding location-level cost reports.

**Sources:** [Kalyan Jewellers — Onam](https://www.kalyanjewellers.net/blog/onam-the-golden-grace-of-keralas-grand-festival/); [Storyboard18 — Kalyan Jewellers 31% sales surge, Akshaya Tritiya/wedding season](https://www.storyboard18.com/brand-marketing/wedding-season-akshaya-tritiya-spark-31-sales-surge-for-kalyan-jewellers-in-q1-73198.htm); [Business Standard — Jewellers see 40% jump in sales on Akshaya Tritiya](https://www.business-standard.com/amp/article/pti-stories/jewellers-see-40-jump-in-sales-on-akshaya-tritiya-this-year-117042801246_1.html).

## C.4 Employee self-service (ESS) mobile app

**What it is:** Payslip download, leave application/approval, attendance regularization requests, document access, holiday calendar — now standard functionality across mainstream Indian HRMS vendors (see Part B).

**Why it matters:** Qualitatively well-supported as table-stakes; **quantitative adoption statistics found in vendor marketing (e.g., an "81% expect ESS like online banking, Deloitte 2024" claim) could not be verified against an actual Deloitte report and should not be cited as fact** — the conclusion that ESS is now expected stands on vendor feature-parity evidence, not a verified survey statistic. Recommend confirming Parakkat's current mobile/ESS coverage internally, since the brief did not explicitly confirm what exists today.

**Complexity:** Low-Medium if extending an existing web app to mobile-responsive/PWA; higher if a native app is wanted.

**Sources:** [HROne — Employee Self-Service Portal: What Features Should Your HRMS Have?](https://hrone.cloud/blog/employee-self-service-portal-hr-software-india/); [SalaryBox — Top 10 HRMS Software with ESS Portals in India for 2026](https://salarybox.in/blog/top-10-hrms-software-with-employee-self-service-ess-portals-in-india-for-2026/).

## C.5 WhatsApp-based notifications

**What it is:** A confirmed, named feature (not just an SMB gimmick) at established vendors — **Zoho People** lets managers approve leave/attendance-regularization requests directly from WhatsApp; **Darwinbox** markets itself as the first HR platform to integrate WhatsApp for Business for approval workflows, claiming it more than halves time-to-action on high-frequency approvals (a vendor claim, not independently verified). Smaller Indian payroll vendors also offer WhatsApp-based payslip delivery.

**Why it matters for Parakkat specifically:** given the workforce mix (sales executives, goldsmiths, cleaning staff, drivers), many staff are plausibly more WhatsApp-native than email-native — India has 500m+ WhatsApp users and it is the default communication channel for deskless/blue-collar workers specifically, per general market data (not Parakkat-specific, but a reasonable basis for prioritization).

**Complexity:** Medium — requires WhatsApp Business API access via an approved BSP (e.g., providers like MSG91), plus template-message approval workflows; not a simple "send a WhatsApp message" integration.

**Sources:** [Zoho Blog — Introducing the WhatsApp integration for Zoho People](https://blog.zoho.com/people/introducing-the-whatsapp-integration-for-zoho-people.html); [Darwinbox — First HR Tech Platform to Integrate with WhatsApp for Business](https://darwinbox.com/blog/darwinbox-becomes-the-first-ever-hr-tech-platform-to-integrate-with-whatsapp-for-business); [Sinch — Messaging apps in India: overview and statistics](https://sinch.com/blog/messaging-apps-in-india/).

## C.6 Document management and statutory retention

**What it is:** Indian labour law retention periods are scattered and inconsistent — **3 years** after the last entry for Payment of Wages Act and Minimum Wages Act registers; **5 years** for ESI records; **no specified period** for EPF Act, the Code on Wages, or the Payment of Bonus Act records (confirmed as a genuine statutory silence, not a research gap). Common industry practice (not law) is to retain everything for **7–8 years** as a safe buffer.

**Why it matters:** The software's document-retention policy should be built to the *longest* plausible requirement plus buffer, since several of the underlying Acts simply don't specify a period, and getting this wrong either way (deleting too early, or failing an audit request) carries different but real risks.

**Complexity:** Low — primarily a retention-policy configuration and archival-storage decision, not new functionality.

**Sources:** [Records Retention Obligations of Employer — greytHR](https://www.greythr.com/blog/records-retention-obligations-of-employer/); [Payment of Wages Act, Section 13A — AdvocateKhoj](https://www.advocatekhoj.com/library/bareacts/paymentofwages/13a.php). **Flagged:** Kerala Shops Act's specific retention period was not confirmed (primary Rules PDF unparseable in this pass).

## C.7 Full & Final (F&F) settlement automation

**What it is:** Final pro-rata salary, leave encashment, gratuity (if eligible), statutory bonus, minus deductions (notice recovery, loans, TDS). Historically 30–45 days was common industry practice; **Section 17(2) of the Code on Wages would mandate a 2-working-day settlement window if/when it applies** — but per A.10, Kerala has not adopted the Labour Codes, so this specific 2-day deadline is **not yet a Kerala legal requirement**, only a well-corroborated but Kerala-inapplicable-for-now data point.

**Why it matters regardless:** With 46 branches + factory + 4 legal entities, F&F today likely requires manual coordination across shop-in-charge (till/inventory), HR (leave/attendance), and zonal manager — automating the computation and adding a parallel clearance workflow (not sequential email chasing) is valuable on its own operational merits even without the 2-day legal trigger, and positions Parakkat well if/when Kerala eventually does adopt the Codes.

**Complexity:** Medium — mostly a workflow/clearance-tracking feature layered on data the payroll and asset-register modules likely already have.

**Sources:** [Full And Final Settlement (FnF) In India 2025 — QuikChex](https://quikchex.in/full-and-final-settlements/); [2-day F&F settlement under Labour Codes — Nexdigm](https://www.nexdigm.com/inthenews/2-day-full-and-final-settlement-post-employees-resignation-now-mandatory-under-labour-codes-what-it-means-for-employers/) (note applicability caveat above).

## C.8 Loan / salary advance management

**What it is:** Common informal/formal SMB benefit in India, especially relevant to lower-wage staff (cleaning staff, drivers, sales executives) needing short-term liquidity. Salary advances (a draw against earned wages, inherently interest-free, repaid over 1–3 cycles) are distinct from longer-term employer loans (often interest-free/concessional, repaid via salary deduction).

**Tax angle — important recent change, flagged for confirmation:** interest-free/concessional employer loans are a taxable perquisite under Rule 3(7)(i) [soon Rule 15(5)(a) under the new Income-tax Rules, 2026] unless the aggregate outstanding loan is below a "petty loan" exemption threshold. Two independent secondary sources report this threshold was **raised from ₹20,000 to ₹2,00,000** effective with the new Income-tax Act, 2025 (effective 1 April 2026) — but this could not be verified against a primary CBDT notification in this research and should be confirmed with a tax advisor before Parakkat relies on it to size a loan-benefit policy.

**Why it matters:** If accurate, this is a materially more useful benefit ceiling than before, and worth designing the loan-management module around once confirmed.

**Complexity:** Low-Medium — a loan ledger with salary-deduction repayment scheduling, largely additive to the existing payroll deductions engine.

**Sources:** [Wisemonk — Salary Advance Policy & Loans For Employees in India](https://www.wisemonk.io/blogs/salary-advance-policy-loans-for-employees-in-india); [TaxGuru — Taxability of concessional or interest-free loan perquisite](https://taxguru.in/income-tax/taxability-concessional-interest-free-loan-perquisite-employee.html); [EMI Calculator — Tax-Free Loans from Employer: How the Rules Have Changed?](https://emicalculator.net/tax-free-loans-from-employer-how-the-rules-have-changed/) (₹2,00,000 threshold — flagged as unconfirmed against a primary source).

---

## Risks and Limitations

- **Data quality risk:** Several primary government PDFs (EPFO documents, ESIC Standard Note, Kerala Shops Act Rules, Kerala minimum wage notifications) resisted machine parsing during this research and are cited via secondary sources instead. Treat every rate/threshold/date in this report as requiring direct confirmation against the primary Gazette/circular before being hard-coded into software — a full list of flagged items is repeated in the section below.
- **Legal/regulatory risk:** The Labour Codes situation in Kerala (A.10) is genuinely live and politically contested; a change in state government position could shift compliance requirements with limited notice. The POSH per-branch ICC requirement (A.9) and the Kerala PT branch-to-local-body mapping (A.3) both carry real exposure if the underlying legal interpretation used in this report (drawn from practitioner secondary sources, not primary case law review) turns out to be incomplete — both should get a direct legal opinion before the software's data model is finalized.
- **Implementation risk:** Part A's items are individually buildable, but collectively represent a large compliance-engineering surface (five distinct government-facing computation/filing subsystems: EPF, ESI, PT, TDS, plus registers). Sequencing matters — see Recommendations.
- **Currency risk:** Every statutory rate in this report is a snapshot as of July 27, 2026. PT rates were revised in 2024, minimum wages revise roughly every six months, and income tax slabs revise annually — a report or hardcoded constant that isn't revisited will become wrong on a predictable schedule, not a hypothetical one.
- **Research gaps acknowledged directly:** no jewellery-specific sales-commission benchmark exists in the public record; no documented link between Kerala festival seasons and overtime/staffing practice exists; ESS adoption statistics are vendor marketing, not verified survey data.

---

## Recommendations

1. **Treat Part A as the build backlog's top priority, sequenced by combined legal-risk and current-gap size:** Kerala Professional Tax (A.3) and POSH per-branch ICC tracking (A.9) first, since both are structurally complex, branch-count-driven, and have documented real-world failure/exposure cases elsewhere in India; EPF/ESI/TDS (A.1, A.2, A.4) next, since they are well-defined but computationally heavy; Gratuity/Bonus/Shops Act registers (A.5–A.7) as the following wave, since they extend existing modules rather than requiring new domains.
2. **Get a Kerala-licensed labour law consultant to confirm the flagged items before the data model is frozen** — specifically: the exact Kerala PT slab table and due dates (A.3), whether Shops Act registration and POSH ICCs are legally required per-branch (A.7, A.9), and current Kerala minimum wage figures for both scheduled-employment categories (A.11). Building the wrong data model now (e.g., PT as a single state-level setting instead of per-local-body) will be expensive to unwind later.
3. **Architect every statutory rate/threshold as a dated, versioned, configurable value — never a hardcoded constant.** This applies across EPF ceilings, ESI thresholds, PT slabs, TDS slabs, minimum wages, and especially the Labour Codes' prospective wage-definition and settlement-timeline rules (A.10) — Kerala's non-adoption today doesn't mean it stays that way, and the softest landing is a system that can absorb a rate/rule change via configuration, not a code deployment.
4. **Assign explicit, ongoing ownership for compliance-rate monitoring** — this is the one advantage commercial HR SaaS has that a custom build structurally lacks (Part B), and it is a people/process gap, not a software gap, that needs a named owner and a recurring review cadence (e.g., aligned to the twice-yearly PT/minimum-wage revision cycle).
5. **Scope the sales-commission engine (C.2) as a policy exercise with sales leadership before any engineering starts** — no external benchmark exists to build against, Indian or jewellery-specific, so the design risk is in the business decision, not the software.
6. **Prioritize WhatsApp notifications (C.5) and loan/advance management (C.8) as the two highest-leverage "high value" items** given the workforce mix (many WhatsApp-native, deskless staff; lower-wage roles like drivers/cleaning staff/sales executives who commonly value short-term liquidity support) — both are well-precedented at commercial vendors and relatively low-to-medium build complexity.
7. **Do not build to the Labour Codes' specific numbers (50% wage rule, 2-day F&F) as current requirements** — Kerala has not adopted them and the state's political position argues against near-term adoption — but do keep the wage-definition and settlement-workflow logic flexible enough to switch later without a rebuild (see Recommendation 3).

---

## Conclusion

Parakkat Jewels' in-house HR/payroll system has strong operational bones — multi-entity structure, biometric attendance, leave, and a configurable payroll engine — but this research found that the highest-priority, non-negotiable gap is statutory compliance calculation and filing: EPF, ESI, Kerala Professional Tax, TDS, Gratuity, and the Payment of Bonus Act, each with a clear legal trigger this 242-employee, multi-entity Kerala business has almost certainly already crossed. Kerala's professional tax structure (routed through dozens of local self-government bodies rather than one state authority) and the POSH Act's apparent per-branch committee requirement stand out as the two items where the compliance shape is genuinely more complex than a typical single-location Indian SMB would face, given the ~46-branch footprint.

The competitive benchmark against six Indian HR SaaS platforms confirms that automatic government-rate updates and one-click statutory filing are the industry's baseline expectation — the biggest ongoing cost of building in-house isn't the initial engineering, it's the standing obligation to track and ship every future rate change across five separate compliance regimes. Multi-entity support, by contrast, is something Parakkat's build already does better and more natively than most commercial products offer by default, which is a genuine point in favor of the custom-build decision for that specific requirement.

**Immediate next step:** commission a Kerala labour-law consultant review of the items flagged throughout this report (Kerala PT slab table, per-branch Shops Act registration, per-branch POSH ICC requirement, current minimum wage figures) before finalizing the compliance module's data model — this is a small, bounded cost relative to the risk of building the wrong shape (e.g., a single state-level PT setting) and having to re-architect later.

---

## Sources / References

| # | Source Name | URL | Date Accessed | Relevance |
|---|---|---|---|---|
| 1 | EPFO — About EPFO | https://www.epfindia.gov.in/site_en/AboutEPFO.php | 2026-07-27 | EPF applicability, official |
| 2 | EPFO — Introduction to ECR Version II | https://www.epfindia.gov.in/site_docs/PDFs/EPFOUnifiedPortal/Introduction_ECR2.0.pdf | 2026-07-27 | ECR filing format, official |
| 3 | EPFO v. Sunil Kumar B., SC judgment (4 Nov 2022) | https://indiankanoon.org/doc/14993351/ | 2026-07-27 | EPS higher-pension option, primary judgment |
| 4 | Clubbing of Units under Labour Laws — SCC Times | https://www.scconline.com/blog/post/2025/09/24/clubbing-of-units-labour-laws-judicial-trends/ | 2026-07-27 | Multi-entity EPF clubbing risk |
| 5 | Section 2A EPF Act — aaptaxlaw.com | https://www.aaptaxlaw.com/epf-act-1952/section-2a-epf-act-1952-establishment-to-include-all-departments-and-branches-section-2a-employees-provident-funds-miscellaneous-provisions-act-1952.html | 2026-07-27 | Branch pooling under one EPF establishment |
| 6 | ESI Contribution Rate 2026 — Tally Solutions | https://tallysolutions.com/business-guides/esi-contribution-rate-2026-current-percentage-for-employer-employee/ | 2026-07-27 | ESI rates, cross-verified |
| 7 | ESIC Regional Office, Thrissur — About Us | https://rokerala.esic.gov.in/ro-sro-about-us | 2026-07-27 | Kerala ESI coverage history, official |
| 8 | Professional Tax Kerala — ClearTax | https://cleartax.in/s/professional-tax-kerala | 2026-07-27 | Kerala PT slabs post-2024 revision |
| 9 | Kerala Professional Tax Updation October 2024 — Dictum & Netlc | https://www.dictumnetlc.com/kerala-professional-tax/ | 2026-07-27 | Confirms G.O.(Sadha) No.1149/2024/LSGD |
| 10 | Kerala Panchayat Raj Act, 1994 — IndiaCode | https://www.indiacode.nic.in/bitstream/123456789/17251/1/the-kerala-panchayat-raj-act-1994.pdf | 2026-07-27 | Legal basis for Kerala PT, primary text |
| 11 | Section 192 of the Income Tax Act — TaxBuddy | https://www.taxbuddy.com/blog/section-192-tds-on-salary | 2026-07-27 | TDS on salary mechanics |
| 12 | Form 24Q Due Dates FY2025-26 — 5paisa | https://www.5paisa.com/stock-market-guide/tax/form-24q | 2026-07-27 | TDS return due dates |
| 13 | CBDT Circular 4/2023 summary — CAclubindia | https://www.caclubindia.com/articles/cbdt-issued-circular-on-tds-for-salaries-in-fy-2023-24-what-you-need-to-know-49458.asp | 2026-07-27 | New vs old tax regime TDS default |
| 14 | Income Tax Slabs FY2025-26 — Axis Max Life | https://www.axismaxlife.com/blog/tax-savings/income-tax-slab-2025-26 | 2026-07-27 | Current slabs, rebate, standard deduction |
| 15 | Gratuity Calculator/exemption — ClearTax | https://cleartax.in/s/gratuity-calculator | 2026-07-27 | Gratuity formula and tax exemption |
| 16 | AS-15 applicability — Kapadia & Kochrekar | https://kacindia.com/knowledge/applicability-as15 | 2026-07-27 | Actuarial valuation requirement |
| 17 | Section 40A(7) gratuity provisioning — TaxGuru | https://taxguru.in/income-tax/understanding-gratuity-provisions-under-income-tax.html | 2026-07-27 | Tax deductibility of gratuity provisioning |
| 18 | Payment of Bonus Act summary — TeamLease RegTech | https://teamleaseregtech.com/blogs/149/decoding-the-code-on-wages-2019 | 2026-07-27 | Bonus Act eligibility and rates |
| 19 | Labour Laws in Kerala 2026 — Asanify | https://asanify.com/blog/labour-laws/labour-laws-in-kerala-2026-minimum-wages-working-hours-benefits/ | 2026-07-27 | Kerala Shops Act hours/OT |
| 20 | Kerala Shops and Commercial Establishments Act — Keka compliance wiki | https://www.keka.com/compliance/acts/kerala-shops-and-commercial-establishments-act-1960 | 2026-07-27 | Registers, leave entitlements |
| 21 | Kerala amends Shops Act — women's night shifts — The News Minute | https://www.thenewsminute.com/article/kerala-amends-shops-and-establishment-act-women-can-now-work-night-shifts-84194 | 2026-07-27 | 2018 amendment, night shift rules |
| 22 | Kerala Shops and Establishment Registration — IndiaFilings | https://www.indiafilings.com/learn/kerala-shops-and-establishment-registration | 2026-07-27 | Per-branch registration practice |
| 23 | The Maternity Benefit Act — iPleaders | https://blog.ipleaders.in/the-maternity-benefit-act | 2026-07-27 | Leave duration, crèche threshold |
| 24 | Section 5, Maternity Benefit Act — IndianKanoon | https://indiankanoon.org/doc/1130021 | 2026-07-27 | WFH provision, primary text |
| 25 | Unifying Protection: Internal Committee Across Multiple Locations — MMJC | https://mmjc.in/unifying-protection-internal-committee-across-multiple-locations | 2026-07-27 | Per-branch POSH ICC requirement |
| 26 | One Company, Multiple ICs — PoshExpertSolutions | https://poshexpertsolutions.com/post/one-company-multiple-ics-decoding-the-posh-act-s-every-location-rule | 2026-07-27 | POSH multi-location practice, cites invalidation case |
| 27 | Annual POSH Compliance Report — Keka | https://www.keka.com/compliance/forms/annual-posh-compliance-report | 2026-07-27 | District-wise annual filing requirement |
| 28 | Why Kerala is pushing back against Centre's new labour codes — ThePrint | https://theprint.in/india/governance/why-kerala-is-pushing-back-against-centres-new-labour-codes/2793520/ | 2026-07-27 | Kerala's explicit non-adoption position, Labour Minister quote |
| 29 | Kerala Labour Commissionerate — What's New | https://lc.kerala.gov.in/en/whats-new | 2026-07-27 | Official, page updated 5 May 2026 |
| 30 | Kerala government under fire after draft linked to Centre's labour codes surfaces — Deccan Herald | https://www.deccanherald.com/india/kerala/kerala-government-under-fire-after-draft-linked-to-centres-labour-codes-surfaces-3810821 | 2026-07-27 | Political controversy context |
| 31 | Labour Codes 2026 Implementation: Complete Guide — iPleaders | https://blog.ipleaders.in/labour-codes-2026-implementation-complete-guide-to-what-is-in-force-what-changed-and-what-to-do-now/ | 2026-07-27 | National notification timeline |
| 32 | 2-day full and final settlement under Labour Codes — Nexdigm | https://www.nexdigm.com/inthenews/2-day-full-and-final-settlement-post-employees-resignation-now-mandatory-under-labour-codes-what-it-means-for-employers/ | 2026-07-27 | Section 17(2) settlement timeline |
| 33 | Kerala goldsmith/silver-ornament minimum wage revision — TeamLease RegTech | https://teamleaseregtech.com/updates/article/52956 | 2026-07-27 | G.O.(P) No.9/2026/LBR, factory-staff wage category |
| 34 | greytHR Price Calculator | https://www.greythr.com/pricing-calculator/ | 2026-07-27 | Official pricing |
| 35 | How to generate PF ECR File on greytHR — Help Desk | https://support.greythr.com/hc/en-us/articles/360012496932-How-to-generate-PF-ECR-File-on-greytHR- | 2026-07-27 | Vendor ECR feature, official |
| 36 | Payroll Compliance Simplified — Keka | https://www.keka.com/payroll-compliance | 2026-07-27 | Vendor compliance depth, official |
| 37 | Zoho Payroll Pricing | https://www.zoho.com/payroll/pricing/ | 2026-07-27 | Official pricing, direct fetch |
| 38 | Darwinbox Review 2026: Enterprise HRMS India — HROne | https://hrone.cloud/blog/darwinbox-review-india/ | 2026-07-27 | Third-party review, LWF gap noted |
| 39 | RazorpayX Payroll Pricing | https://razorpay.com/payroll/pricing/ | 2026-07-27 | Official pricing, direct fetch |
| 40 | Manage Statutory Compliance in RazorpayX Payroll — Razorpay Docs | https://razorpay.com/docs/payroll/statutory-compliance/ | 2026-07-27 | Official compliance documentation |
| 41 | Kredily Pricing | https://kredily.com/pricing/ | 2026-07-27 | Official pricing, direct fetch |
| 42 | Zoho Blog — WhatsApp integration for Zoho People | https://blog.zoho.com/people/introducing-the-whatsapp-integration-for-zoho-people.html | 2026-07-27 | WhatsApp feature, official |
| 43 | Darwinbox — First HR Tech Platform to Integrate with WhatsApp for Business | https://darwinbox.com/blog/darwinbox-becomes-the-first-ever-hr-tech-platform-to-integrate-with-whatsapp-for-business | 2026-07-27 | WhatsApp feature, official vendor claim |
| 44 | Records Retention Obligations of Employer — greytHR | https://www.greythr.com/blog/records-retention-obligations-of-employer/ | 2026-07-27 | Statutory retention periods by Act |
| 45 | Full And Final Settlement (FnF) In India 2025 — QuikChex | https://quikchex.in/full-and-final-settlements/ | 2026-07-27 | F&F components, legacy timelines |
| 46 | Taxability of concessional or interest-free loan perquisite — TaxGuru | https://taxguru.in/income-tax/taxability-concessional-interest-free-loan-perquisite-employee.html | 2026-07-27 | Loan perquisite tax rule (old threshold) |
| 47 | Tax-Free Loans from Employer: How the Rules Have Changed? — EMI Calculator | https://emicalculator.net/tax-free-loans-from-employer-how-the-rules-have-changed/ | 2026-07-27 | New ₹2,00,000 threshold claim, flagged unconfirmed |
| 48 | Kalyan Jewellers — Onam | https://www.kalyanjewellers.net/blog/onam-the-golden-grace-of-keralas-grand-festival/ | 2026-07-27 | Kerala festival jewellery-buying pattern |
| 49 | Storyboard18 — Kalyan Jewellers 31% sales surge | https://www.storyboard18.com/brand-marketing/wedding-season-akshaya-tritiya-spark-31-sales-surge-for-kalyan-jewellers-in-q1-73198.htm | 2026-07-27 | Akshaya Tritiya/wedding season sales data |
| 50 | JCK — The Savvy Jeweler's Guide to Compensation Packages | https://www.jckonline.com/article-long/jewelers-guide-to-compensation/ | 2026-07-27 | US jewellery commission structures (proxy only) |

---

*Note on scope: the client brief described "4 legal entities" but named three (PP Imitations Pvt Ltd, Parakkat Pearls & Jewels, Parakkat Jewels Trading). This report treats each named entity as independently subject to entity-level obligations (EPF, ESI, TDS/TAN, Bonus Act, Gratuity) and does not attempt to resolve the naming discrepancy — confirm the fourth entity's legal status (separately incorporated vs. a division of one of the three) before finalizing the compliance data model, since that determines whether it needs its own registrations or falls under an existing entity's umbrella per Section 2A-style branch-pooling logic (A.0).*
