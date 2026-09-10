// Talking to people.
//
// Two panes on a desktop, one at a time on a phone: the list is the screen until you open a
// conversation, and the thread is the screen until you come back. A phone showing a 40%-wide
// conversation list beside a 60%-wide thread gives you two things too narrow to use.
//
// What is deliberately NOT here:
//   * Typing indicators and read receipts. Both need a write per keystroke or per message per
//     person, and both answer questions ("is he ignoring me", "did she read it at 11pm") that an
//     internal work tool is better off not answering.
//   * Live calls. Different project — WebRTC, signalling, and relay servers that cost money every
//     month whether anybody calls or not.
import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import {
  MessageSquare, Send, Plus, X, Search, Loader2, ArrowLeft, Users, Paperclip, Image as ImageIcon,
  Mic, Square, Trash2, Download, FileText, AlertTriangle, UserPlus, PenLine, Play,
} from 'lucide-react';
import {
  useConversations, useMessages, useSendMessage, useDeleteMessage, useMarkRead,
  useStartDirect, useCreateGroup, useAddMembers, useRemoveMember, useRenameGroup,
  useUploadMedia, useMediaUrl,
} from '../data/messages';
import { useEmployees } from '../data/employees';
import { useAuth } from '../auth/AuthContext';
import {
  conversationName, previewOf, sortConversations, groupByDay, showsSender, isMine, hasUnread,
  others,
} from '../lib/conversations';
import { humanDbError } from '../lib/dbErrors';
import { relativeTime, istToday } from '../lib/dates';
import { btnClass } from './ui/Btn';
import Avatar from './ui/Avatar';
import IconInput from './ui/IconInput';
import ConfirmDialog from './ui/ConfirmDialog';
import { useFocusRow } from '../lib/useFocusRow';

const INPUT =
  'w-full text-sm rounded-xl px-3 py-2 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-850 text-neutral-800 dark:text-neutral-200 focus:outline-none focus:border-[#0ea971] transition-colors';

const readableSize = (bytes) =>
  !bytes ? '' : bytes < 1024 ? `${bytes} B`
  : bytes < 1048576 ? `${Math.round(bytes / 1024)} KB`
  : `${(bytes / 1048576).toFixed(1)} MB`;

const clockOf = (iso) => {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
};

/** "Today" / "Yesterday" / the date. The pure helper hands back an ISO day; the wording is here. */
function dayLabel(day) {
  const today = istToday();
  if (day === today) return 'Today';
  const yesterday = new Date(`${today}T00:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  if (day === yesterday.toISOString().slice(0, 10)) return 'Yesterday';
  try {
    return new Date(`${day}T00:00:00Z`).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
  } catch { return day; }
}

export default function Messages() {
  const { employee } = useAuth();
  const me = employee?.id ?? null;
  const { data, isLoading, error } = useConversations();
  const conversations = useMemo(() => sortConversations(data?.conversations ?? []), [data]);

  const [openId, setOpenId] = useState(null);
  const [composing, setComposing] = useState(false);   // the new-conversation panel
  const [query, setQuery] = useState('');

  // A notification about a message carries the conversation id, so following one opens the room it
  // was about rather than the list it happens to be in.
  const { focusId } = useFocusRow();
  useEffect(() => {
    if (focusId && conversations.some((c) => c.id === focusId)) setOpenId(focusId);
  }, [focusId, conversations]);

  const open = conversations.find((c) => c.id === openId) ?? null;

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return conversations;
    return conversations.filter((c) =>
      conversationName(c, me).toLowerCase().includes(needle)
      || String(c.last_body ?? '').toLowerCase().includes(needle)
    );
  }, [conversations, query, me]);

  // 0115 ships separately from this client. Saying so beats an empty list that looks like a bug.
  if (data?.pending) {
    return (
      <div className="page-shell flex flex-col items-center justify-center py-20 text-center animate-fade-in">
        <MessageSquare size={28} className="text-neutral-400 dark:text-[#0c9765] mb-3" />
        <h2 className="text-base font-bold text-neutral-800 dark:text-warm-gray-100">Messages are not switched on yet</h2>
        <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1 max-w-sm">
          The database migration for messaging (0115) has not been run against this project. Nothing
          is broken — the screen will work as soon as it has.
        </p>
      </div>
    );
  }

  return (
    <div className="page-shell messages-shell animate-fade-in">
      <div className="messages-panes flex gap-4 h-[calc(100vh-13rem)] min-h-[24rem]">
        {/* The list. On a phone it IS the screen until a conversation is opened. */}
        <aside className={`messages-list flex flex-col gap-3 w-full lg:w-80 lg:shrink-0 ${open ? 'hidden lg:flex' : 'flex'}`}>
          <div className="flex items-center gap-2">
            <IconInput
              icon={Search}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search conversations"
              placeholder="Search conversations…"
              className="flex-1 min-w-0"
              inputClassName={INPUT}
            />
            <button
              type="button"
              onClick={() => setComposing(true)}
              aria-label="Start a new conversation"
              className={btnClass('primary', 'md', true)}
            >
              <Plus size={15} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto space-y-1.5 pr-0.5">
            {isLoading && (
              <p className="flex items-center gap-2 text-xs text-neutral-400 px-1 py-3">
                <Loader2 size={13} className="animate-spin" /> Loading conversations…
              </p>
            )}
            {error && (
              <p className="flex items-start gap-2 text-xs text-rose-600 dark:text-rose-400 px-1 py-3">
                <AlertTriangle size={13} className="mt-0.5 shrink-0" /> {humanDbError(error)}
              </p>
            )}
            {!isLoading && visible.length === 0 && (
              <div className="px-1 py-6 text-center">
                <p className="text-xs text-neutral-500 dark:text-neutral-400">
                  {query ? 'No conversation matches that.' : 'No conversations yet.'}
                </p>
                {!query && (
                  <button type="button" onClick={() => setComposing(true)} className={`${btnClass('primary', 'sm')} mt-3`}>
                    <Plus size={12} /> Start one
                  </button>
                )}
              </div>
            )}
            {visible.map((c) => (
              <ConversationRow
                key={c.id}
                conversation={c}
                me={me}
                active={c.id === openId}
                onOpen={() => setOpenId(c.id)}
              />
            ))}
          </div>
        </aside>

        {/* The thread. */}
        <section className={`messages-thread flex-1 min-w-0 ${open ? 'flex' : 'hidden lg:flex'} flex-col`}>
          {open ? (
            <Thread conversation={open} me={me} onBack={() => setOpenId(null)} />
          ) : (
            <div className="hidden lg:flex flex-1 flex-col items-center justify-center text-center">
              <MessageSquare size={26} className="text-neutral-300 dark:text-neutral-700 mb-2" />
              <p className="text-xs text-neutral-500 dark:text-neutral-400">Pick a conversation, or start a new one.</p>
            </div>
          )}
        </section>
      </div>

      {composing && (
        <NewConversation
          me={me}
          onClose={() => setComposing(false)}
          onOpened={(id) => { setComposing(false); setOpenId(id); }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ the list -- */

function ConversationRow({ conversation, me, active, onOpen }) {
  const name = conversationName(conversation, me);
  const unread = hasUnread(conversation);
  const isGroup = conversation.kind === 'group';

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={active ? 'page' : undefined}
      className={`conversation-row w-full text-left flex items-center gap-2.5 rounded-xl px-2.5 py-2 border transition-colors cursor-pointer ${
        active
          ? 'border-[#0ea971]/30 bg-[#0ea971]/10'
          : 'border-transparent hover:bg-neutral-100 dark:hover:bg-neutral-900'
      }`}
    >
      {isGroup
        ? <span className="shrink-0 h-8 w-8 rounded-full grid place-items-center bg-neutral-150 dark:bg-neutral-850 text-neutral-500"><Users size={14} /></span>
        : <Avatar name={name} size="md" />}

      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-2">
          <span className={`truncate text-sm ${unread ? 'font-extrabold text-neutral-900 dark:text-white' : 'font-semibold text-neutral-800 dark:text-neutral-200'}`}>
            {name}
          </span>
          <span className="shrink-0 text-2xs font-mono text-neutral-400">
            {conversation.last_message_at ? relativeTime(conversation.last_message_at) : ''}
          </span>
        </span>
        <span className="flex items-center justify-between gap-2 mt-0.5">
          <span className={`truncate text-2xs ${unread ? 'text-neutral-700 dark:text-neutral-300 font-semibold' : 'text-neutral-500 dark:text-neutral-400'}`}>
            {previewOf(conversation, me)}
          </span>
          {unread && (
            <span
              className="shrink-0 text-2xs font-mono font-bold px-1.5 rounded-full bg-[#0ea971] text-white"
              aria-label={`${conversation.unread_count} unread`}
            >
              {conversation.unread_count > 99 ? '99+' : conversation.unread_count}
            </span>
          )}
        </span>
      </span>
    </button>
  );
}

/* ---------------------------------------------------------------- the thread -- */

function Thread({ conversation, me, onBack }) {
  const { data: messages = [], isLoading } = useMessages(conversation.id);
  const markRead = useMarkRead();
  const [managing, setManaging] = useState(false);
  const bottomRef = useRef(null);

  const name = conversationName(conversation, me);
  const isGroup = conversation.kind === 'group';
  const days = useMemo(() => groupByDay(messages), [messages]);

  // Opening it, and every message that lands while it is open, counts as read.
  const unread = conversation.unread_count;
  useEffect(() => {
    if (unread > 0) markRead.mutate({ conversationId: conversation.id });
    // markRead is a stable mutation object; including it would re-fire this on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation.id, unread]);

  // Stick to the bottom, which is where a conversation is read from.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, conversation.id]);

  return (
    <div className="flex flex-col h-full min-h-0 rounded-2xl border border-neutral-200 dark:border-neutral-850 bg-white dark:bg-charcoal-900/40 overflow-hidden">
      <header className="shrink-0 flex items-center gap-2.5 px-3 py-2.5 border-b border-neutral-200 dark:border-neutral-850">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to conversations"
          className="lg:hidden p-1.5 -ml-1 rounded-lg text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-900 cursor-pointer"
        >
          <ArrowLeft size={16} />
        </button>
        {isGroup
          ? <span className="shrink-0 h-8 w-8 rounded-full grid place-items-center bg-neutral-150 dark:bg-neutral-850 text-neutral-500"><Users size={14} /></span>
          : <Avatar name={name} size="md" />}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold text-neutral-900 dark:text-white">{name}</p>
          <p className="truncate text-2xs text-neutral-500 dark:text-neutral-400">
            {isGroup
              ? `${conversation.members?.length ?? 0} people`
              : others(conversation, me)[0]?.employee?.employee_code || ''}
          </p>
        </div>
        {isGroup && (
          <button
            type="button"
            onClick={() => setManaging((v) => !v)}
            aria-label="Group settings"
            aria-expanded={managing}
            className="p-1.5 rounded-lg text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-900 cursor-pointer"
          >
            <UserPlus size={15} />
          </button>
        )}
      </header>

      {managing && isGroup && (
        <GroupPanel conversation={conversation} me={me} onClose={() => setManaging(false)} />
      )}

      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-3">
        {isLoading && (
          <p className="flex items-center justify-center gap-2 text-xs text-neutral-400 py-6">
            <Loader2 size={13} className="animate-spin" /> Loading…
          </p>
        )}
        {!isLoading && messages.length === 0 && (
          <p className="text-center text-xs text-neutral-500 dark:text-neutral-400 py-8">
            Nothing here yet. Say something.
          </p>
        )}
        {days.map(({ day, messages: rows }) => (
          <div key={day} className="space-y-1.5">
            <p className="sticky top-0 z-10 text-center">
              <span className="inline-block text-2xs font-bold uppercase tracking-wide text-neutral-500 dark:text-neutral-400 bg-neutral-100 dark:bg-neutral-900 rounded-full px-2.5 py-0.5">
                {dayLabel(day)}
              </span>
            </p>
            {rows.map((m, i) => (
              <MessageBubble
                key={m.id}
                message={m}
                me={me}
                withSender={showsSender(m, rows[i - 1] ?? null, { kind: conversation.kind })}
              />
            ))}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <Composer conversationId={conversation.id} />
    </div>
  );
}

/* --------------------------------------------------------------- one message -- */

function MessageBubble({ message, me, withSender }) {
  const mine = isMine(message, me);
  const [confirming, setConfirming] = useState(false);
  const remove = useDeleteMessage();

  if (message.deleted_at) {
    return (
      <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
        <p className="text-2xs italic text-neutral-400 dark:text-neutral-600 px-3 py-1.5 rounded-2xl border border-dashed border-neutral-200 dark:border-neutral-850">
          Message deleted
        </p>
      </div>
    );
  }

  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'} group`}>
      <div className={`max-w-[85%] sm:max-w-[70%] min-w-0 ${mine ? 'items-end' : 'items-start'} flex flex-col gap-0.5`}>
        {withSender && !mine && (
          <span className="text-2xs font-bold text-neutral-500 dark:text-neutral-400 px-1">
            {message.sender?.full_name ?? 'Unknown'}
          </span>
        )}

        <div className={`rounded-2xl px-3 py-2 text-sm break-words ${
          mine
            ? 'bg-[#0ea971] text-white rounded-br-md'
            : 'bg-neutral-100 dark:bg-neutral-850 text-neutral-800 dark:text-neutral-100 rounded-bl-md'
        }`}>
          {message.kind !== 'text' && <MediaBubble message={message} mine={mine} />}
          {message.body && (
            <p className={`whitespace-pre-wrap ${message.kind !== 'text' ? 'mt-1.5' : ''}`}>{message.body}</p>
          )}
        </div>

        <span className="flex items-center gap-2 px-1">
          <span className="text-2xs font-mono text-neutral-400">{clockOf(message.created_at)}</span>
          {mine && (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              aria-label="Delete this message"
              className="text-2xs text-neutral-400 hover:text-rose-500 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity cursor-pointer"
            >
              <Trash2 size={11} />
            </button>
          )}
        </span>
      </div>

      {confirming && (
        <ConfirmDialog
          title="Delete this message?"
          confirmLabel="Delete"
          busy={remove.isPending}
          error={remove.error?.message}
          onCancel={() => { remove.reset(); setConfirming(false); }}
          onConfirm={async () => {
            try { await remove.mutateAsync({ messageId: message.id, conversationId: message.conversation_id }); setConfirming(false); }
            catch { /* shown in the dialog */ }
          }}
        >
          <p>Everyone in the conversation will see that a message was deleted, but not what it said.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

/** A photo, a clip, a voice note or a file — fetched through a signed URL, because the bucket is private. */
function MediaBubble({ message, mine }) {
  const { data: url, isLoading, error } = useMediaUrl(message.storage_path);

  if (isLoading) {
    return (
      <p className={`flex items-center gap-1.5 text-2xs ${mine ? 'text-white/80' : 'text-neutral-500'}`}>
        <Loader2 size={11} className="animate-spin" /> Loading…
      </p>
    );
  }
  if (error || !url) {
    return (
      <p className={`flex items-center gap-1.5 text-2xs ${mine ? 'text-white/80' : 'text-neutral-500'}`}>
        <AlertTriangle size={11} /> This attachment could not be loaded.
      </p>
    );
  }

  if (message.kind === 'image') {
    return (
      <a href={url} target="_blank" rel="noreferrer" className="block">
        <img
          src={url}
          alt={message.body || 'Shared photo'}
          loading="lazy"
          className="rounded-xl max-h-72 w-auto object-contain bg-black/5"
        />
      </a>
    );
  }

  if (message.kind === 'video') {
    // controls, and no autoplay: a thread of five clips all playing at once is unusable, and on a
    // phone it is somebody's data allowance.
    return <video src={url} controls preload="metadata" className="rounded-xl max-h-72 w-full bg-black" />;
  }

  if (message.kind === 'voice') {
    return (
      <span className="flex items-center gap-2 min-w-[12rem]">
        <Play size={13} className={mine ? 'text-white/90' : 'text-[#0ea971]'} />
        <audio src={url} controls preload="metadata" className="h-8 max-w-full" />
      </span>
    );
  }

  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className={`flex items-center gap-2 rounded-xl px-2 py-1.5 ${mine ? 'bg-white/15' : 'bg-white dark:bg-neutral-900'}`}
    >
      <FileText size={14} className="shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-semibold">
          {message.storage_path?.split('/').pop()?.replace(/^\d+-\w+-/, '') ?? 'File'}
        </span>
        {message.byte_size && (
          <span className={`block text-2xs font-mono ${mine ? 'text-white/70' : 'text-neutral-500'}`}>
            {readableSize(message.byte_size)}
          </span>
        )}
      </span>
      <Download size={13} className="shrink-0" />
    </a>
  );
}

/* -------------------------------------------------------------- the composer -- */

const KIND_FOR = (file) => {
  const type = file?.type ?? '';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'voice';
  return 'file';
};

const MAX_BYTES = 25 * 1024 * 1024;   // matches the bucket's limit in 0115

function Composer({ conversationId }) {
  const [body, setBody] = useState('');
  const [pending, setPending] = useState(null);   // { file, kind, durationMs } awaiting send
  const [localError, setLocalError] = useState(null);
  const send = useSendMessage();
  const upload = useUploadMedia();
  const fileRef = useRef(null);
  const imageRef = useRef(null);

  const busy = send.isPending || upload.isPending;
  const error = localError || send.error || upload.error;

  const pick = (file) => {
    setLocalError(null);
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setLocalError(new Error(`That file is ${readableSize(file.size)}. The limit is 25 MB.`));
      return;
    }
    setPending({ file, kind: KIND_FOR(file), durationMs: null });
  };

  const submit = async (e) => {
    e?.preventDefault();
    if (busy) return;
    setLocalError(null);

    try {
      if (pending) {
        const media = await upload.mutateAsync({
          conversationId, file: pending.file, durationMs: pending.durationMs,
        });
        await send.mutateAsync({ conversationId, body, kind: pending.kind, media });
        setPending(null);
      } else {
        if (!body.trim()) return;
        await send.mutateAsync({ conversationId, body });
      }
      setBody('');
    } catch { /* surfaced below */ }
  };

  return (
    <form onSubmit={submit} className="shrink-0 border-t border-neutral-200 dark:border-neutral-850 p-2.5 space-y-2">
      {pending && (
        <div className="flex items-center gap-2 rounded-xl border border-neutral-200 dark:border-neutral-850 bg-neutral-50 dark:bg-neutral-950 px-2.5 py-1.5">
          <Paperclip size={12} className="shrink-0 text-[#0ea971]" />
          <span className="min-w-0 flex-1 truncate text-2xs font-semibold text-neutral-700 dark:text-neutral-300">
            {pending.file.name}
          </span>
          <span className="shrink-0 text-2xs font-mono text-neutral-400">{readableSize(pending.file.size)}</span>
          <button
            type="button"
            onClick={() => setPending(null)}
            aria-label="Remove attachment"
            className="shrink-0 text-neutral-400 hover:text-rose-500 cursor-pointer"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {error && (
        <p className="flex items-start gap-1.5 text-2xs text-rose-600 dark:text-rose-400">
          <AlertTriangle size={11} className="mt-0.5 shrink-0" /> {humanDbError(error)}
        </p>
      )}

      <div className="flex items-end gap-1.5">
        <input
          ref={imageRef} type="file" accept="image/*,video/*" className="hidden"
          onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }}
        />
        <input
          ref={fileRef} type="file" className="hidden"
          onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }}
        />

        <button
          type="button" onClick={() => imageRef.current?.click()} disabled={busy}
          aria-label="Send a photo or video" title="Photo or video"
          className={btnClass('ghost', 'md', true)}
        >
          <ImageIcon size={15} />
        </button>
        <button
          type="button" onClick={() => fileRef.current?.click()} disabled={busy}
          aria-label="Send a file" title="File"
          className={btnClass('ghost', 'md', true)}
        >
          <Paperclip size={15} />
        </button>
        <VoiceButton
          disabled={busy || Boolean(pending)}
          onRecorded={(file, durationMs) => setPending({ file, kind: 'voice', durationMs })}
          onError={(err) => setLocalError(err)}
        />

        <textarea
          rows={1}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter makes a new line — what every chat does, and what people's
            // hands already expect.
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
          }}
          placeholder={pending ? 'Add a caption…' : 'Write a message…'}
          className={INPUT + ' resize-none max-h-32 flex-1'}
          maxLength={4000}
        />

        <button
          type="submit"
          disabled={busy || (!body.trim() && !pending)}
          aria-label="Send"
          className={btnClass('primary', 'md', true)}
        >
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
        </button>
      </div>
    </form>
  );
}

/**
 * Hold to record, press again to stop.
 *
 * MediaRecorder's supported container differs by browser — Chrome and Android want webm/opus,
 * Safari and iOS produce mp4/aac — so the type is asked for rather than assumed. Getting this wrong
 * does not throw; it produces a file the other person's browser silently refuses to play.
 *
 * The microphone stream is stopped on every exit path. A page that keeps the mic open leaves the
 * recording indicator lit, which people reasonably read as being listened to.
 */
function VoiceButton({ disabled, onRecorded, onError }) {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const startedRef = useRef(0);
  const timerRef = useRef(null);

  const stopStream = useCallback(() => {
    recorderRef.current?.stream?.getTracks?.().forEach((t) => t.stop());
    recorderRef.current = null;
    clearInterval(timerRef.current);
    timerRef.current = null;
  }, []);

  // Unmounting mid-recording must not leave the microphone live.
  useEffect(() => stopStream, [stopStream]);

  const start = async () => {
    try {
      if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        throw new Error('This browser cannot record audio. You can still attach an audio file.');
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac']
        .find((t) => MediaRecorder.isTypeSupported?.(t));

      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data?.size) chunksRef.current.push(e.data); };
      rec.onstop = () => {
        const type = rec.mimeType || mimeType || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type });
        const ext = type.includes('mp4') || type.includes('aac') ? 'm4a' : 'webm';
        const durationMs = Date.now() - startedRef.current;
        stopStream();
        setRecording(false);
        setSeconds(0);
        if (blob.size > 0) {
          onRecorded(new File([blob], `voice-note.${ext}`, { type }), durationMs);
        }
      };

      recorderRef.current = rec;
      startedRef.current = Date.now();
      rec.start();
      setRecording(true);
      setSeconds(0);
      timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
    } catch (err) {
      stopStream();
      setRecording(false);
      onError(
        err?.name === 'NotAllowedError'
          ? new Error('Microphone access was refused. Allow it in your browser settings to send a voice note.')
          : err
      );
    }
  };

  const stop = () => {
    try { recorderRef.current?.stop(); }
    catch { stopStream(); setRecording(false); }
  };

  if (recording) {
    return (
      <button
        type="button" onClick={stop} aria-label="Stop recording"
        className={`${btnClass('dangerSolid', 'md')} shrink-0 gap-1.5`}
      >
        <Square size={13} />
        <span className="font-mono text-2xs">
          {String(Math.floor(seconds / 60)).padStart(2, '0')}:{String(seconds % 60).padStart(2, '0')}
        </span>
      </button>
    );
  }

  return (
    <button
      type="button" onClick={start} disabled={disabled}
      aria-label="Record a voice note" title="Voice note"
      className={btnClass('ghost', 'md', true)}
    >
      <Mic size={15} />
    </button>
  );
}

/* ------------------------------------------------------- starting a new one -- */

function NewConversation({ me, onClose, onOpened }) {
  const [mode, setMode] = useState('direct');   // 'direct' | 'group'
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState([]);
  const [title, setTitle] = useState('');
  const { data: employees = [] } = useEmployees();
  const startDirect = useStartDirect();
  const createGroup = useCreateGroup();

  const busy = startDirect.isPending || createGroup.isPending;
  const error = startDirect.error || createGroup.error;

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const pool = employees.filter((e) => e.id !== me);
    if (!needle) return pool.slice(0, 12);
    return pool.filter(
      (e) => (e.full_name || '').toLowerCase().includes(needle)
        || (e.employee_code || '').toLowerCase().includes(needle)
    ).slice(0, 20);
  }, [employees, query, me]);

  const choose = async (employeeId) => {
    if (mode === 'group') {
      setPicked((cur) => (cur.includes(employeeId) ? cur.filter((x) => x !== employeeId) : [...cur, employeeId]));
      return;
    }
    try { onOpened(await startDirect.mutateAsync({ employeeId })); } catch { /* shown below */ }
  };

  const makeGroup = async () => {
    try { onOpened(await createGroup.mutateAsync({ title, memberIds: picked })); } catch { /* shown below */ }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full sm:max-w-md bg-white dark:bg-neutral-950 rounded-t-2xl sm:rounded-2xl border border-neutral-200 dark:border-neutral-850 p-4 space-y-3 max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-bold text-neutral-900 dark:text-white">
            {mode === 'group' ? 'New group' : 'New message'}
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-neutral-400 hover:text-neutral-700 dark:hover:text-white cursor-pointer">
            <X size={16} />
          </button>
        </div>

        <div className="flex rounded-lg border border-neutral-200 dark:border-neutral-850 overflow-hidden">
          {[['direct', 'One person'], ['group', 'Group']].map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => { setMode(value); setPicked([]); }}
              aria-current={mode === value ? 'page' : undefined}
              className={`flex-1 text-xs font-semibold py-1.5 cursor-pointer transition-colors ${
                mode === value
                  ? 'bg-[#0ea971]/15 text-[#0c9765] dark:bg-[#0ea971] dark:text-white'
                  : 'bg-neutral-50 dark:bg-neutral-900 text-neutral-500 hover:text-neutral-900 dark:hover:text-white'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {mode === 'group' && (
          <input
            className={INPUT}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Group name (optional)"
            maxLength={120}
          />
        )}

        <IconInput
          icon={Search}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search people"
          placeholder="Search by name or code…"
          inputClassName={INPUT}
        />

        {error && (
          <p className="flex items-start gap-1.5 text-2xs text-rose-600 dark:text-rose-400">
            <AlertTriangle size={11} className="mt-0.5 shrink-0" /> {humanDbError(error)}
          </p>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto -mx-1 px-1 divide-y divide-neutral-150 dark:divide-neutral-850/60">
          {results.length === 0 && (
            <p className="py-6 text-center text-xs text-neutral-500">Nobody matches that.</p>
          )}
          {results.map((e) => {
            const on = picked.includes(e.id);
            return (
              <button
                key={e.id}
                type="button"
                onClick={() => choose(e.id)}
                disabled={busy}
                className={`w-full text-left flex items-center gap-2.5 py-2 px-1 cursor-pointer transition-colors ${
                  on ? 'bg-[#0ea971]/10' : 'hover:bg-neutral-50 dark:hover:bg-neutral-900'
                }`}
              >
                <Avatar name={e.full_name} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-semibold text-neutral-800 dark:text-neutral-200">{e.full_name}</span>
                  <span className="block truncate text-2xs font-mono text-neutral-500">
                    {e.employee_code}{e.branch?.code ? ` · ${e.branch.code}` : ''}
                  </span>
                </span>
                {mode === 'group' && on && <span className="text-2xs font-bold text-[#0c9765] dark:text-[#10b981]">added</span>}
              </button>
            );
          })}
        </div>

        {mode === 'group' && (
          <button
            type="button"
            onClick={makeGroup}
            disabled={busy || picked.length === 0}
            className={`${btnClass('primary')} w-full`}
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Users size={13} />}
            Create group{picked.length > 0 ? ` with ${picked.length}` : ''}
          </button>
        )}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- managing a group -- */

function GroupPanel({ conversation, me, onClose }) {
  const [query, setQuery] = useState('');
  const [title, setTitle] = useState(conversation.title ?? '');
  const { data: employees = [] } = useEmployees();
  const add = useAddMembers();
  const remove = useRemoveMember();
  const rename = useRenameGroup();

  const memberIds = new Set((conversation.members ?? []).map((m) => m.employee_id));
  const error = add.error || remove.error || rename.error;

  const candidates = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    return employees
      .filter((e) => !memberIds.has(e.id))
      .filter((e) => (e.full_name || '').toLowerCase().includes(needle) || (e.employee_code || '').toLowerCase().includes(needle))
      .slice(0, 8);
    // memberIds is rebuilt each render from props; listing it would defeat the memo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employees, query, conversation.members]);

  return (
    <div className="shrink-0 border-b border-neutral-200 dark:border-neutral-850 bg-neutral-50 dark:bg-neutral-950/60 p-3 space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-2xs font-bold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">Group</p>
        <button type="button" onClick={onClose} aria-label="Close group settings" className="text-neutral-400 hover:text-neutral-700 dark:hover:text-white cursor-pointer">
          <X size={13} />
        </button>
      </div>

      <div className="flex items-center gap-1.5">
        <input
          className={INPUT + ' text-xs'}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Group name"
          maxLength={120}
        />
        <button
          type="button"
          onClick={() => rename.mutate({ conversationId: conversation.id, title })}
          disabled={rename.isPending || title === (conversation.title ?? '')}
          className={btnClass('ghost', 'sm')}
        >
          {rename.isPending ? <Loader2 size={12} className="animate-spin" /> : <PenLine size={12} />} Rename
        </button>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {(conversation.members ?? []).map((m) => (
          <span key={m.employee_id} className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 dark:border-neutral-850 bg-white dark:bg-neutral-900 px-2 py-1 text-2xs">
            <span className="font-semibold text-neutral-700 dark:text-neutral-300">
              {m.employee?.full_name ?? 'Unknown'}
            </span>
            {m.employee_id === me && <span className="opacity-60">(you)</span>}
            <button
              type="button"
              onClick={() => remove.mutate({ conversationId: conversation.id, employeeId: m.employee_id })}
              aria-label={m.employee_id === me ? 'Leave this group' : `Remove ${m.employee?.full_name ?? 'this person'}`}
              title={m.employee_id === me ? 'Leave this group' : 'Remove'}
              className="opacity-50 hover:opacity-100 hover:text-rose-500 cursor-pointer"
            >
              <X size={10} />
            </button>
          </span>
        ))}
      </div>

      <IconInput
        icon={Search}
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Add someone to this group"
        placeholder="Add someone…"
        inputClassName={INPUT + ' text-xs'}
      />

      {candidates.length > 0 && (
        <div className="rounded-xl border border-neutral-200 dark:border-neutral-850 divide-y divide-neutral-150 dark:divide-neutral-850/60 overflow-hidden">
          {candidates.map((e) => (
            <button
              key={e.id}
              type="button"
              onClick={() => { add.mutate({ conversationId: conversation.id, employeeIds: [e.id] }); setQuery(''); }}
              className="w-full text-left px-2.5 py-1.5 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-900 flex items-center justify-between cursor-pointer"
            >
              <span className="font-semibold text-neutral-800 dark:text-neutral-200">{e.full_name}</span>
              <span className="font-mono text-2xs text-neutral-500">{e.employee_code}</span>
            </button>
          ))}
        </div>
      )}

      {error && (
        <p className="flex items-start gap-1.5 text-2xs text-rose-600 dark:text-rose-400">
          <AlertTriangle size={11} className="mt-0.5 shrink-0" /> {humanDbError(error)}
        </p>
      )}
    </div>
  );
}
