import { mediaPath } from './conversations.js';

export const GROUP_PICTURE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
export const GROUP_PICTURE_MAX_BYTES = 5 * 1024 * 1024;

export async function renameGroup(client, { conversationId, title }) {
  const name = String(title ?? '').trim();
  if (!name || name.length > 120) throw new Error('Choose a group name between 1 and 120 characters.');
  const { data, error } = await client.from('conversations').update({ title: name })
    .eq('id', conversationId).eq('kind', 'group').select('id');
  if (error) throw error;
  if (!data?.length) throw new Error('Only members can change a group name.');
}

export async function setGroupPicture(client, { conversationId, file = null }) {
  if (file && !GROUP_PICTURE_TYPES.includes(file.type)) throw new Error('Choose a JPG, PNG, WebP or GIF image.');
  if (file && (!file.size || file.size > GROUP_PICTURE_MAX_BYTES)) throw new Error('Choose an image of 5 MB or smaller.');
  const { data: group, error: readError } = await client.from('conversations')
    .select('id, kind, photo_path').eq('id', conversationId).single();
  if (readError) throw readError;
  if (group?.kind !== 'group') throw new Error('Only groups have an editable chat picture.');

  const bucket = client.storage.from('chat-media');
  const path = file ? `${conversationId}/group-photo/${mediaPath(conversationId, file.name).split('/')[1]}` : null;
  if (file) {
    const { error } = await bucket.upload(path, file, { contentType: file.type, upsert: false });
    if (error) throw error;
  }
  try {
    const { data, error } = await client.from('conversations').update({ photo_path: path })
      .eq('id', conversationId).eq('kind', 'group').select('id');
    if (error) throw error;
    if (!data?.length) throw new Error('Only members can change a group picture.');
  } catch (error) {
    if (!path) throw error;
    // The write may have committed before its response was lost. Confirm the current pointer
    // before deleting our upload; an unavailable confirmation must leave the asset intact.
    let current;
    try {
      const result = await client.from('conversations').select('photo_path')
        .eq('id', conversationId).eq('kind', 'group').single();
      if (result.error || !result.data) throw error;
      current = result.data;
    } catch {
      throw error;
    }
    if (current.photo_path !== path) {
      await bucket.remove([path]).catch(() => {});
      throw error;
    }
    // A fresh read points to this unique upload: the save succeeded, so normal cleanup can run.
  }
  // The saved identity is already correct if optional cleanup fails. Never turn that into a
  // reported save failure or delete an attachment outside this group's picture folder.
  if (group.photo_path?.startsWith(`${conversationId}/group-photo/`) && group.photo_path !== path) {
    await bucket.remove([group.photo_path]).catch(() => {});
  }
  return path;
}
