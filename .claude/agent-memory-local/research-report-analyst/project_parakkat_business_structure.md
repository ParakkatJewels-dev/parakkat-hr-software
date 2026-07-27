---
name: project-parakkat-business-structure
description: Parakkat Jewels' legal entity structure, headcount, and tech stack for the in-house HR/payroll build
metadata:
  type: project
---

Parakkat Jewels is a Kerala jewellery retail group building custom in-house HR/payroll software (React + Postgres/Supabase) instead of buying commercial HR SaaS.

Structure (as stated by the user, 2026-07-27):
- 4 legal entities, though only 3 were named: PP Imitations Pvt Ltd, Parakkat Pearls & Jewels (head office + ~46 retail branches), Parakkat Jewels Trading. The 4th entity's identity/legal status was never confirmed — this is an open item, not resolved.
- 242 employees total: sales executives, shop-in-charges, goldsmiths/craft artists, cleaning staff, drivers, accountants, zonal/regional managers.
- Retail shops across Kerala plus one factory/production unit (where goldsmiths/craft artists work — legally a distinct minimum-wage scheduled-employment category, "Manufacture of Gold and Silver Ornaments," separate from the general "Shops and Commercial Establishments" category that covers retail staff).
- Attendance: ZKTeco biometric face terminals via Easy Time Pro (see also the Claude Code project memory "attendance-infra-setup.md" for infra details — Easy Time Pro server at 192.168.1.45:8081 on an HR laptop).

Software already built (as of 2026-07-27, per the user's own inventory): multi-entity org structure (company→zone→branch→department→designation), RBAC with 7 roles + row-level security, employee directory with bulk import, biometric attendance sync, shift definitions, weekly-offs, holiday calendars, attendance regularisation, leave management, a payroll engine (salary structures, configurable scoped earnings/deductions, payslips, payroll runs), expense claims, asset register, helpdesk, exits/separation, recruitment, onboarding checklists, goals/KRAs (no formal appraisal cycles yet), reports/dashboards.

**Why this matters:** any future research or build work on this project should assume the operational core exists — the gap is statutory compliance calculation/filing (EPF, ESI, Kerala Professional Tax, TDS, Gratuity, Bonus Act) and a handful of retail-specific features (sales commission, shift rostering, WhatsApp notifications, loan/advance management). See [[project-parakkat-compliance-findings]] for the detailed findings, and [[reference-parakkat-compliance-report]] for where the full report lives.
