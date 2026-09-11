// Talking to a colleague.
//
// Everything here rides on 0115's policies, so there is no permission check in this file: a query
// returns the conversations you are in (plus, for a super admin, any conversation they open by id),
// and an insert is refused unless you are a member sending as yourself. One boundary, not two.
//
// Live delivery is not here either. lib/realtime.js already subscribes to Postgres changes and
// invalidates the matching caches, and `messages` is registered there — a second realtime mechanism
// for one screen would be a second thing to debug when the first one is what everything else uses.
import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { supabase } from '../lib/supabaseClient';
import { fetchCollection, fetchInCollection } from '../lib/fetchCollection';
import { useAuth } from '../auth/AuthContext';
import { isMissingSchema } from '../lib/pendingMigration';
import { directKey, mediaPath } from '../lib/conversations';
import { fetchMessagePage, flattenMessagePages } from '../lib/messageHistory';

/**
 * Number of messages fetched when opening a conversation or loading an earlier page.
 */
export const MESSAGE_PAGE = 200;

const MEMBER_KEY = (row) => `${row.conversation_id}:${row.employee_id}`;

const MEMBER_FIELDS =
  'conversation_id, employee_id, role, joined_at, ' +
  'employee:employees(id, full_name, employee_code, branch:branches(code))';

const MESSAGE_FIELDS =
  'id, conversation_id, sender_id, kind, body, storage_path, mime_type, byte_size, ' +
  'duration_ms, reply_to, created_at, edited_at, deleted_at, ' +
  'sender:employees!messages_sender_id_fkey(id, full_name, employee_code)';

/**
 * Every conversation I am in, newest activity first, with its unread count and preview.
 *
 * Two queries, not one per conversation: the view answers "what and how many", then one `in` query
 * fetches the people across all of them. Twenty conversations is two round trips rather than
 * forty-one.
 *
 * `pending` is how the screen tells "you have no conversations" apart from "0115 has not been run".
 * The first is an empty state with a button on it; the second is a screen that cannot work yet, and
 * showing the first when it is really the second sends somebody looking for a bug in their data.
 */
export function useConversations() {
  return useQuery({
    queryKey: ['conversations'],
    queryFn: async () => {
      let rows;
      try {
        rows = await fetchCollection(() => supabase.from('my_conversations').select('*')
          .order('last_message_at', { ascending: false }).order('id'));
      } catch (error) {
        if (isMissingSchema(error)) return { pending: true, conversations: [] };
        throw error;
      }
      if (!rows.length) return { pending: false, conversations: [] };
      const members = await fetchInCollection((ids) => supabase.from('conversation_members')
        .select(MEMBER_FIELDS).in('conversation_id', ids)
        .order('conversation_id').order('employee_id'), rows.map((r) => r.id), { key: MEMBER_KEY });

      const byConversation = new Map();
      for (const m of members ?? []) {
        if (!byConversation.has(m.conversation_id)) byConversation.set(m.conversation_id, []);
        byConversation.get(m.conversation_id).push(m);
      }

      return {
        pending: false,
        conversations: rows.map((r) => ({ ...r, members: byConversation.get(r.id) ?? [] })),
      };
    },
  });
}

/**
 * Every conversation one employee is in — the middle column of the monitor.
 *
 * Reads through app.can_read_conversation's super-admin arm, so it returns nothing for anybody
 * else. That is deliberate: this hook carries no permission check of its own, exactly like the
 * rest of this file, and the database is the only thing deciding. A department head calling it
 * gets an empty list rather than an error, because as far as RLS is concerned those rows do not
 * exist for them.
 *
 * Two queries again, not one per conversation: the rows this person is in, then everybody in those
 * same conversations in a single `in` — which is what fills in "who they were talking to".
 */
export function useEmployeeConversations(employeeId, { enabled = true } = {}) {
  return useQuery({
    enabled: enabled && Boolean(employeeId),
    queryKey: ['admin-conversations', employeeId],
    queryFn: async () => {
      let mine;
      try {
        mine = await fetchCollection(() => supabase.from('conversation_members')
          .select('conversation_id').eq('employee_id', employeeId).order('conversation_id'),
          { key: (row) => row.conversation_id });
      } catch (error) {
        if (isMissingSchema(error)) return [];
        throw error;
      }
      const ids = mine.map((r) => r.conversation_id);
      if (ids.length === 0) return [];

      /*
       * conversation_overview, not the conversations table.
       *
       * The list this feeds is the SAME component the normal inbox uses, and that component draws a
       * preview line — the last thing said. Reading the bare table gives a row with no preview, so
       * every monitored conversation rendered as "No messages yet" whether or not it had any, which
       * is a lie told confidently. The view carries the last message; RLS still decides which rows
       * come back, so this is a shape, not a grant.
       */
      let summaries;
      try {
        summaries = await fetchInCollection((batch) => supabase.from('conversation_overview')
          .select('*').in('id', batch).order('id'), ids);
      } catch (error) {
        if (isMissingSchema(error)) return [];
        throw error;
      }
      const everyone = await fetchInCollection((batch) => supabase.from('conversation_members')
        .select(MEMBER_FIELDS).in('conversation_id', batch)
        .order('conversation_id').order('employee_id'), ids, { key: MEMBER_KEY });

      const byConversation = new Map();
      for (const m of everyone) {
        if (!byConversation.has(m.conversation_id)) byConversation.set(m.conversation_id, []);
        byConversation.get(m.conversation_id).push(m);
      }

      return summaries
        .map((c) => ({ ...c, members: byConversation.get(c.id) ?? [] }))
        // Most recently active first, the same order the inbox uses.
        .sort((a, b) => String(b.last_message_at ?? '').localeCompare(String(a.last_message_at ?? '')));
    },
  });
}

/** One thread, oldest at the top. Only fetched once a conversation is open. */
export function useMessages(conversationId, { enabled = true } = {}) {
  const query = useInfiniteQuery({
    enabled: enabled && Boolean(conversationId),
    queryKey: ['messages', conversationId, 'pages'],
    initialPageParam: null,
    queryFn: ({ pageParam }) => fetchMessagePage(supabase, conversationId, MESSAGE_FIELDS, pageParam, MESSAGE_PAGE),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
  const data = useMemo(() => query.data ? flattenMessagePages(query.data.pages) : undefined, [query.data]);
  return {
    ...query, data,
    hasOlder: Boolean(query.hasNextPage),
    loadOlder: () => query.fetchNextPage({ cancelRefetch: false }),
    isLoadingOlder: query.isFetchingNextPage,
  };
}

function useConversationMutation(mutationFn) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: (_result, variables) => {
      qc.invalidateQueries({ queryKey: ['conversations'] });
      if (variables?.conversationId) {
        qc.invalidateQueries({ queryKey: ['messages', variables.conversationId] });
      }
      qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}

export function useSendMessage() {
  const { employee } = useAuth();
  return useConversationMutation(async ({ conversationId, body, kind = 'text', media = null, replyTo = null }) => {
    if (!employee?.id) {
      throw new Error('Your account is not linked to an employee record, so it cannot send messages.');
    }
    const text = String(body ?? '').trim();
    if (kind === 'text' && !text) return;

    const { error } = await supabase.from('messages').insert({
      conversation_id: conversationId,
      sender_id: employee.id,
      kind,
      // A caption on a media message, and the message itself on a text one. Empty becomes null so
      // the check constraint sees an absent caption rather than an empty string.
      body: text || null,
      storage_path: media?.path ?? null,
      mime_type: media?.mimeType ?? null,
      byte_size: media?.byteSize ?? null,
      duration_ms: media?.durationMs ?? null,
      reply_to: replyTo,
    });
    if (error) throw error;
  });
}

/**
 * Take back something you said.
 *
 * Soft: the row stays and the bubble says the message was deleted. A hole in a thread reads as a
 * bug, and the reply underneath it would lose what it was answering.
 */
export function useDeleteMessage() {
  return useConversationMutation(async ({ messageId }) => {
    const { data, error } = await supabase
      .from('messages')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', messageId)
      .select('id');
    if (error) throw error;
    if (!data?.length) throw new Error('You can only delete your own messages.');
  });
}

/**
 * Mark this conversation read up to now.
 *
 * Fired when a thread is open and looked at. Deliberately not a mutation with an invalidate storm
 * attached — it runs on nearly every screen view, and refetching the world each time would make
 * reading a conversation the most expensive thing in the app.
 */
export function useMarkRead() {
  const qc = useQueryClient();
  const { employee } = useAuth();
  return useMutation({
    mutationFn: async ({ conversationId }) => {
      if (!employee?.id || !conversationId) return;
      const { error } = await supabase
        .from('conversation_members')
        .update({ last_read_at: new Date().toISOString() })
        .eq('conversation_id', conversationId)
        .eq('employee_id', employee.id);
      if (error && !isMissingSchema(error)) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['conversations'] }),
  });
}

/**
 * Open the conversation with one person, creating it only if there is not one already.
 *
 * The lookup goes through `direct_key` — the sorted pair — rather than "a conversation whose
 * members are exactly these two", which is a query PostgREST cannot express and which would race
 * anyway. If two people press message on each other at the same instant, the unique index rejects
 * the second insert and the catch below re-reads the row the winner just created, so both of them
 * end up in the same conversation instead of two half-conversations.
 */
export function useStartDirect() {
  const qc = useQueryClient();
  const { employee } = useAuth();
  return useMutation({
    mutationFn: async ({ employeeId }) => {
      if (!employee?.id) throw new Error('Your account is not linked to an employee record.');
      if (!employeeId) throw new Error('No colleague was chosen. Pick somebody from the list and try again.');
      if (employeeId === employee.id) throw new Error('You cannot start a conversation with yourself.');

      const key = directKey(employee.id, employeeId);

      /*
       * Both people, in ONE row shape.
       *
       * This is where direct conversations were broken for every user. The two rows used to be
       * written as object literals with different keys — the first carried `role: 'owner'`, the
       * second left role out and expected the column default. PostgREST takes the UNION of the keys
       * across a bulk insert and sends NULL for any key a row omits; it does not fall back to the
       * default. So the second row arrived with role = NULL, the NOT NULL constraint refused it,
       * and the conversation that had already been created was left with no members at all.
       *
       * Groups never hit this because useCreateGroup maps every row through one .map(), which
       * cannot produce a ragged shape. Anything writing more than one row at a time should be built
       * the same way, for the same reason.
       *
       * Written as an upsert so it also REPAIRS: a conversation stranded by the old bug gets its
       * members attached the next time somebody opens it, rather than staying permanently unusable.
       */
      const attachBoth = async (conversationId) => {
        const rows = [
          { conversation_id: conversationId, employee_id: employee.id, role: 'owner' },
          { conversation_id: conversationId, employee_id: employeeId, role: 'member' },
        ];

        const first = await supabase.from('conversation_members').insert(rows);
        if (!first.error) return;
        // 23505 means at least one of the two was already attached — a repair, or a second tab.
        if (first.error.code !== '23505') throw first.error;

        /*
         * One at a time, tolerating the duplicate.
         *
         * NOT `.upsert(..., { ignoreDuplicates: true })`, which is the obvious way to write this and
         * cannot work here. supabase-js turns that into INSERT ... ON CONFLICT DO NOTHING, and an
         * ON CONFLICT clause makes Postgres apply the table's SELECT policy so it can look at the
         * conflicting row. conversation_members_select asks whether you are already a member of the
         * conversation — which is precisely what this call is trying to make you. The identical row
         * inserts fine without the clause and is refused with it.
         *
         * So: a plain insert per row, and a duplicate is success, because the end state is the one
         * we wanted either way.
         */
        for (const row of rows) {
          const { error } = await supabase.from('conversation_members').insert(row);
          if (error && error.code !== '23505') throw error;
        }
      };

      const existing = await supabase
        .from('conversations').select('id').eq('direct_key', key).maybeSingle();
      if (existing.error && !isMissingSchema(existing.error)) throw existing.error;
      if (existing.data?.id) {
        await attachBoth(existing.data.id);
        return existing.data.id;
      }

      const created = await supabase
        .from('conversations')
        .insert({ kind: 'direct', direct_key: key, created_by: employee.id })
        .select('id')
        .single();

      if (created.error) {
        // 23505: the other person created it between our read and our write.
        if (created.error.code === '23505') {
          const again = await supabase
            .from('conversations').select('id').eq('direct_key', key).maybeSingle();
          if (again.error) throw again.error;
          if (again.data?.id) {
            await attachBoth(again.data.id);
            return again.data.id;
          }
          // The row exists — the unique index just said so — but it is not visible yet, because
          // the winner has not finished attaching us as a member. Milliseconds, and only when two
          // people press message on each other at once. Say what happened rather than surfacing
          // "no rows returned", which reads as though the conversation failed to be created.
          throw new Error('They just started this conversation too. Give it a second and try again.');
        }
        throw created.error;
      }

      await attachBoth(created.data.id);
      return created.data.id;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['conversations'] }),
  });
}

export function useCreateGroup() {
  const qc = useQueryClient();
  const { employee } = useAuth();
  return useMutation({
    mutationFn: async ({ title, memberIds = [] }) => {
      if (!employee?.id) throw new Error('Your account is not linked to an employee record.');

      const created = await supabase
        .from('conversations')
        .insert({
          kind: 'group',
          title: String(title ?? '').trim().slice(0, 120) || null,
          created_by: employee.id,
          // No direct_key on a group: two groups with the same people are two legitimate groups,
          // and the unique index would refuse the second one.
          direct_key: null,
        })
        .select('id')
        .single();
      if (created.error) throw created.error;

      const rows = [...new Set([employee.id, ...memberIds])].filter(Boolean).map((id) => ({
        conversation_id: created.data.id,
        employee_id: id,
        role: id === employee.id ? 'owner' : 'member',
      }));
      const { error } = await supabase.from('conversation_members').insert(rows);
      if (error) throw error;

      return created.data.id;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['conversations'] }),
  });
}

/** Add somebody to a group, or take them out of it. */
export function useAddMembers() {
  return useConversationMutation(async ({ conversationId, employeeIds = [] }) => {
    // `role` stated rather than left to the column default. Omitting it from EVERY row happens to
    // work — PostgREST only sends columns that appear somewhere in the batch — but that is one
    // edit away from the ragged-shape bug that broke direct conversations. Say it.
    const rows = employeeIds.filter(Boolean).map((id) => ({
      conversation_id: conversationId, employee_id: id, role: 'member',
    }));
    if (rows.length === 0) return;
    const { error } = await supabase.from('conversation_members').insert(rows);
    if (error) throw error;
  });
}

export function useRemoveMember() {
  return useConversationMutation(async ({ conversationId, employeeId }) => {
    const { error } = await supabase
      .from('conversation_members')
      .delete()
      .eq('conversation_id', conversationId)
      .eq('employee_id', employeeId);
    if (error) throw error;
  });
}

export function useRenameGroup() {
  return useConversationMutation(async ({ conversationId, title }) => {
    const { data, error } = await supabase
      .from('conversations')
      .update({ title: String(title ?? '').trim().slice(0, 120) || null })
      .eq('id', conversationId)
      .select('id');
    if (error) throw error;
    if (!data?.length) throw new Error('Only people in this group can rename it.');
  });
}

/* ---------------------------------------------------------------------- media -- */

/**
 * Put a file in the bucket and return what the message row needs to point at it.
 *
 * The path starts with the conversation id because 0115's storage policies read it back out with
 * storage.foldername() to decide who may fetch the object — see mediaPath.
 */
export function useUploadMedia() {
  return useMutation({
    mutationFn: async ({ conversationId, file, durationMs = null }) => {
      const path = mediaPath(conversationId, file?.name);
      const { error } = await supabase.storage
        .from('chat-media')
        .upload(path, file, { contentType: file?.type || undefined, upsert: false });
      if (error) throw error;
      return {
        path,
        mimeType: file?.type || null,
        byteSize: file?.size ?? null,
        durationMs,
      };
    },
  });
}

/** How long a signed URL lasts. Long enough to watch a video, short enough not to be a link people keep. */
const SIGNED_SECONDS = 60 * 60;

/**
 * A URL for one attachment.
 *
 * Signed rather than public — the bucket is private, so this is the only way to render an image or
 * play a voice note, and the link expires. Cached by path so scrolling a thread of twenty photos
 * does not sign twenty URLs a second time on every re-render.
 */
export function useMediaUrl(storagePath, { enabled = true } = {}) {
  return useQuery({
    enabled: enabled && Boolean(storagePath),
    queryKey: ['chat-media-url', storagePath],
    staleTime: (SIGNED_SECONDS - 300) * 1000,
    queryFn: async () => {
      const { data, error } = await supabase.storage
        .from('chat-media')
        .createSignedUrl(storagePath, SIGNED_SECONDS);
      if (error) throw error;
      return data?.signedUrl ?? null;
    },
  });
}
