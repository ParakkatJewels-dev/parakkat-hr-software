// Talking to a colleague.
//
// Conversation policies and authenticated RPCs enforce access: a query
// returns the conversations you are in (plus, for a super admin, any conversation they open by id),
// and an insert is refused unless you are a member sending as yourself. One boundary, not two.
//
// lib/realtime.js subscribes to Postgres changes and
// invalidates the matching caches, and `messages` is registered there — a second realtime mechanism
// for one screen would be a second thing to debug when the first one is what everything else uses.
import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef } from 'react';
import { supabase } from '../lib/supabaseClient';
import { fetchCollection, fetchInCollection } from '../lib/fetchCollection';
import { useAuth } from '../auth/AuthContext';
import { isMissingSchema } from '../lib/pendingMigration';
import { mediaPath } from '../lib/conversations';
import { fetchMessagePage, flattenMessagePages } from '../lib/messageHistory';
import { renameGroup, setGroupPicture } from '../lib/groupIdentity';
import { receiptCoversMessage } from '../lib/messageReceipts';

/**
 * Number of messages fetched when opening a conversation or loading an earlier page.
 */
export const MESSAGE_PAGE = 200;

const MEMBER_KEY = (row) => `${row.conversation_id}:${row.employee_id}`;

function fetchMembers(conversationIds) {
  // The messaging directory exposes only names/codes, even when HR employee RLS hides another branch.
  return fetchInCollection((ids) => supabase.rpc('messaging_members', { _conversation_ids: ids })
    .order('conversation_id').order('employee_id'), conversationIds, { key: MEMBER_KEY });
}

/** A minimal cross-branch directory, paged so a server row cap cannot hide colleagues. */
export function useMessagingPeople({ query = '', enabled = true } = {}) {
  const { employee } = useAuth();
  const search = String(query ?? '').trim();
  return useQuery({
    enabled: enabled && Boolean(employee?.id),
    queryKey: ['messaging-people', search],
    queryFn: async () => {
      const people = await fetchCollection(() => supabase.rpc('messaging_directory', { _query: search })
        .order('full_name').order('id'));
      return people.map(person => ({ ...person, branch: person.branch_code ? { code: person.branch_code } : null }));
    },
  });
}

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
      const members = await fetchMembers(rows.map((r) => r.id));

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
      const everyone = await fetchMembers(ids);

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
      qc.invalidateQueries({ queryKey: ['admin-conversations'] });
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
      // Also normalize retained uploads when retrying a draft made before the recorder fix.
      duration_ms: Number.isFinite(media?.durationMs) ? Math.round(media.durationMs) : null,
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

/** Acknowledge only IDs actually fetched by this recipient; all receipt times come from the server. */
function useAcknowledgeMessages(seen) {
  const qc = useQueryClient();
  const { employee } = useAuth();
  return useMutation({
    mutationFn: async ({ conversationId, messageIds = [] }) => {
      const ids = [...new Set(messageIds.filter(id => typeof id === 'string' && id))];
      if (!employee?.id || !conversationId || !ids.length) return;
      for (let offset = 0; offset < ids.length; offset += 1000) {
        const { error } = await supabase.rpc('acknowledge_message_receipts', {
          _conversation_id: conversationId,
          _message_ids: ids.slice(offset, offset + 1000),
          _seen: seen,
        });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['conversations'] });
      qc.invalidateQueries({ queryKey: ['admin-conversations'] });
    },
  });
}

/** Call only for received messages rendered in an accepted, actively visible thread. */
export function useMarkRead() {
  return useAcknowledgeMessages(true);
}

/** Delivery means this app received message data; it does not mean the recipient opened the chat. */
export function useMarkDelivered() {
  return useAcknowledgeMessages(false);
}

/** Mount once in the authenticated app. Fetching inbox metadata acknowledges delivery, never seen. */
export function useIncomingMessageDelivery() {
  const { employee } = useAuth();
  const acknowledged = useRef(new Map());
  const { mutateAsync: markDelivered } = useMarkDelivered();
  const query = useQuery({
    enabled: Boolean(employee?.id),
    queryKey: ['message-delivery', employee?.id],
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    queryFn: () => fetchCollection(() => supabase.from('my_conversations')
      .select('id, last_incoming_message_id, last_incoming_message_created_at, last_delivered_at, last_delivered_message_id')
      .order('id')),
  });

  useEffect(() => {
    if (!employee?.id || !query.isSuccess) return;
    for (const conversation of query.data ?? []) {
      const incoming = { id: conversation.last_incoming_message_id, created_at: conversation.last_incoming_message_created_at };
      if (!incoming.id || !incoming.created_at || receiptCoversMessage(conversation, incoming, 'delivered')) continue;
      const key = `${employee.id}:${conversation.id}`;
      const cursor = `${incoming.created_at}:${incoming.id}`;
      if (acknowledged.current.get(key) === cursor) continue;
      acknowledged.current.set(key, cursor);
      markDelivered({ conversationId: conversation.id, messageIds: [incoming.id] }).catch(() => {
        // A transient failure is retried after the next poll or reconnect; it cannot mark anything seen.
        if (acknowledged.current.get(key) === cursor) acknowledged.current.delete(key);
      });
    }
  }, [employee?.id, query.data, query.dataUpdatedAt, query.isSuccess, markDelivered]);

  return query;
}

/** The server creates both memberships and the request state in one transaction. */
export function useStartDirect() {
  const qc = useQueryClient();
  const { employee } = useAuth();
  return useMutation({
    mutationFn: async ({ employeeId }) => {
      if (!employee?.id) throw new Error('Your account is not linked to an employee record.');
      if (!employeeId) throw new Error('No colleague was chosen. Pick somebody from the list and try again.');
      if (employeeId === employee.id) throw new Error('You cannot start a conversation with yourself.');
      const { data, error } = await supabase.rpc('start_direct_conversation', { _employee_id: employeeId });
      if (error) throw error;
      if (!data) throw new Error('The conversation could not be opened. Please try again.');
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['conversations'] }),
  });
}

export function useRespondToMessageRequest() {
  return useConversationMutation(async ({ conversationId, accept }) => {
    if (!conversationId || typeof accept !== 'boolean') throw new Error('Choose whether to accept or decline this message request.');
    const { error } = await supabase.rpc('respond_to_message_request', {
      _conversation_id: conversationId,
      _accept: accept,
    });
    if (error) throw error;
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
    const { data, error } = await supabase
      .from('conversation_members')
      .delete()
      .eq('conversation_id', conversationId)
      .eq('employee_id', employeeId).select('employee_id');
    if (error) throw error;
    if (!data?.length) throw new Error('This group member could not be removed. Refresh the chat and try again.');
  });
}

export function useRenameGroup() {
  return useConversationMutation((params) => renameGroup(supabase, params));
}

export function useSetGroupPicture() {
  return useConversationMutation((params) => setGroupPicture(supabase, params));
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
