import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MoreHorizontal } from 'lucide-react';
import { chatMenuPosition } from './chatMenuPosition';

/** The portal keeps row menus outside the inbox's scrolling/clipping container. */
export default function ChatMenu({ label, items, className = '', disabled = false }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState(null);
  const root = useRef(null);
  const trigger = useRef(null);
  const menu = useRef(null);
  const initialFocus = useRef('first');
  const focused = useRef(false);
  const menuId = useId();
  const close = () => { setOpen(false); trigger.current?.focus({ preventScroll: true }); };

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (!trigger.current || !menu.current) return;
      const anchor = trigger.current.getBoundingClientRect();
      const scrollport = trigger.current.closest('.messages-conversation-list')?.getBoundingClientRect();
      if (scrollport && (anchor.bottom <= scrollport.top || anchor.top >= scrollport.bottom)) {
        setOpen(false);
        return;
      }
      const viewport = window.visualViewport;
      setPosition(chatMenuPosition(anchor, menu.current.getBoundingClientRect(), {
        left: viewport?.offsetLeft ?? 0, top: viewport?.offsetTop ?? 0,
        width: viewport?.width ?? window.innerWidth, height: viewport?.height ?? window.innerHeight,
      }));
    };
    place();
    const inside = (target) => root.current?.contains(target) || menu.current?.contains(target);
    const dismiss = (event) => { if (!inside(event.target)) setOpen(false); };
    const followScroll = (event) => { if (!menu.current?.contains(event.target)) place(); };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('focusin', dismiss);
    window.addEventListener('scroll', followScroll, true);
    window.addEventListener('resize', place);
    window.visualViewport?.addEventListener('resize', place);
    window.visualViewport?.addEventListener('scroll', place);
    return () => {
      focused.current = false;
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('focusin', dismiss);
      window.removeEventListener('scroll', followScroll, true);
      window.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('scroll', place);
    };
  }, [open]);
  useLayoutEffect(() => {
    if (!open || !position || focused.current) return;
    focused.current = true;
    const buttons = [...menu.current.querySelectorAll('button:not(:disabled)')];
    (initialFocus.current === 'last' ? buttons.at(-1) : buttons[0])?.focus({ preventScroll: true });
  }, [open, position]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  const handleKeyDown = (event) => {
    if (open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    // Start Tab from the trigger's place in the document, not the portal at the end of <body>.
    if (open && event.key === 'Tab') { close(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    if (!open) {
      if (!disabled && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
        event.preventDefault(); initialFocus.current = event.key === 'ArrowUp' ? 'last' : 'first'; setOpen(true);
      }
      return;
    }
    event.preventDefault();
    const buttons = [...menu.current.querySelectorAll('button:not(:disabled)')];
    const current = buttons.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus({ preventScroll: true });
  };
  return <div ref={root} className={`messages-menu-control ${className}`} onKeyDown={handleKeyDown}>
    <button ref={trigger} type="button" className="messages-icon-button" aria-label={label}
      aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} disabled={disabled}
      onClick={() => { initialFocus.current = 'first'; setPosition(null); setOpen(!open); }}>
      <MoreHorizontal size={20} aria-hidden="true" />
    </button>
    {open && createPortal(<div className="messages-shell messages-menu-layer">
      <div ref={menu} id={menuId} className="messages-chat-menu" role="menu" aria-label={label}
        style={{ ...position, visibility: position ? 'visible' : 'hidden' }}>
        {items.map(({ label: text, icon: Icon, onClick, disabled: itemDisabled }) => <button key={text}
          type="button" role="menuitem" disabled={itemDisabled} onClick={() => { close(); onClick(); }}>
          {Icon && <Icon size={16} aria-hidden="true" />}<span>{text}</span>
        </button>)}
      </div>
    </div>, document.body)}
  </div>;
}
