-- Show only the part of the group the system actually covers.
--
-- The roster was imported from a spreadsheet spanning the whole group: 48 branches across four
-- companies. Exactly one terminal is connected, at one site, and Easy Time Pro records a single
-- "area" with no branch concept at all. So 46 of those 48 branches hold nobody, while every
-- placement dropdown and every filter in the app offered all 48 — and a branch filter that can
-- only ever return an empty list is worse than no filter.
--
-- Switched off, not deleted. Those codes are real shops — ALP Alappuzha, ALU Aluva, BLR Bangalore,
-- KNR Kannur, KTM Kottayam, PKD Palakkad, PTA Pathanamthitta, TCR Thrissur — and since Easy Time
-- Pro has no notion of a branch, nothing could ever rebuild the list. They are empty because no
-- terminal is installed at those sites yet, not because they do not exist.
--
-- When a terminal goes in at one of them, switch it back on in Structure and its people arrive
-- through the same sync.
--
-- Companies are left alone: all four hold employees who are on the terminal today.

update public.branches b
   set is_active = false, updated_at = now()
 where is_active
   and not exists (select 1 from public.employees e where e.branch_id = b.id);

update public.departments d
   set is_active = false, updated_at = now()
 where is_active
   and not exists (select 1 from public.employees e where e.department_id = d.id);

-- A zone with no branch left showing has nothing to offer either.
update public.zones z
   set is_active = false, updated_at = now()
 where is_active
   and not exists (
     select 1 from public.branches b where b.zone_id = z.id and b.is_active
   )
   and not exists (select 1 from public.employees e where e.zone_id = z.id);
