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
import React, { useState, useMemo, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  MessageSquare, Send, Plus, X, Search, Loader2, ArrowLeft, Users, Paperclip, Image as ImageIcon,
  Trash2, Download, FileText, AlertTriangle, UserPlus, PenLine, Smile, ChevronDown, Reply, ArrowDown, Eye, ChevronsUpDown, Settings,
} from 'lucide-react';
import {
  useConversations, useMessages, useSendMessage, useDeleteMessage, useMarkRead,
  useStartDirect, useCreateGroup, useAddMembers, useRemoveMember, useRenameGroup,
  useUploadMedia, useMediaUrl, useEmployeeConversations, useSetGroupPicture,
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
import Pagination, { usePagination } from './ui/Pagination';
import { useFocusRow } from '../lib/useFocusRow';
import { messageLinkParts } from '../lib/messageLinks';
import VoiceNote from './VoiceNote';
import VoiceRecorder from './VoiceRecorder';
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
    return new Date(`${day}T00:00:00Z`).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
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

  /*
   * Whose inbox am I reading?
   *
   * The same idea as the role switch in the top bar, pointed at a different question: that one asks
   * which of YOUR roles you are working as, this asks whose conversations you are looking at. null
   * is your own, which is what everybody except a super admin ever has.
   *
   * Deliberately NOT persisted, unlike the role switch. Coming back tomorrow to find yourself still
   * reading a colleague's inbox — and possibly not noticing — is a different and worse thing than
   * coming back to a remembered role. Monitoring should be something you chose this minute.
   *
   * Not a privilege switch either. Picking somebody does not grant anything; app.can_read_
   * conversation's super-admin arm is what returns the rows, and for anybody else this control does
   * not render and the queries behind it come back empty.
   */
  const [watchingId, setWatchingId] = useState(null);
  const [watchPickerOpen, setWatchPickerOpen] = useState(false);

  // A notification about a message carries the conversation id, so following one opens the room it
  // was about rather than the list it happens to be in.
  const { focusId } = useFocusRow();
  useEffect(() => {
    if (focusId && conversations.some((c) => c.id === focusId)) setOpenId(focusId);
  }, [focusId, conversations]);

  // Only ever fetched when somebody is actually being watched — `enabled` keeps this off the
  // request path for the 165 people who will never use it.
  // `enabled` on both: a super admin is one account out of 165, so neither the directory read nor
  // the watched inbox should be on everybody else's request path.
  const { data: employeesForWatching = [] } = useEmployees({ enabled: isSuperAdmin });
  const watched = useEmployeeConversations(watchingId, { enabled: Boolean(watchingId) });
  const monitoring = Boolean(watchingId) && watchingId !== me;

  const shown = monitoring
    ? sortConversations(watched.data ?? [])
    : conversations;

  const open = shown.find((c) => c.id === openId) ?? null;

  // Filtered from the watched person's side when watching, so a search for a name matches the
  // people THEY talk to rather than the people the administrator talks to.
  const visible = useMemo(
    () => filterConversations(shown, { query, filter: chatFilter, me: monitoring ? watchingId : me }),
    [shown, query, chatFilter, me, monitoring, watchingId]
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
            {/* Composing is meaningless while reading somebody else's inbox — you would be starting
                a conversation of your own from a screen that is showing theirs. */}
            {!monitoring && (
              <button type="button" className="messages-icon-button" onClick={() => setComposing(true)} aria-label="Start a new conversation" title="New chat"><PenLine size={21} /></button>
            )}
          </header>

          {isSuperAdmin && (
            <WatchPicker
              employees={employeesForWatching}
              watchingId={watchingId}
              open={watchPickerOpen}
              onToggle={() => setWatchPickerOpen((v) => !v)}
              onPick={(id) => {
                // The open conversation belongs to whoever was being read a moment ago, so it goes
                // with them. Leaving it up would show one person's thread above another's list.
                setWatchingId(id);
                setOpenId(null);
                setQuery('');
                setChatFilter('all');
                setWatchPickerOpen(false);
              }}
            />
          )}
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
                me={monitoring ? watchingId : me}
                active={c.id === openId}
                onOpen={() => setOpenId(c.id)}
              />
            ))}
          </div>
        </aside>

        {/* The thread. */}
        <section className={`messages-thread ${open ? 'messages-thread-open' : ''}`} aria-label="Conversation">
          {open ? (
            <Thread
              key={open.id}
              conversation={open}
              me={monitoring ? watchingId : me}
              readOnly={monitoring}
              onBack={() => setOpenId(null)}
            />
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

/**
 * Whose inbox is on screen.
 *
 * Shaped after the role switch in the top bar, because it answers the same KIND of question and
 * should not need to be learned twice: a quiet row that names the current view and opens a list.
 *
 * It only exists for a super admin, and picking somebody grants nothing — the rows come back
 * because app.can_read_conversation says so, and for anybody else this component never renders and
 * the query behind it returns empty. The banner while watching is not decoration: the whole screen
 * is otherwise identical to your own inbox, and reading a colleague's messages while believing they
 * are yours is the one mistake this control makes possible.
 */
function WatchPicker({ employees, watchingId, open, onToggle, onPick }) {
  const [q, setQ] = useState('');
  const watching = employees.find((e) => e.id === watchingId) ?? null;

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const pool = employees;
    if (!needle) return pool;
    return pool.filter(
      (e) => (e.full_name || '').toLowerCase().includes(needle)
        || (e.employee_code || '').toLowerCase().includes(needle)
    );
  }, [employees, q]);
  const peoplePager = usePagination(results, 10, null, q);

  return (
    <div className="messages-watch">
      <button
        type="button"
        className="messages-watch-trigger"
        onClick={onToggle}
        aria-expanded={open}
        data-watching={watching ? 'true' : 'false'}
      >
        {watching ? <Eye size={14} /> : <MessageSquare size={14} />}
        <span>
          <small>Viewing</small>
          <strong>{watching ? watching.full_name : 'My chats'}</strong>
        </span>
        <ChevronsUpDown size={14} aria-hidden="true" />
      </button>

      {open && (
        <>
          <button type="button" className="messages-menu-dismiss" aria-label="Close" onClick={onToggle} />
          <div className="messages-watch-menu">
            <input
              autoFocus
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search people…"
              aria-label="Search people to view"
            />
            <div className="messages-watch-results">
              <button type="button" onClick={() => onPick(null)} aria-current={!watchingId ? 'true' : undefined}>
                <MessageSquare size={14} /> My chats
              </button>
              {peoplePager.slice.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => onPick(e.id)}
                  aria-current={e.id === watchingId ? 'true' : undefined}
                >
                  <Eye size={14} />
                  <span>
                    {e.full_name}
                    {e.employee_code ? <small>{e.employee_code}</small> : null}
                  </span>
                </button>
              ))}
              {results.length === 0 && <p>Nobody matches that.</p>}
            </div>
            <div className="paged-collection"><Pagination {...peoplePager} noun="people" sizes={[10, 25, 50]} /></div>
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ the list -- */

function ConversationRow({ conversation, me, active, onOpen }) {
  const name = conversationName(conversation, me);
  const unread = hasUnread(conversation);

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={active ? 'page' : undefined}
      className={`conversation-row ${active ? 'conversation-row-active' : ''} ${unread ? 'conversation-row-unread' : ''}`}
    >
      <ConversationAvatar conversation={conversation} me={me} />

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

export function Thread({ conversation, me, onBack, readOnly = false }) {
  const { data: messages = [], isLoading, error, hasOlder, loadOlder, isLoadingOlder } = useMessages(conversation.id);
  const markRead = useMarkRead();
  const [managing, setManaging] = useState(false);
  const settingsButtonRef = useRef(null);
  const closeSettings = useCallback(() => {
    setManaging(false);
    requestAnimationFrame(() => settingsButtonRef.current?.focus());
  }, []);
  const [replyId, setReplyId] = useState(null);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const viewportRef = useRef(null);
  const timelineRef = useRef(null);
  const followLatestRef = useRef(true);
  const olderScrollRef = useRef(null);
  const name = conversationName(conversation, me);
  const isGroup = conversation.kind === 'group';
  const days = useMemo(() => groupByDay(messages), [messages]);
  const byId = useMemo(() => new Map(messages.map((message) => [message.id, message])), [messages]);
  const unread = conversation.unread_count;
  useEffect(() => {
    if (!readOnly && unread > 0) markRead.mutate({ conversationId: conversation.id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation.id, unread]);

  const jumpToLatest = useCallback(() => {
    const viewport = viewportRef.current;
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
    followLatestRef.current = true;
    setAwayFromBottom(false);
  }, []);

  const newestMessageId = messages.at(-1)?.id;
  useEffect(() => {
    if (followLatestRef.current) jumpToLatest();
  }, [newestMessageId, jumpToLatest]);
  useLayoutEffect(() => {
    const previous = olderScrollRef.current;
    const viewport = viewportRef.current;
    if (!previous || !viewport || previous.firstId === messages[0]?.id) return;
    viewport.scrollTop = previous.top + viewport.scrollHeight - previous.height;
    olderScrollRef.current = null;
  }, [messages]);
  const loadEarlier = () => {
    const viewport = viewportRef.current;
    if (!viewport || isLoadingOlder) return;
    olderScrollRef.current = { top: viewport.scrollTop, height: viewport.scrollHeight, firstId: messages[0]?.id };
    followLatestRef.current = false;
    loadOlder();
  };
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
      <header className="messages-chat-header" inert={managing || undefined} aria-hidden={managing || undefined}>
        <button type="button" onClick={onBack} aria-label="Back to conversations" className="messages-icon-button messages-back"><ArrowLeft size={21} /></button>
        <ConversationAvatar conversation={conversation} me={me} />
        <div className="messages-chat-heading">
          <h2>{name}</h2>
          <p>{isGroup ? `${conversation.members?.length ?? 0} members · ${others(conversation, me).map((member) => member.employee?.full_name).filter(Boolean).join(', ')}` : 'Direct message'}</p>
        </div>
        <button ref={settingsButtonRef} type="button" onClick={() => setManaging(true)} aria-label="Chat settings"
          aria-expanded={managing} className="messages-icon-button"><Settings size={21} /></button>
      </header>
      {managing && <ConversationSettings conversation={conversation} me={me} readOnly={readOnly}
        onClose={closeSettings} />}
      <div className="messages-thread-content" inert={managing || undefined} aria-hidden={managing || undefined}>
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
            {hasOlder && <button type="button" className={btnClass('ghost') + ' mx-auto'}
              onClick={loadEarlier} disabled={isLoadingOlder}>
              {isLoadingOlder && <Loader2 size={14} className="animate-spin" />}
              {isLoadingOlder ? 'Loading older messages…' : 'Load older messages'}
            </button>}
            {!isLoading && !error && !messages.length && <div className="messages-chat-empty"><MessageSquare size={28} /><strong>Say hello</strong><p>Send a message to start the conversation.</p></div>}
            {days.map(({ day, messages: rows }) => (
              <div key={day} className="messages-day">
                <p className="messages-date"><span>{dayLabel(day)}</span></p>
                {rows.map((message, index) => <MessageBubble key={message.id} message={message} me={me} readOnly={readOnly}
                  quote={byId.get(message.reply_to)} onReply={() => setReplyId(message.id)}
                  withSender={showsSender(message, rows[index - 1] ?? null, { kind: conversation.kind })}
                  endsRun={index === rows.length - 1 || rows[index + 1].sender_id !== message.sender_id || showsSender(rows[index + 1], message, { kind: 'group' })} />)}
              </div>
            ))}
          </div>
        </div>
        {awayFromBottom && <button type="button" className="messages-jump-latest" onClick={jumpToLatest} aria-label="Jump to latest messages"><ArrowDown size={20} /></button>}
      </div>
      {/* messages_insert asks app.is_conversation_member, so an administrator reading somebody
          else's conversation is refused by the database anyway. Offering a box that will reject
          what is typed into it is worse than saying so. */}
      {readOnly ? (
        <p className="messages-chat-notice messages-readonly-bar" role="status">
          <Eye size={16} aria-hidden="true" /> Viewing someone else’s conversation. Only the people in it can reply.
        </p>
      ) : (
      <Composer conversationId={conversation.id} replyTo={byId.get(replyId)} me={me} onCancelReply={() => setReplyId(null)}
        onSent={() => { setReplyId(null); jumpToLatest(); }} />
      )}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- one message -- */

function MessageBubble({ message, me, withSender, endsRun, quote, onReply, readOnly = false }) {
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
              {!readOnly && <button type="button" className="message-options" aria-label="Message options" aria-expanded={showActions}
                onClick={() => setShowActions((value) => !value)}><ChevronDown size={14} /></button>}
            </div>
          </div>
          {!readOnly && showActions && <div className="message-actions">
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
    return <VoiceNote url={url} durationMs={message.duration_ms} mine={mine} />;
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
  const [voiceActive, setVoiceActive] = useState(false);
  const [draftUrl, setDraftUrl] = useState(null);
  const send = useSendMessage();
  const upload = useUploadMedia();
  const fileRef = useRef(null);
  const imageRef = useRef(null);
  const textRef = useRef(null);
  const postingRef = useRef(false);
  const busy = sending || send.isPending || upload.isPending;
  const error = localError || send.error || upload.error;
  const canSend = Boolean(body.trim()) || Boolean(pending);
  const voiceDraft = pending?.kind === 'voice';

  useEffect(() => {
    if (!voiceDraft || !pending?.file) { setDraftUrl(null); return; }
    const url = URL.createObjectURL(pending.file);
    setDraftUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [voiceDraft, pending?.file]);

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

  const submit = async (event, recordedDraft = null) => {
    event?.preventDefault();
    const attachment = recordedDraft ?? pending;
    if (postingRef.current || (voiceActive && !recordedDraft) || (!body.trim() && !attachment)) return;
    postingRef.current = true;
    setSending(true);
    setLocalError(null);
    setAttachOpen(false);
    setEmojiOpen(false);
    try {
      if (attachment) {
        // Retain an uploaded object on a failed send, so retrying doesn't create duplicate files.
        const media = attachment.media ?? await upload.mutateAsync({ conversationId, file: attachment.file, durationMs: attachment.durationMs });
        setPending((current) => current ? { ...current, media } : current);
        await send.mutateAsync({ conversationId, body, kind: attachment.kind, media, replyTo: replyTo?.id ?? null });
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
      {pending && !voiceDraft && <div className="messages-pending-file">
        <Paperclip size={20} />
        <div><strong>{pending.file.name}</strong><small>{readableSize(pending.file.size)} · Ready to send</small></div>
        <button type="button" className="messages-icon-button" disabled={busy} onClick={() => setPending(null)} aria-label="Remove attachment"><X size={18} /></button>
      </div>}
      {error && <p className="messages-chat-error" role="alert"><AlertTriangle size={13} />{humanDbError(error)}</p>}
      {voiceDraft && body && <textarea className="messages-voice-caption" rows={1} value={body} disabled={busy}
        maxLength={4000} aria-label="Voice note caption" onChange={(event) => setBody(event.target.value)} />}
      {emojiOpen && <div className="messages-emoji-picker" role="group" aria-label="Choose an emoji">
        {CHAT_EMOJI.map((emoji) => <button type="button" key={emoji} onClick={() => insertEmoji(emoji)} aria-label={`Insert ${emoji}`}>{emoji}</button>)}
      </div>}
      <div className="messages-compose-row" data-recording={voiceActive ? 'true' : 'false'}>
        <input ref={imageRef} type="file" accept="image/*,video/*" hidden disabled={busy}
          onChange={(event) => { pick(event.target.files?.[0]); event.target.value = ''; }} />
        <input ref={fileRef} type="file" hidden disabled={busy}
          onChange={(event) => { pick(event.target.files?.[0]); event.target.value = ''; }} />
        {voiceDraft && <div className="messages-voice-draft">
          <button type="button" className="messages-icon-button" disabled={busy} aria-label="Delete voice note"
            onClick={() => { setPending(null); setLocalError(null); }}><Trash2 size={21} /></button>
          <div className="messages-voice-draft-player">
            {draftUrl ? <VoiceNote key={draftUrl} url={draftUrl} durationMs={pending.durationMs} compact disabled={busy} />
              : <Loader2 size={18} className="animate-spin" aria-label="Preparing preview" />}
          </div>
        </div>}
        {!voiceActive && !voiceDraft && <div className="messages-input-shell">
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
        </div>}
        {canSend ? <button type="submit" className="messages-send" disabled={busy} aria-label={voiceDraft ? 'Send voice note' : 'Send'}>
          {busy ? <Loader2 size={20} className="animate-spin" /> : <Send size={20} />}
        </button> : <VoiceRecorder disabled={busy}
          onActiveChange={(active) => { setVoiceActive(active); if (active) { setAttachOpen(false); setEmojiOpen(false); } }}
          onRecorded={(file, durationMs, { sendImmediately = false } = {}) => {
            const draft = { file, kind: 'voice', durationMs };
            setPending(draft);
            if (sendImmediately) submit(null, draft);
          }} onError={setLocalError} />}
      </div>
      {!voiceActive && <p className="messages-composer-hint">{busy ? 'Sending…' : voiceDraft ? 'Listen before sending' : 'Enter to send · Shift+Enter for a new line'}</p>}
    </form>
  );
}

/* ------------------------------------------------------- starting a new one -- */

export function NewConversation({ me, onClose, onOpened }) {
  const [mode, setMode] = useState('direct');   // 'direct' | 'group'
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState([]);
  const [title, setTitle] = useState('');
  const { data: employees = [], isLoading: loadingEmployees, error: employeeError } = useEmployees();
  const startDirect = useStartDirect();
  const createGroup = useCreateGroup();

  const busy = startDirect.isPending || createGroup.isPending;
  const error = startDirect.error || createGroup.error || employeeError;

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const pool = employees.filter((e) => e.id !== me);
    if (!needle) return pool;
    return pool.filter(
      (e) => (e.full_name || '').toLowerCase().includes(needle)
        || (e.employee_code || '').toLowerCase().includes(needle)
    );
  }, [employees, query, me]);
  const peoplePager = usePagination(results, 12, null, query);

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

  const dialog = (
    <div
      className="messages-new-conversation-overlay fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div role="dialog" aria-modal="true" aria-label={mode === 'group' ? 'New group' : 'New message'} className="messages-new-conversation-panel w-full sm:max-w-md bg-white dark:bg-neutral-950 rounded-t-2xl sm:rounded-2xl border border-neutral-200 dark:border-neutral-850 p-4 space-y-3 max-h-[85vh] flex flex-col">
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
          <p role="alert" className="flex items-start gap-1.5 text-2xs text-rose-600 dark:text-rose-400">
            <AlertTriangle size={11} className="mt-0.5 shrink-0" /> {humanDbError(error)}
          </p>
        )}

        <div className="messages-new-conversation-people flex-1 min-h-0 overflow-y-auto -mx-1 px-1 divide-y divide-neutral-150 dark:divide-neutral-850/60">
          {loadingEmployees ? <p role="status" className="py-6 text-center text-xs text-neutral-500">Loading people…</p> : !employeeError && results.length === 0 && (
            <p className="py-6 text-center text-xs text-neutral-500">{query.trim() ? 'Nobody matches that.' : 'No colleagues available to message yet.'}</p>
          )}
          {peoplePager.slice.map((e) => {
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

        <div className="paged-collection shrink-0"><Pagination {...peoplePager} noun="people" sizes={[12, 25, 50]} disabled={busy} /></div>

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
  // The animated Messages page forms a stacking context below the floating navigation.
  // Mount the picker outside it so the modal covers navigation at every content height.
  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body);
}

/* ------------------------------------------------------------ chat settings -- */

function ConversationAvatar({ conversation, me, large = false }) {
  const isGroup = conversation.kind === 'group';
  const { data: photoUrl } = useMediaUrl(isGroup ? conversation.photo_path : null);
  const name = conversationName(conversation, me);
  if (!isGroup) return <Avatar name={name} size={large ? 'lg' : 'md'} className="messages-avatar" />;
  return <span className={`messages-avatar messages-avatar-group${large ? ' messages-settings-avatar' : ''}`}>
    {photoUrl ? <img src={photoUrl} alt={`${name} group picture`} /> : <Users size={large ? 30 : 21} />}
  </span>;
}

/** One route inside the thread for both chat types. Employee identities are always read-only. */
export function ConversationSettings({ conversation, me, onClose, readOnly = false }) {
  const isGroup = conversation.kind === 'group';
  const editable = !readOnly && isGroup && (conversation.members ?? []).some((member) => member.employee_id === me);
  const closeRef = useRef(null);
  useEffect(() => {
    closeRef.current?.focus();
    const closeOnEscape = (event) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);
  return <section className="messages-settings" aria-label="Chat settings">
    <header className="messages-settings-header">
      <button ref={closeRef} type="button" onClick={onClose} aria-label="Back to chat" className="messages-icon-button"><ArrowLeft size={21} /></button>
      <h2>{isGroup ? 'Group settings' : 'Chat settings'}</h2>
    </header>
    <div className="messages-settings-scroll">
      <div className="messages-settings-identity">
        <ConversationAvatar conversation={conversation} me={me} large />
        <h3>{conversationName(conversation, me)}</h3>
        <p>{isGroup ? `${conversation.members?.length ?? 0} members` : 'Direct message'}</p>
      </div>
      {isGroup ? <GroupPanel conversation={conversation} me={me} editable={editable} />
        : <div className="messages-settings-section">
          <h3>People</h3>
          <ul className="messages-settings-members">
            {(conversation.members ?? []).map((member) => <li key={member.employee_id}>
              <Avatar name={member.employee?.full_name} size="sm" />
              <div><strong>{member.employee?.full_name ?? 'Unknown'}{member.employee_id === me && ' (you)'}</strong>
                <span>{member.employee?.employee_code ?? ''}{member.employee?.branch?.code ? ` · ${member.employee.branch.code}` : ''}</span></div>
            </li>)}
          </ul>
        </div>}
    </div>
  </section>;
}

export function GroupPanel({ conversation, me, editable = true }) {
  const [query, setQuery] = useState('');
  const [title, setTitle] = useState(conversation.title ?? '');
  const [status, setStatus] = useState('');
  const [localError, setLocalError] = useState(null);
  const photoInput = useRef(null);
  const { data: employees = [], error: employeesError } = useEmployees();
  const add = useAddMembers();
  const remove = useRemoveMember();
  const rename = useRenameGroup();
  const picture = useSetGroupPicture();
  const busy = add.isPending || remove.isPending || rename.isPending || picture.isPending;
  const error = localError || add.error || remove.error || rename.error || picture.error;
  const memberIds = useMemo(() => new Set((conversation.members ?? []).map((member) => member.employee_id)), [conversation.members]);
  const candidates = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    return employees.filter((person) => !memberIds.has(person.id))
      .filter((person) => (person.full_name || '').toLowerCase().includes(needle)
        || (person.employee_code || '').toLowerCase().includes(needle));
  }, [employees, query, memberIds]);
  const candidatePager = usePagination(candidates, 8, null, `${conversation.id}:${query}`);
  const memberPager = usePagination(conversation.members ?? [], 12, null, conversation.id);
  const save = async (mutation, variables, success) => {
    setStatus(''); setLocalError(null);
    for (const action of [add, remove, rename, picture]) action.reset();
    try { await mutation.mutateAsync(variables); setStatus(success); }
    catch (failure) { setLocalError(failure); }
  };
  return <div className="messages-group-settings">
    {editable && <div className="messages-settings-section">
      <h3>Group details</h3>
      <form className="messages-group-name" onSubmit={(event) => {
        event.preventDefault();
        void save(rename, { conversationId: conversation.id, title }, 'Group name updated.');
      }}>
        <label htmlFor={`group-name-${conversation.id}`}>Group name</label>
        <div><input id={`group-name-${conversation.id}`} className={INPUT} value={title}
          onChange={(event) => setTitle(event.target.value)} maxLength={120} required disabled={busy} />
          <button type="submit" disabled={busy || !title.trim() || title.trim() === (conversation.title ?? '')}
            className={btnClass('ghost', 'sm')}>{rename.isPending ? <Loader2 size={15} className="animate-spin" /> : <PenLine size={15} />}Save</button></div>
      </form>
      <input ref={photoInput} type="file" accept="image/jpeg,image/png,image/webp,image/gif" className="sr-only"
        aria-label="Choose group picture" disabled={busy} onChange={(event) => {
          const file = event.target.files?.[0]; event.target.value = '';
          if (file) void save(picture, { conversationId: conversation.id, file }, 'Group picture updated.');
        }} />
      <div className="messages-settings-actions">
        <button type="button" className={btnClass('ghost', 'sm')} disabled={busy} onClick={() => photoInput.current?.click()}>
          {picture.isPending ? <Loader2 size={16} className="animate-spin" /> : <ImageIcon size={16} />}Change picture</button>
        {conversation.photo_path && <button type="button" className={btnClass('ghost', 'sm')} disabled={busy}
          onClick={() => void save(picture, { conversationId: conversation.id }, 'Group picture removed.')}><Trash2 size={15} />Remove picture</button>}
      </div>
      <p className="messages-settings-hint">JPG, PNG, WebP or GIF · Up to 5 MB</p>
    </div>}
    {error && <p role="alert" className="messages-chat-error"><AlertTriangle size={16} />{humanDbError(error)}</p>}
    {status && <p role="status" className="messages-settings-status">{status}</p>}
    <div className="messages-settings-section">
      <h3>Members <span>{conversation.members?.length ?? 0}</span></h3>
      <ul className="messages-settings-members">
        {memberPager.slice.map((member) => <li key={member.employee_id}>
          <Avatar name={member.employee?.full_name} size="sm" />
          <div><strong>{member.employee?.full_name ?? 'Unknown'}{member.employee_id === me && ' (you)'}</strong>
            <span>{member.employee?.employee_code ?? ''}</span></div>
          {editable && member.employee_id !== me && <button type="button" disabled={busy}
            onClick={() => void save(remove, { conversationId: conversation.id, employeeId: member.employee_id }, 'Member removed.')}
            aria-label={`Remove ${member.employee?.full_name ?? 'this person'}`} title="Remove" className="messages-icon-button"><X size={17} /></button>}
        </li>)}
      </ul>
      <Pagination {...memberPager} noun="group members" sizes={[12, 25, 50]} disabled={busy} />
    </div>
    {editable && <div className="messages-settings-section">
      <h3>Add people</h3>
      <IconInput icon={Search} type="search" value={query} onChange={(event) => setQuery(event.target.value)}
        aria-label="Add someone to this group" placeholder="Search name or employee code" inputClassName={INPUT} />
      {employeesError && <p role="alert" className="messages-chat-error">{humanDbError(employeesError)}</p>}
      {candidates.length > 0 && <div className="paged-collection">
        <ul className="messages-settings-members">
          {candidatePager.slice.map((person) => <li key={person.id}>
            <div><strong>{person.full_name}</strong><span>{person.employee_code}</span></div>
            <button type="button" disabled={busy} className="messages-icon-button" aria-label={`Add ${person.full_name}`}
              onClick={() => { void save(add, { conversationId: conversation.id, employeeIds: [person.id] }, 'Member added.'); }}><UserPlus size={18} /></button>
          </li>)}
        </ul>
        <Pagination {...candidatePager} noun="matching people" sizes={[8, 25, 50]} disabled={busy} />
      </div>}
      {!employeesError && query.trim() && candidates.length === 0 && <p className="messages-settings-hint">No new people match this search.</p>}
      <button type="button" disabled={busy} className="messages-leave-group"
        onClick={() => void save(remove, { conversationId: conversation.id, employeeId: me }, 'You left the group.')}>
        Leave group</button>
    </div>}
  </div>;
}
