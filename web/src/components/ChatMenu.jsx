import { useEffect, useRef, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';

/** A keyboard-accessible action menu shared by chat headers and account rows. */
export default function ChatMenu({ label, items, className = '', disabled = false }) {
  const [open, setOpen] = useState(false);
  const [side, setSide] = useState('bottom');
  const root = useRef(null);
  const trigger = useRef(null);
  const menu = useRef(null);
  useEffect(() => {
    if (!open) return;
    const bounds = root.current?.getBoundingClientRect();
    const container = root.current?.closest('.messages-conversation-list')?.getBoundingClientRect();
    setSide(bounds && bounds.bottom + 110 > (container?.bottom ?? window.innerHeight) ? 'top' : 'bottom');
    menu.current?.querySelector('button:not(:disabled)')?.focus();
    const dismiss = (event) => { if (!root.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  return <div ref={root} className={`messages-menu-control ${className}`} data-side={side}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }} onKeyDown={(event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    if (!open || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...menu.current.querySelectorAll('button:not(:disabled)')];
    const current = buttons.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }}>
    <button ref={trigger} type="button" className="messages-icon-button" aria-label={label}
      aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => setOpen(!open)}>
      <MoreHorizontal size={20} />
    </button>
    {open && <div ref={menu} className="messages-chat-menu" role="menu" aria-label={label}>
      {items.map(({ label: text, icon: Icon, onClick, disabled: itemDisabled }) => <button key={text}
        type="button" role="menuitem" disabled={itemDisabled} onClick={() => { close(); onClick(); }}>
        {Icon && <Icon size={16} aria-hidden="true" />}{text}
      </button>)}
    </div>}
  </div>;
}
