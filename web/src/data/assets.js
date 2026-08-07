// Data hooks for the asset register. Read within scope (asset.read); register, allocate and take
// back (asset.manage). RLS does the scoping — everything here fetches what the caller may see.
//
// Custody lives in `asset_assignments`, one row per period somebody held the thing. `assets`
// carries the current holder as a cached column that a database trigger maintains from that table,
// so nothing here writes `assets.employee_id` directly: to move an asset you open or close an
// assignment and let the trigger follow. Writing both from the client is how the two drift apart.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';

export const ASSET_CATEGORIES = ['Hardware', 'Software', 'Furniture', 'Vehicle', 'Other'];
export const ASSET_STATUSES = ['Available', 'Allocated', 'Under Repair', 'Damaged', 'Lost', 'Retired'];
export const ASSET_CONDITIONS = ['New', 'Good', 'Fair', 'Poor'];

/** Finer types, offered per category. The column is free text, so this is a suggestion not a rule. */
export const ASSET_TYPES = {
  Hardware: ['Laptop', 'Desktop', 'Monitor', 'Mobile', 'Tablet', 'Printer', 'Scanner', 'Accessories', 'Other'],
  Software: ['Licence', 'Subscription', 'Cloud service', 'Other'],
  Furniture: ['Desk', 'Chair', 'Cabinet', 'Safe', 'Other'],
  Vehicle: ['Two-wheeler', 'Car', 'Van', 'Other'],
  Other: ['Other'],
};

// The embeds hang off owner_entity_id / owner_branch_id, which are the only foreign keys assets
// has to entities and branches. entity_id and branch_id are derived by trigger and deliberately
// carry no key — a second key to the same table would make `entities(...)` ambiguous to PostgREST.
const ASSET_COLUMNS = `
  id, category, asset_type, asset_code, name, make, model, serial, status, condition, location,
  notes, purchase_date, purchase_cost, vendor, invoice_no, warranty_expires,
  licence_key, licence_seats, licence_expires, photo_path,
  owner_entity_id, owner_branch_id, entity_id, zone_id, branch_id, department_id, employee_id,
  created_at, updated_at,
  owner_entity:entities(code,name),
  owner_branch:branches(code,name),
  employee:employees(id, full_name, employee_code, entity_id, branch:branches(code))
`;

export function useAssets() {
  return useQuery({
    queryKey: ['assets'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('assets')
        .select(ASSET_COLUMNS)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
}

/** One asset, for its record page. */
export function useAsset(id) {
  return useQuery({
    enabled: Boolean(id),
    queryKey: ['assets', id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('assets')
        .select(ASSET_COLUMNS)
        .eq('id', id)
        .single();
      if (error) throw error;
      return data;
    },
  });
}

/**
 * Everyone who has held this asset, newest first.
 *
 * Only one row can be open at a time, so ordering by handover date descending always puts the
 * current holder at the top.
 */
export function useAssetHistory(assetId) {
  return useQuery({
    enabled: Boolean(assetId),
    queryKey: ['asset-history', assetId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('asset_assignments')
        .select(
          // The *_by_name columns are stamped server-side at write time (0079). assigned_by itself
          // points at auth.users, which PostgREST cannot embed, and a live lookup would anyway go
          // blank the day that login is removed.
          `id, assigned_at, returned_at, condition_out, condition_in, notes, return_notes,
           assigned_by_name, returned_by_name,
           employee:employees(id, full_name, employee_code,
                              branch:branches(code,name), designation:designations(title))`
        )
        .eq('asset_id', assetId)
        .order('assigned_at', { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
}

/** What one person is holding right now — for their profile. */
export function useEmployeeAssets(employeeId) {
  return useQuery({
    enabled: Boolean(employeeId),
    queryKey: ['assets', 'employee', employeeId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('assets')
        .select('id, category, asset_type, name, make, model, serial, asset_code, status, condition')
        .eq('employee_id', employeeId)
        .order('name', { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });
}

/**
 * Columns a client may set. An allow-list, so a stray form key can never reach the table.
 *
 * `status` is NOT here, and neither are entity_id/branch_id. All three are derived from custody by
 * database trigger. A form that posts the whole row would otherwise carry whatever those values
 * were when it opened: correcting a typo in "Kept at" minutes after somebody else allocated the
 * item would quietly write status back to Available while an open assignment still exists.
 * Deliberate status changes go through useSetAssetStatus below.
 */
const ASSET_COLS = [
  'category', 'asset_type', 'asset_code', 'name', 'make', 'model', 'serial',
  'condition', 'location', 'notes',
  'purchase_date', 'purchase_cost', 'vendor', 'invoice_no', 'warranty_expires',
  'licence_key', 'licence_seats', 'licence_expires',
  'owner_entity_id', 'owner_branch_id',
  // Written by useUpsertAsset after the file itself is in the bucket — see below.
  'photo_path',
];

/**
 * States somebody sets by hand.
 *
 * 'Available' is here as the way BACK: an asset marked Under Repair had no route to "it is fine
 * now" and was stuck out of service forever. It is only offered while nobody holds the asset —
 * with an open assignment the status is Allocated and the custody trigger owns it, so setting it
 * Available by hand would contradict a row that says somebody has the thing.
 */
export const ASSET_MANUAL_STATUSES = ['Available', 'Under Repair', 'Damaged', 'Lost', 'Retired'];

function cleanAssetPayload(input) {
  const row = {};
  for (const k of ASSET_COLS) {
    if (k in input) row[k] = input[k] === '' ? null : input[k];
  }
  return row;
}

/** What the database's own guards mean, in words somebody can act on. */
function describeAssetError(error) {
  if (!error) return error;
  const text = `${error.message ?? ''} ${error.details ?? ''}`;
  if (text.includes('idx_asset_one_open_assignment')) {
    return new Error('Somebody already holds this asset. Take it back first, then allocate it again.');
  }
  if (text.includes('idx_assets_code_per_entity')) {
    return new Error('That asset code is already used by another item in this company.');
  }
  if (text.includes('assets_status_values')) return new Error('That is not a status this register uses.');
  if (text.includes('assets_category_values')) return new Error('That is not a category this register uses.');
  if (text.includes('assets_seats_positive')) return new Error('Licence seats must be at least 1.');
  if (text.includes('asset_assignments_dates_sane')) {
    return new Error('The return date cannot be before the date it was handed over.');
  }
  if (error.code === '23502') return new Error('An asset needs at least a name and a company.');
  return error;
}

/** Object names are `<asset_id>/<filename>`; the storage policy reads that id back out. */
const PHOTO_BUCKET = 'asset-photos';

function safePhotoName(name) {
  const cleaned = String(name || 'photo')
    .normalize('NFKD')
    .replace(/[^\w.\- ]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_{2,}/g, '_')
    .slice(-80);
  return cleaned.replace(/^[._]+/, '') || 'photo';
}

/**
 * Register or edit an asset, optionally with a photograph of it.
 *
 * Row first, then the file, then the path back onto the row. It has to be that order for a new
 * asset — the object name contains the asset id, which does not exist until the insert returns,
 * and the storage policy resolves that id back to the row to decide whether the upload is allowed.
 *
 * A failed upload does not fail the save: an asset registered without its picture is a complete
 * record missing a nicety, and throwing here would leave the caller thinking nothing was written
 * when the row is already there. The error is reported separately.
 */
export function useUpsertAsset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, photoFile, ...rest }) => {
      const payload = cleanAssetPayload(rest);
      const q = id
        ? supabase.from('assets').update(payload).eq('id', id).select('id').single()
        : supabase.from('assets').insert(payload).select('id').single();
      const { data, error } = await q;
      if (error) throw describeAssetError(error);

      if (!photoFile) return data;

      const path = `${data.id}/${Date.now()}-${safePhotoName(photoFile.name)}`;
      const { error: uploadError } = await supabase.storage
        .from(PHOTO_BUCKET)
        .upload(path, photoFile, { contentType: photoFile.type || undefined, upsert: false });
      if (uploadError) return { ...data, photoError: uploadError.message };

      const { error: pathError } = await supabase
        .from('assets')
        .update({ photo_path: path })
        .eq('id', data.id);
      if (pathError) return { ...data, photoError: pathError.message };

      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['assets'] });
      qc.invalidateQueries({ queryKey: ['asset-history'] });
      qc.invalidateQueries({ queryKey: ['asset-photos'] });
    },
  });
}

/**
 * Signed URLs for a set of asset photographs, keyed by asset id.
 *
 * Batched like useEmployeeAvatars and for the same reason: a page of the register would otherwise
 * be one signing request per row. Pass only what is on screen.
 */
const PHOTO_URL_SECONDS = 600;

export function useAssetPhotos(assets) {
  const paths = (assets ?? [])
    .filter((a) => a?.photo_path)
    .map((a) => [a.id, a.photo_path]);
  // Sorted so the same page produces the same key however the rows were ordered.
  const key = paths.map(([id, path]) => `${id}:${path}`).sort();

  return useQuery({
    enabled: key.length > 0,
    queryKey: ['asset-photos', key],
    staleTime: (PHOTO_URL_SECONDS - 120) * 1000,
    queryFn: async () => {
      const { data: signed, error } = await supabase.storage
        .from(PHOTO_BUCKET)
        .createSignedUrls(paths.map(([, path]) => path), PHOTO_URL_SECONDS);
      if (error) throw error;
      const byPath = new Map((signed ?? []).filter((s) => s.signedUrl).map((s) => [s.path, s.signedUrl]));
      const byAsset = {};
      for (const [id, path] of paths) {
        const url = byPath.get(path);
        if (url) byAsset[id] = url;
      }
      return byAsset;
    },
  });
}

/**
 * Move an asset into one of the states custody does not own.
 *
 * Separate from useUpsertAsset so a status change is always a deliberate act on the current value,
 * never a stale field posted along with an unrelated edit. Returning to Available is the trigger's
 * job — take the asset back instead.
 */
export function useSetAssetStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ assetId, status }) => {
      const { data, error } = await supabase
        .from('assets')
        .update({ status })
        .eq('id', assetId)
        .select('id');
      if (error) throw describeAssetError(error);
      if (!data || data.length === 0) {
        throw new Error('That status change did not go through — the asset is outside what you can manage.');
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['assets'] }),
  });
}

/**
 * Hand an asset to somebody.
 *
 * The partial unique index refuses this while the asset is still out with someone else. Closing
 * the previous holder's row automatically would be the old overwriting behaviour wearing a nicer
 * name — somebody still physically has the thing, and the register should keep saying so until it
 * is handed back.
 */
export function useAssignAsset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ assetId, employeeId, conditionOut, notes }) => {
      const { data: { user } } = await supabase.auth.getUser();
      const { error } = await supabase.from('asset_assignments').insert({
        asset_id: assetId,
        employee_id: employeeId,
        assigned_by: user?.id ?? null,
        condition_out: conditionOut || null,
        notes: notes || null,
      });
      if (error) throw describeAssetError(error);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['assets'] });
      qc.invalidateQueries({ queryKey: ['asset-history'] });
    },
  });
}

/**
 * Take it back. Closes the open assignment and the trigger frees the asset.
 *
 * The `.is('returned_at', null)` is not decoration: without it, a second click would stamp a fresh
 * return date over a closed row and quietly rewrite history.
 */
export function useReturnAsset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ assignmentId, conditionIn, notes }) => {
      const { data: { user } } = await supabase.auth.getUser();
      const { data, error } = await supabase
        .from('asset_assignments')
        .update({
          returned_at: new Date().toISOString(),
          returned_by: user?.id ?? null,
          condition_in: conditionIn || null,
          // Its own column. Writing this into `notes` would erase what was recorded at handover.
          return_notes: notes || null,
        })
        .eq('id', assignmentId)
        .is('returned_at', null)
        .select('id');
      if (error) throw describeAssetError(error);
      // An UPDATE that matches no row is not an error — RLS filtering it out, or a second click
      // after it already closed, both come back 204 with no rows. Without this the panel closes
      // and the timeline still shows the asset out with the same person.
      if (!data || data.length === 0) {
        throw new Error(
          'That return did not go through — the assignment may already be closed, or it is outside '
          + 'what you have permission to manage. Reload and check who is holding it.',
        );
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['assets'] });
      qc.invalidateQueries({ queryKey: ['asset-history'] });
    },
  });
}
