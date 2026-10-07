# Monthly payroll

The workflow is **Prepare data → Review payroll → Publish & payments**. Salary setup,
monthly entries, the calculated register and payment tracking share the company and month.
The spreadsheet fills the screen; its search, filters and position are preserved when HR
reviews an employee and returns to payroll.

The worksheet opens edge to edge with a compact toolbar and footer. **Full screen** also hides
browser controls where supported; **Exit full screen** returns to the window-sized worksheet.
**Back to payroll** returns to the surrounding workflow without losing cell edits or filters.
Punch refresh, source details and keyboard help are under **Details & help**.

## Company calculation method

Migration `0163_payroll_hourly_workings.sql` adds **HR hourly workings** alongside the existing
paid-days method. Existing company settings remain until a payroll manager explicitly changes
them. Published payslips retain their saved policy and calculations.

The hourly method follows the confirmed salary workings:

1. Divide monthly salary by the selected divisor and round the daily rate upward to a rupee.
2. Resolve the shift assigned to each employment date (or the company/shared default). Divide the daily rate by that shift’s daily paid hours and round the hourly rate to one decimal.
3. Add worked hours and paid holiday/off-day/leave hours to obtain payable hours.
4. Multiply each date’s payable hours by its hourly rate and add the results. If every date has the same daily hours, retain the original monthly worksheet formula. If daily hours vary, earned or manually overridden off/CL credits without dates are paid at one daily wage per credited day; no invented clock hours are assigned to these credits.
5. Add incentives, allowances and bonuses, then round wages upward to a rupee.
6. Subtract employee deductions and round net pay to the nearest rupee.

The saved register records rates, credit quantities, attendance source and rounding adjustments.
Payslip lines reconcile to gross, deductions and net. Overtime is already included in worked
hours in this method; an additional OT payment or late-time deduction would count that time again.
The paid-days method supports companies that pay separate OT and late adjustments.

**8 hours 30 minutes is 8.5 decimal hours.** The source spreadsheet's arithmetic with `8.3`
does not represent that duration. For example, salary ₹12,000, 187 worked hours, six credited
days and ₹1,506 deductions produce ₹11,210 gross and ₹9,704 net with 8.5. The original ₹9,908
is a historical reference, not the expected result after correcting the units.

The calendar divisor uses the days in the selected month. A fixed divisor is a separate company
choice. September alone cannot distinguish calendar days from fixed 30 days.

## Paid-day credits

- **Recorded attendance** uses the calendar and approved attendance/leave credits.
- **Earned off days and casual leave** gives one casual-leave day at 20 actual working days,
  and one off day for each six actual-plus-casual days, capped at four off days. This follows
  the source worksheet. Holidays come from attendance or complete reviewed monthly totals.

HR can override off-day or casual-leave quantities with a reason. An empty value uses the rule;
an explicit zero overrides it. Working days and credited days are separate; a credited total
over the calendar length is not automatically clipped. Joining/leaving dates constrain each
employee's payroll window.

For reviewed monthly totals with **Recorded attendance** credits, enter off days and casual leave
explicitly, including zero. This source does not mix in raw attendance. Only the earned-credit
rule can derive these quantities from reviewed actual working days.

## Prepare the month

1. Select company and month. Review and save the company policy. New drafts suggest hourly
   workings and earned credits; daily paid hours come from effective shift assignments. Saved company settings are not overwritten.
2. Use **Salary setup** for each employee's effective monthly salary and basic/component
   breakdown. Create employee profiles first, including staff without device codes.
3. Review **Attendance** inputs. Use recorded attendance normally. For staff without device
   attendance, select reviewed monthly totals, enter worked time as `H:MM`, actual working days
   and paid holidays, then record the HR reference/reason. Off days and casual leave use the
   earned-credit rule unless overridden; enter both explicitly when using attendance credits.
   Required zero quantities must be entered explicitly.
4. Enter allowances and deductions in the worksheet or its input template/import. The source
   sheet's `199.45` means `199:45`; do not paste it as decimal hours. Do not reimport a calculated
   salary register as monthly inputs.
5. Use **Adjustments & advances** for itemized bonus, incentive and reasoned deduction entries.
   Record an issued advance once, then schedule recovery. Do not enter the same amount in both
   the worksheet and the itemized ledger.

Reviewed totals are payroll inputs with an actor, timestamp and reason. They do not create device
punches, alter attendance or write to EasyTime Pro. Only complete reviewed monthly totals replace
attendance for hourly payroll. Recorded-source rows still require attendance issues to be resolved.
Switching back to recorded attendance clears reviewed worked-time and day totals.

PF, ESI and TDS use configured components or explicit reviewed employee deductions. The system
does not infer coverage, membership or tax liability from salary alone. Record the reference
for manual deductions, including an approved zero. A blank PF, ESI or TDS input uses the configured
component; an explicit amount replaces it. Employer contributions remain separate from employee deductions.

## Review, publish and track payment

Calculate after saving inputs. Review the detailed register's payable hours, rate, credit source,
additions, deductions and round-off. Export it for review. Changes to salary, inputs, policy or
other source evidence make the draft stale and require recalculation before publication.

Publishing locks the month's calculation and inputs. Salary holds preserve the amount owed.
Enter a reason to hold a salary and release the hold before recording payment. Enter the completed
payment's reference. Payment tracking does not send bank transfers. Paid records are final.

## Release and acceptance

Pause the attendance worker first. Apply pending migrations in order through `0165`, deploy the
matching frontend and updated worker, then restart the worker to drain the queued recomputation.
Do not let an old worker consume the upgrade queue with the old attendance rules. The migrations
do not switch existing company policies, import the source salary sheet or publish real payroll.

Run `npm test --prefix web/backend`, `npm test --prefix web`, `npm run lint --prefix web` and
`npm run build --prefix web`. Database tests use disposable private PostgreSQL clusters for
upgrades, calculations, reviewed totals, authorization, immutable published records, advances,
holds and concurrent operations without hosted credentials.

Before the first live publication, save the intended policy, complete salary/deduction records,
and reconcile a trial month against HR-approved results. Include partial months, zero attendance,
paid leave, manual credits, bonus, deductions, advance recovery and held salary. Unsupported
midmonth salary revisions are explicitly blocked rather than silently calculated at one rate.

## Employee schedules and breaks

In **Attendance admin → Shifts**, create each actual day/night schedule and its daily paid hours (also the salary basis). Overnight shifts belong to their start date. Existing break policies retain their meaning; the optional **Scheduled breaks** rule allows multiple clock windows marked paid or unpaid. Unpaid window overlap is deducted from time on site. Recorded time away outside configured windows is also deducted; time inside a paid break window is paid. Overlapping or out-of-shift windows are rejected. The user must enter the real schedules; no company timetable is seeded by this release.

Use **Assign employee shifts** to search by name/code/branch, select employees (up to 200 per page), choose a shift and an effective date. Use **All employees** when fixing historical shifts for former employees. Group assignments are atomic. A finite assignment ends on the specified date; afterward the company default applies unless another assignment exists. The previous assignment does not automatically resume. Conflicting day/night schedules are rejected before attendance is rewritten.

In **Directory → Add person**, select a joining date and working shift. The employee and initial assignment save in one transaction, effective from that joining date. The form shows the shift's daily paid hours before saving. For spreadsheet imports, provide **Shift** (code or name) and **Join Date** columns, or explicitly select batch values for missing cells. Existing-employee edits and imports do not change dated shift assignments; use **Assign employee shifts** for later changes.

Automatic device creation and trusted roster scripts use the configured active company default, or shared default if necessary. If the joining date is unknown, the assignment starts on the creation date in IST with a review note; the joining date is left unknown. Without an active default, device enrolments stay available for HR review and scripts report the missing configuration. Existing employees are not backfilled. Attendance excludes dates before a known joining date when resolving adjacent night/day shifts.

For hourly payroll, every employment date needs a valid shift. Different daily hours within a month are calculated date by date. HR-reviewed aggregate monthly hours are supported only when all those dates share one daily basis; they cannot supply the allocation between different hourly rates. The register and payslip expose saved daily shift/rate evidence, and Excel includes a **Shift basis by date** sheet. Undated credits paid as daily wages are shown separately from hours.

Changing a shift queues affected unlocked attendance and marks payroll drafts stale. Published attendance prevents changes to its historical shift rules; create a new shift and assign it from the appropriate future date instead. Pause the attendance worker before applying migrations `0164`–`0165`; deploy and restart the updated worker, then complete recomputation before recalculating payroll.
