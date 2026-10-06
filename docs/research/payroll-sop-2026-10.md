# Payroll SOP and implementation decisions

Research checked: **6 October 2026 (Asia/Kolkata)**. Scope: the salary-sheet columns supplied for Parakkat's payroll engine. Kerala retail is a working assumption from the existing project report, not a newly confirmed employer instruction. Establishment, employee and wage-period applicability must be recorded before activating statutory calculations.

This is an implementation reference and proposed operating procedure. It does not certify payroll compliance or establish the employer's pay policy. The supplied column names contain no sample amounts or spreadsheet formulas, so their original calculation semantics remain unverified.

## Material corrections to the July research

The earlier `hr-payroll-compliance-report.md` must not supply current constants without review:

- **EPFO changed recently.** Ministry announcements specify a ₹25,000 monthly ceiling from **17 September 2026**, replacing ₹15,000. September needs a transition calculation; historical payroll must retain its original applicable ceiling. [Ministry announcement, 16 September 2026](https://www.pib.gov.in/PressReleasePage.aspx?PRID=2310973&lang=1&reg=3), [EPFO regional guidance, 23 September 2026](https://www.pib.gov.in/PressReleasePage.aspx?PRID=2313790&lang=2&reg=48).
- **Do not assume central Labour Codes can be ignored in Kerala.** The Ministry's transition FAQ says prior rules continue only insofar as consistent with the Codes pending replacement. The March FAQ identifies 21 November 2025 as the effective date of the wage definition and applies that definition to ESI. Political statements or an old report do not determine applicability. State rules, establishment category and applicable authority still require verification. [Transition FAQ](https://www.labour.gov.in/static/uploads/2026/01/de4758d5bfeffc456d7de97a801891b0.pdf), [additional FAQ, 16 March 2026](https://www.labour.gov.in/static/uploads/2026/03/a4ccf4c6d97c4f1f36a6d83f8c64213d.pdf).

## Proposed monthly SOP

| Stage | Owner | Required result |
| --- | --- | --- |
| 1. Open the wage period | Payroll | Select entity, branches, period and effective policy version; identify joiners, leavers and salary changes. |
| 2. Close attendance | Branch manager / HR | Resolve missing punches; approve leave, holidays, weekly rest, overtime and attendance corrections. Save a dated attendance snapshot. |
| 3. Collect variable pay | Branch manager / Finance | Approve incentive, target incentive, expenses, allowances and commission separately. Attach claim or sales-period references and prevent duplicate claims. |
| 4. Validate recoveries | HR / Finance | Reconcile outstanding advances; document the reason and approval for other deductions; complete the required employee process for damage or loss. |
| 5. Calculate draft | Payroll | Produce all sheet columns, source amounts, rate bases and warnings. Keep employee deductions separate from employer contributions. |
| 6. Review exceptions | Payroll reviewer | Compare against prior month and source sheet; investigate missing policy, unusual pay, negative net, duplicate employee, attendance conflicts and statutory exceptions. |
| 7. Approve and lock | Authorised approver | Approve a calculation snapshot. Later changes require a traceable revision or adjustment, not silent recalculation of paid salaries. |
| 8. Pay and issue payslips | Finance | Reconcile approved net pay against bank payment results; record payment references and partial/failed payments. |
| 9. Reconcile liabilities | Finance / compliance owner | Reconcile employee and employer contributions with returns and remittances. Keep registration-specific statutory output separate from the bank file. |

Suggested application lifecycle: **Draft → Reviewed → Approved → Paid**. Reopening or reversal needs a reason and audit event. Preview/export alone is not evidence of approval or payment. These are design recommendations, not a claim about currently implemented screens.

## Column contract to agree with payroll staff

| Sheet columns | Proposed meaning and control |
| --- | --- |
| Employee Name; Branch | Display identity; reconcile by stable employee ID and branch/entity assignment for the period. Names are not unique keys. |
| Salary (first occurrence) | Contractual monthly salary/rate before attendance proration. Keep distinct from earned salary. |
| No Of Days Per Month | Calendar days in the month. A fixed 30-day or working-day payroll divisor is a separate policy choice. |
| Net Working Days; Public Holiday | Planned duty-day count and holiday-day count. Confirm whether the legacy sheet's net days already subtract holidays or weekly off. |
| Actual Working Days; Off Days; Casual Leave | Attendance-derived quantities and approved paid-day categories. A date cannot be credited twice merely because a holiday overlaps a weekly off or leave. Support half days. |
| Total Working Days | Confirm whether this means paid days or physically worked days. Recommended payroll meaning: paid-day equivalents, with physical attendance still shown separately. |
| Per Day Wages; Per Day Working Hour | Contractual salary divided by the confirmed payroll divisor; daily scheduled paid hours from policy. Do not infer an eight-hour divisor from the heading alone. |
| Total Working Hours; Per Hour Wages | Keep physical worked hours distinct from paid hours. Hourly rate derives from the chosen wage base, divisor and daily hours; OT may require a different statutory wage base. |
| Salary (second occurrence) | Earned salary after the approved attendance-proration method; internally label it `earned salary` to avoid ambiguous imports. |
| Incentive; Target Incentive; Tea Expence; Other Allowances; Travel Allowance / Food Expence; Rent / Commission; Special Allowances | Separate earning components. Combined labels need component classification: rent is not necessarily commission, and reimbursed travel is not necessarily a fixed food allowance. Preserve the original export captions. |
| Ot Hours; Ot Amount | Eligible overtime hours and resulting payment. Attendance, approval and applicable normal wage basis must be traceable. |
| late hours; Late Amount | Approved unpaid late time and deduction, if policy permits. Never deduct time again if the same absence already reduced earned salary. |
| Gross Salary | Recommended definition: earned salary plus included earnings and OT, before deductions. Confirm whether the old workbook nets late amounts here. |
| Pf; Esi | Employee-side deductions only. Wage bases, coverage and employer liabilities are additional records, not amounts silently subtracted from net pay. |
| Salary Advance Refund | Recovery of a prior paid advance, bounded by outstanding balance and the authorised recovery schedule. |
| Welfare Fund | Employee contribution for the identified board/scheme and due period; no universal Kerala amount. |
| Deduction for loss and damages/ other deductions | Itemised, authorised deductions with reasons and supporting process; an input field does not itself authorise recovery. |
| Net Pay Salary | Gross salary minus employee deductions, including late amount exactly once. Preserve paise/rounding policy and reconcile the displayed components. |

For a **confirmed calendar-day paid-days policy only**, an illustrative formula is `earned salary = monthly salary × payable-day equivalents / calendar days`. This is not a universal statutory formula or a recovered formula from the user's workbook. Fixed-divisor, working-day and loss-of-pay methods can differ, especially in February and on joining/leaving dates.

## Statutory findings and implementation consequences

### EPF / EPS / EDLI

The official EPFO employer portal publishes **“Revision of EPFO Statutory Wage Ceiling” FAQs** citing S.O. 5109(E), 17 September 2026. Read on 6 October 2026 through the public alert PDF. The download URL contains a session token; use the [stable employer-portal entry](https://unifiedportal-emp.epfindia.gov.in/epfo/).

The FAQ illustrates 12% employee PF, a 12% employer contribution divided by EPS eligibility, and separate employer EDLI/admin charges. It calls for separate 1–16 and 17–30 September calculations within one September ECR. An existing capped member with ₹20,000 PF wages has September PF wages ₹17,333.33 and employee contribution ₹2,080; October's full-month employee contribution is ₹2,400. Existing higher-wage arrangements and EPS membership need individual review. October's ceiling example is ₹25,000 → ₹3,000 employee PF. Do not deduct employer PF, EPS, EDLI or administration from employee net pay. Store coverage, statutory wage base, effective dates and rounding, rather than infer PF from gross salary alone.

The older [EPFO employer booklet](https://www.epfindia.gov.in/site_docs/PDFs/MiscPDFs/Employer_Information_Booklet.pdf) is useful for historical operations and rounding but its ₹15,000 ceiling is not the current October setting. Confirm special-rate/exempt establishments and member-specific arrangements before automatic application.

### ESI

The [ESIC contribution page](https://esic.gov.in/contribution) states employee **0.75%**, employer **3.25%**, employee-share exemption where average daily wage is up to **₹176**, and remittance within 15 days of the calendar month's end. Page content was retrieved directly on 6 October 2026 after browser retrieval timed out. Exemption of the employee share does not remove the employer share.

The [March 2026 Ministry FAQ](https://www.labour.gov.in/static/uploads/2026/03/a4ccf4c6d97c4f1f36a6d83f8c64213d.pdf) confirms a ₹21,000 coverage threshold and the Social Security Code wage definition. Do not equate every allowance label with statutory wages or simply stop contributions whenever one month's gross exceeds a threshold. The [ESIC FAQ](https://www.esic.gov.in/attachments/files/faq.pdf) and [ESIC revenue manual](https://www.esic.gov.in/Publications/RevenueManual.pdf) describe contribution-period continuity and exclusion of overtime for coverage versus inclusion for contributions under the earlier framework. Reconcile those operational rules with current Code rules before activation. Coverage history and contribution-period dates belong in the employee record.

### Hours, overtime and deductions

The Kerala Labour Commissioner's published Shops Act, sections 6–7, specifies **8 hours/day, 48 hours/week** and overtime at **twice ordinary wages**, with a defined ordinary-wage base. Confirm applicable establishment/employee exemptions, amendments and interaction with current Codes. Track daily and weekly overtime without paying the same hours twice. [Official Kerala Shops Act](https://lc.kerala.gov.in/sites/default/files/inline-files/ksce%20%283%29.pdf).

Code on Wages section 18 permits specified deductions and caps the total at **50% of wages**; section 20 concerns proportional absence deductions. Section 21 limits damage/loss recovery to attributable loss and requires an opportunity for the employee to show cause. Do not encode arbitrary lateness fines or automatic jewellery-loss recovery from a free-text column. [Code on Wages text, sections 18–23](https://www.indiacode.nic.in/bitstream/123456789/15793/1/A2019-29.pdf), [Ministry wage-code FAQ](https://labour.gov.in/sites/default/files/faq_-code_on_wages.pdf).

The Ministry employer handbook summarises monthly payment before expiry of the seventh day of the succeeding month, wage slips, registers and overtime/deduction records. Its stated scope is the **central-government sphere**, so it is a useful checklist, not a substitute for identifying Kerala-specific rules and deadlines. [Official compliance handbook](https://www.labour.gov.in/static/uploads/2026/02/83978455025732b99b0165def80ab171.pdf).

### Welfare fund

Kerala has distinct welfare arrangements. The [Kerala Labour Welfare Fund Board's current overview](https://labourwelfarefund.in/about_us) states ₹45 each for employee and employer per half-year, payable before 15 July / 15 January; its older `/index.php/Controller/contribution` page still displays different historical figures. The separate [Shops and Commercial Establishments Workers Welfare Fund Board](https://peedika.kerala.gov.in/) describes a monthly ₹50 contribution changing to ₹100 on migration to its IT scheme. These are different schemes, not interchangeable rates. Identify the establishment's registered board, worker membership, current notification and due cycle before applying a deduction; the website banner alone does not establish every employee/employer share.

## Employer decisions still needed

1. Confirm jurisdictions, legal entities, retail/factory establishments and current EPFO/ESIC/welfare registrations.
2. Supply one anonymised completed month or exact formulas for the two salary columns, net/actual/total days, total hours and gross salary.
3. Confirm calendar/30-day/working-day divisor, joiner/leaver treatment, paid holidays, weekly rest and casual-leave policy.
4. Confirm ordinary daily hours, OT eligibility/rate basis, late-time grace and authorised deductions.
5. Classify each allowance as fixed pay, variable incentive, reimbursement or other remuneration for each statutory purpose; confirm rounding.
6. Review September 2026 EPFO transition and October settings against actual membership; do not overwrite historical snapshots.
7. Identify other applicable items absent from the sheet, including professional tax and salary income-tax withholding. Their omission from the provided columns is not evidence of exemption.

## Acceptance examples

Before live use, compare independently calculated cases: full attendance; February and 31-day months; joiner/leaver; half-day leave; overlapping holiday/rest/leave; missing punch; no salary setup; approved expenses; overtime versus late time; advance balance exhaustion; high deductions; PF September transition; ESI threshold crossing within a contribution period; welfare not due; duplicate employees; and recalculation after approval. Reconcile each earning/deduction to gross/net and employer liabilities, and record which statutory features remain manual.
