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
  Mic, Square, Trash2, Download, FileText, AlertTriangle, UserPlus, PenLine, Play, Smile, ChevronDown, Reply, ArrowDown,
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
  others, filterConversations, replyPreviewOf,
} from '../lib/conversations';
import { humanDbError } from '../lib/dbErrors';
import { relativeTime, istToday } from '../lib/dates';
import { btnClass } from './ui/Btn';
import Avatar from './ui/Avatar';
import IconInput from './ui/IconInput';
import ConfirmDialog from './ui/ConfirmDialog';
import { useFocusRow } from '../lib/useFocusRow';
import { messageLinkParts } from '../lib/messageLinks';
import './messages.css';

const INPUT =
  'w-full text-sm rounded-xl px-3 py-2 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-850 text-neutral-800 dark:text-neutral-200 focus:outline-none focus:border-brand transition-colors';

const readableSize = (bytes) =>
  !bytes ? '' : bytes < 1024 ? `${bytes} B`
  : bytes < 1048576 ? `${Math.round(bytes / 1024)} KB`
  : `${(bytes / 1048576).toFixed(1)} MB`;

const clockOf = (iso) => {
  try {
    return new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
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
  const { employee, isSuperAdmin } = useAuth();
  const me = employee?.id ?? null;
  const { data, isLoading, error } = useConversations();
  const conversations = useMemo(() => sortConversations(data?.conversations ?? []), [data]);

  const [openId, setOpenId] = useState(null);
  const [composing, setComposing] = useState(false);   // the new-conversation panel
  const [query, setQuery] = useState('');
  const [chatFilter, setChatFilter] = useState('all');

  // A notification about a message carries the conversation id, so following one opens the room it
  // was about rather than the list it happens to be in.
  const { focusId } = useFocusRow();
  useEffect(() => {
    if (focusId && conversations.some((c) => c.id === focusId)) setOpenId(focusId);
  }, [focusId, conversations]);

  const open = conversations.find((c) => c.id === openId) ?? null;

  const visible = useMemo(
    () => filterConversations(conversations, { query, filter: chatFilter, me }),
    [conversations, query, chatFilter, me]
  );

  /*
   * A login that is not a person.
   *
   * Reachable only by URL now — navMap drops the Messages entry for an account with no employee
   * record (needsEmployee) — but a bookmark or an old link still lands here, so it should say
   * something useful rather than nothing.
   *
   * It used to advise linking the account to an employee. For the super admin that is the wrong
   * advice: being a system login rather than a member of staff is the point of it, and taking that
   * advice would put the owner's name in every colleague's people-picker. So the super admin is
   * pointed at the Chat Monitor, which is the screen that actually does what they came here for.
   */
  if (!me) {
    return (
      <div className="page-shell flex flex-col items-center justify-center py-20 text-center animate-fade-in">
        <MessageSquare size={28} className="text-brand-ink mb-3" />
        <h2 className="text-base font-bold text-neutral-800 dark:text-warm-gray-100">
          This login has no inbox
        </h2>
        <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1 max-w-md">
          Conversations happen between employees, and this account is not one — which is correct for
          an administrator login.
          {isSuperAdmin
            ? ' To read the company\u2019s conversations, use Administration \u2192 Chat Monitor.'
            : ' Sign in with your staff account to use messaging.'}
        </p>
      </div>
    );
  }

  // 0115 ships separately from this client. Saying so beats an empty list that looks like a bug.
  if (data?.pending) {
    return (
      <div className="page-shell flex flex-col items-center justify-center py-20 text-center animate-fade-in">
        <MessageSquare size={28} className="text-brand-ink mb-3" />
        <h2 className="text-base font-bold text-neutral-800 dark:text-warm-gray-100">Messages are not switched on yet</h2>
        <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1 max-w-sm">
          The database migration for messaging (0115) has not been run against this project. Nothing
          is broken — the screen will work as soon as it has.
        </p>
      </div>
    );
  }

  return (
    <div className="messages-shell animate-fade-in">
      {/* Each pane scrolls independently; the composer stays outside the message scroller. */}
      <div className="messages-panes">
        {/* The list. On a phone it IS the screen until a conversation is opened. */}
        <aside className={`messages-list ${open ? 'messages-list-collapsed' : ''}`} aria-label="Chats">
          <header className="messages-list-header">
            <h1>Chats</h1>
            <button type="button" className="messages-icon-button" onClick={() => setComposing(true)} aria-label="Start a new conversation" title="New chat"><PenLine size={21} /></button>
          </header>
          <label className="messages-search">
            <Search size={18} aria-hidden="true" />
            <input type="search" value={query} onChange={(event) => setQuery(event.target.value)}
              aria-label="Search conversations" placeholder="Search or start a new chat" />
          </label>
          <div className="messages-list-filters" aria-label="Filter chats">
            {[['all', 'All'], ['unread', 'Unread'], ['groups', 'Groups']].map(([value, label]) => (
              <button type="button" key={value} aria-pressed={chatFilter === value} onClick={() => setChatFilter(value)}>{label}</button>
            ))}
          </div>

          <div className="messages-conversation-list">
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
                  {query ? 'No chats match your search.' : chatFilter === 'unread' ? 'You’re all caught up.' : chatFilter === 'groups' ? 'No group chats yet.' : 'No conversations yet.'}
                </p>
                {!query && (
                  <button
                    type="button"
                    onClick={() => setComposing(true)}
                    className="mt-3 inline-flex items-center gap-1.5 h-11 px-4 rounded-xl bg-brand-action text-brand-on text-xs font-bold hover:bg-brand-action-hover transition-colors cursor-pointer"
                  >
                    <Plus size={16} /> Start one
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
        <section className={`messages-thread ${open ? 'messages-thread-open' : ''}`} aria-label="Conversation">
          {open ? (
            <Thread key={open.id} conversation={open} me={me} onBack={() => setOpenId(null)} />
          ) : (
            <div className="messages-welcome">
              <span className="messages-welcome-icon"><MessageSquare size={42} /></span>
              <h2>Your team, one conversation away</h2>
              <p>Choose a chat to share messages, photos, files and voice notes.</p>
              <button type="button" className="messages-new-chat" onClick={() => setComposing(true)}><Plus size={16} />New conversation</button>
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
      className={`conversation-row ${active ? 'conversation-row-active' : ''} ${unread ? 'conversation-row-unread' : ''}`}
    >
      {isGroup
        ? <span className="messages-avatar messages-avatar-group"><Users size={14} /></span>
        : <Avatar name={name} size="md" className="messages-avatar" />}

      <span className="conversation-row-copy">
        <span className="conversation-row-top">
          <span className="conversation-row-name">
            {name}
          </span>
          <span className="conversation-row-time">
            {conversation.last_message_at ? relativeTime(conversation.last_message_at) : ''}
          </span>
        </span>
        <span className="conversation-row-bottom">
          <span className="conversation-row-preview">
            {previewOf(conversation, me)}
          </span>
          {unread && (
            <span
              className="conversation-unread-count"
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
  const { data: messages = [], isLoading, error } = useMessages(conversation.id);
  const markRead = useMarkRead();
  const [managing, setManaging] = useState(false);
  const [replyId, setReplyId] = useState(null);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const viewportRef = useRef(null);
  const timelineRef = useRef(null);
  const followLatestRef = useRef(true);
  const name = conversationName(conversation, me);
  const isGroup = conversation.kind === 'group';
  const days = useMemo(() => groupByDay(messages), [messages]);
  const byId = useMemo(() => new Map(messages.map((message) => [message.id, message])), [messages]);
  const unread = conversation.unread_count;
  useEffect(() => {
    if (unread > 0) markRead.mutate({ conversationId: conversation.id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation.id, unread]);

  const jumpToLatest = useCallback(() => {
    const viewport = viewportRef.current;
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
    followLatestRef.current = true;
    setAwayFromBottom(false);
  }, []);

  useEffect(() => {
    if (followLatestRef.current) jumpToLatest();
  }, [messages.length, jumpToLatest]);
  // Media can finish loading after the message row. Follow it only while reading the latest chat.
  useEffect(() => {
    const observer = new ResizeObserver(() => {
      if (followLatestRef.current) jumpToLatest();
    });
    if (timelineRef.current) observer.observe(timelineRef.current);
    if (viewportRef.current) observer.observe(viewportRef.current);
    return () => observer.disconnect();
  }, [jumpToLatest]);

  return (
    <div className="messages-chat">
      <header className="messages-chat-header">
        <button type="button" onClick={onBack} aria-label="Back to conversations" className="messages-icon-button messages-back"><ArrowLeft size={21} /></button>
        {isGroup ? <span className="messages-avatar messages-avatar-group"><Users size={21} /></span>
          : <Avatar name={name} size="md" className="messages-avatar" />}
        <div className="messages-chat-heading">
          <h2>{name}</h2>
          <p>{isGroup ? `${conversation.members?.length ?? 0} members · ${others(conversation, me).map((member) => member.employee?.full_name).filter(Boolean).join(', ')}` : 'Direct message'}</p>
        </div>
        {isGroup && <button type="button" onClick={() => setManaging((value) => !value)} aria-label="Group settings"
          aria-expanded={managing} className="messages-icon-button"><UserPlus size={21} /></button>}
      </header>
      {managing && isGroup && <GroupPanel conversation={conversation} me={me} onClose={() => setManaging(false)} />}
      <div className="messages-chat-history">
        <div className="messages-chat-scroll" ref={viewportRef} role="region" aria-label="Message history" tabIndex={0}
          onScroll={(event) => {
            const node = event.currentTarget;
            const near = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
            followLatestRef.current = near;
            setAwayFromBottom(!near);
          }}>
          <div className="messages-timeline" ref={timelineRef}>
            {isLoading && <p className="messages-chat-notice" role="status"><Loader2 size={16} className="animate-spin" />Loading messages…</p>}
            {error && <p className="messages-chat-error" role="alert">{humanDbError(error)}</p>}
            {!isLoading && !error && !messages.length && <div className="messages-chat-empty"><MessageSquare size={28} /><strong>Say hello</strong><p>Send a message to start the conversation.</p></div>}
            {days.map(({ day, messages: rows }) => (
              <div key={day} className="messages-day">
                <p className="messages-date"><span>{dayLabel(day)}</span></p>
                {rows.map((message, index) => <MessageBubble key={message.id} message={message} me={me}
                  quote={byId.get(message.reply_to)} onReply={() => setReplyId(message.id)}
                  withSender={showsSender(message, rows[index - 1] ?? null, { kind: conversation.kind })}
                  endsRun={index === rows.length - 1 || rows[index + 1].sender_id !== message.sender_id || showsSender(rows[index + 1], message, { kind: 'group' })} />)}
              </div>
            ))}
          </div>
        </div>
        {awayFromBottom && <button type="button" className="messages-jump-latest" onClick={jumpToLatest} aria-label="Jump to latest messages"><ArrowDown size={20} /></button>}
      </div>
      <Composer conversationId={conversation.id} replyTo={byId.get(replyId)} me={me} onCancelReply={() => setReplyId(null)}
        onSent={() => { setReplyId(null); jumpToLatest(); }} />
    </div>
  );
}

/* --------------------------------------------------------------- one message -- */

function MessageBubble({ message, me, withSender, endsRun, quote, onReply }) {
  const mine = isMine(message, me);
  const [showActions, setShowActions] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const remove = useDeleteMessage();
  const isMedia = message.kind !== 'text';

  return (
    <div className="message-bubble-row" data-own={mine} data-ends-run={endsRun}>
      <div className="message-bubble-wrap">
        {message.deleted_at ? <p className="message-deleted"><Trash2 size={12} />Message deleted</p> : <>
          <div className={`message-bubble ${isMedia ? 'message-bubble-media' : ''}`}>
            {withSender && !mine && <p className="message-sender">{message.sender?.full_name || 'Unknown'}</p>}
            {message.reply_to && <blockquote className="message-quote">
              <strong>{quote ? (isMine(quote, me) ? 'You' : quote.sender?.full_name || 'Unknown') : 'Earlier message'}</strong>
              <span>{replyPreviewOf(quote)}</span>
            </blockquote>}
            {isMedia && <MediaBubble message={message} mine={mine} />}
            {(message.body || !isMedia) && <p className="message-text">{messageLinkParts(message.body).map((part, index) => part.type === 'link'
              ? <a key={index} href={part.href} target="_blank" rel="noopener noreferrer">{part.text}</a>
              : <React.Fragment key={index}>{part.text}</React.Fragment>)}</p>}
            <div className="message-meta">
              {message.edited_at && <span>edited</span>}
              <time dateTime={message.created_at}>{clockOf(message.created_at)}</time>
              <button type="button" className="message-options" aria-label="Message options" aria-expanded={showActions}
                onClick={() => setShowActions((value) => !value)}><ChevronDown size={14} /></button>
            </div>
          </div>
          {showActions && <div className="message-actions">
            <button type="button" onClick={() => { onReply(); setShowActions(false); }}><Reply size={14} />Reply</button>
            {mine && <button type="button" onClick={() => setConfirming(true)}><Trash2 size={13} />Delete</button>}
          </div>}
        </>}
      </div>
      {confirming && <ConfirmDialog title="Delete this message?" confirmLabel="Delete" busy={remove.isPending}
        error={remove.error?.message} onCancel={() => { if (!remove.isPending) { remove.reset(); setConfirming(false); } }}
        onConfirm={async () => {
          try {
            await remove.mutateAsync({ messageId: message.id, conversationId: message.conversation_id });
            setConfirming(false);
            setShowActions(false);
          } catch { /* shown in the dialog */ }
        }}>
        <p>Everyone in the conversation will see that a message was deleted, but not what it said.</p>
      </ConfirmDialog>}
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
      <span className="messages-audio">
        <Play size={13} className={mine ? 'text-white/90' : 'text-brand-ink'} />
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
        <span className="messages-file-name">
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

const CHAT_EMOJI = ['😀', '😊', '👍', '🙏', '✅', '🎉', '👏', '💡', '📌', '👀', '❤️', '🚀'];

function Composer({ conversationId, replyTo, me, onCancelReply, onSent }) {
  const [body, setBody] = useState('');
  const [pending, setPending] = useState(null);
  const [localError, setLocalError] = useState(null);
  const [attachOpen, setAttachOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const send = useSendMessage();
  const upload = useUploadMedia();
  const fileRef = useRef(null);
  const imageRef = useRef(null);
  const textRef = useRef(null);
  const postingRef = useRef(false);
  const busy = sending || send.isPending || upload.isPending;
  const error = localError || send.error || upload.error;
  const canSend = Boolean(body.trim()) || Boolean(pending);

  useEffect(() => {
    if (replyTo?.id) textRef.current?.focus();
  }, [replyTo?.id]);

  const pick = (file) => {
    setLocalError(null);
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setLocalError(new Error(`That file is ${readableSize(file.size)}. The limit is 25 MB.`));
      return;
    }
    setPending({ file, kind: KIND_FOR(file), durationMs: null });
  };

  const insertEmoji = (emoji) => {
    const input = textRef.current;
    const start = input?.selectionStart ?? body.length;
    const end = input?.selectionEnd ?? start;
    const next = body.slice(0, start) + emoji + body.slice(end);
    if (next.length > 4000) return;
    setBody(next);
    setEmojiOpen(false);
    requestAnimationFrame(() => { input?.focus(); input?.setSelectionRange(start + emoji.length, start + emoji.length); });
  };

  const submit = async (event) => {
    event?.preventDefault();
    if (postingRef.current || !canSend) return;
    postingRef.current = true;
    setSending(true);
    setLocalError(null);
    setAttachOpen(false);
    setEmojiOpen(false);
    try {
      if (pending) {
        // Retain an uploaded object on a failed send, so retrying doesn't create duplicate files.
        const media = pending.media ?? await upload.mutateAsync({ conversationId, file: pending.file, durationMs: pending.durationMs });
        setPending((current) => current ? { ...current, media } : current);
        await send.mutateAsync({ conversationId, body, kind: pending.kind, media, replyTo: replyTo?.id ?? null });
        setPending(null);
      } else {
        await send.mutateAsync({ conversationId, body, replyTo: replyTo?.id ?? null });
      }
      setBody('');
      if (textRef.current) textRef.current.style.height = 'auto';
      onSent();
    } catch { /* keep the draft and display the error */ }
    finally { postingRef.current = false; setSending(false); }
  };

  return (
    <form onSubmit={submit} className="messages-composer" aria-label="Write a message"
      onKeyDown={(event) => {
        if (event.key === 'Escape') { setAttachOpen(false); setEmojiOpen(false); }
      }}>
      {replyTo && <div className="messages-reply-preview">
        <Reply size={18} />
        <div><strong>Replying to {isMine(replyTo, me) ? 'yourself' : replyTo.sender?.full_name || 'Unknown'}</strong><p>{replyPreviewOf(replyTo)}</p></div>
        <button type="button" className="messages-icon-button" disabled={busy} onClick={onCancelReply} aria-label="Cancel reply"><X size={18} /></button>
      </div>}
      {pending && <div className="messages-pending-file">
        <Paperclip size={20} />
        <div><strong>{pending.file.name}</strong><small>{readableSize(pending.file.size)} · Ready to send</small></div>
        <button type="button" className="messages-icon-button" disabled={busy} onClick={() => setPending(null)} aria-label="Remove attachment"><X size={18} /></button>
      </div>}
      {error && <p className="messages-chat-error" role="alert"><AlertTriangle size={13} />{humanDbError(error)}</p>}
      {emojiOpen && <div className="messages-emoji-picker" role="group" aria-label="Choose an emoji">
        {CHAT_EMOJI.map((emoji) => <button type="button" key={emoji} onClick={() => insertEmoji(emoji)} aria-label={`Insert ${emoji}`}>{emoji}</button>)}
      </div>}
      <div className="messages-compose-row">
        <input ref={imageRef} type="file" accept="image/*,video/*" hidden disabled={busy}
          onChange={(event) => { pick(event.target.files?.[0]); event.target.value = ''; }} />
        <input ref={fileRef} type="file" hidden disabled={busy}
          onChange={(event) => { pick(event.target.files?.[0]); event.target.value = ''; }} />
        <div className="messages-input-shell">
          <button type="button" className="messages-icon-button" disabled={busy} aria-label="Choose emoji" aria-expanded={emojiOpen}
            onClick={() => { setEmojiOpen((value) => !value); setAttachOpen(false); }}><Smile size={21} /></button>
          <textarea ref={textRef} rows={1} value={body} disabled={busy} maxLength={4000}
            aria-label="Message" placeholder={pending ? 'Add a caption…' : 'Type a message'}
            onChange={(event) => {
              setBody(event.target.value);
              event.target.style.height = 'auto';
              event.target.style.height = `${Math.min(event.target.scrollHeight, 128)}px`;
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); }
            }} />
          <div className="messages-attach-control">
            <button type="button" className="messages-icon-button" disabled={busy} aria-label="Attach a photo, video or file" aria-expanded={attachOpen}
              onClick={() => { setAttachOpen((value) => !value); setEmojiOpen(false); }}><Paperclip size={21} /></button>
            {attachOpen && <>
              <button type="button" aria-label="Close attachment menu" onClick={() => setAttachOpen(false)} className="messages-menu-dismiss" />
              <div className="messages-attachment-menu">
                {[{ icon: ImageIcon, label: 'Photo or video', ref: imageRef }, { icon: FileText, label: 'Document or audio', ref: fileRef }].map(({ icon: Icon, label, ref }) => (
                  <button key={label} type="button" onClick={() => { setAttachOpen(false); ref.current?.click(); }}><Icon size={19} />{label}</button>
                ))}
              </div>
            </>}
          </div>
        </div>
        {canSend ? <button type="submit" className="messages-send" disabled={busy} aria-label="Send">
          {busy ? <Loader2 size={20} className="animate-spin" /> : <Send size={20} />}
        </button> : <VoiceButton disabled={busy || Boolean(pending)}
          onRecorded={(file, durationMs) => setPending({ file, kind: 'voice', durationMs })} onError={setLocalError} />}
      </div>
      <p className="messages-composer-hint">{busy ? 'Sending…' : 'Enter to send · Shift+Enter for a new line'}</p>
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
        className="shrink-0 h-11 px-3 inline-flex items-center gap-1.5 rounded-xl border border-red-300 dark:border-red-900/50 bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300 active:bg-red-100 dark:active:bg-red-950/50 transition-colors cursor-pointer"
      >
        {/* A dot that pulses says "recording" faster than any label, and the clock says how long
            for. Both live inside one 44px control so stopping is the easy thing to hit. */}
        <span className="relative grid place-items-center">
          <span className="absolute h-3 w-3 rounded-full bg-red-500/40 animate-ping" />
          <Square size={12} className="relative" />
        </span>
        <span className="font-mono text-2xs tabular-nums">
          {String(Math.floor(seconds / 60)).padStart(2, '0')}:{String(seconds % 60).padStart(2, '0')}
        </span>
      </button>
    );
  }

  return (
    <button
      type="button" onClick={start} disabled={disabled}
      aria-label="Record a voice note" title="Voice note"
      className="messages-voice"
    >
      <Mic size={20} />
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
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4"
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
                  ? 'bg-brand-soft text-brand-ink'
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
                  on ? 'bg-brand-soft' : 'hover:bg-neutral-50 dark:hover:bg-neutral-900'
                }`}
              >
                <Avatar name={e.full_name} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-semibold text-neutral-800 dark:text-neutral-200">{e.full_name}</span>
                  <span className="block truncate text-2xs font-mono text-neutral-500">
                    {e.employee_code}{e.branch?.code ? ` · ${e.branch.code}` : ''}
                  </span>
                </span>
                {mode === 'group' && on && <span className="text-2xs font-bold text-brand-ink">added</span>}
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
