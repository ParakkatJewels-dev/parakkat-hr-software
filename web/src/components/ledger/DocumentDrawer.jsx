// A generated plain-text document (campaign brief, team brief, group review, weekly review) in an
// editable box with Copy and Share. Edits stay until the drawer closes.
import React, { useState } from 'react';
import { Copy, Printer, Share2 } from 'lucide-react';
import { copyText, shareText } from '../../lib/ledger/share.js';
import Drawer from './Drawer';
import { btnClass } from '../ui/Btn';

const RESULT_TEXT = { shared: 'Shared.', copied: 'Copied — paste it into WhatsApp, Slack or a document.', cancelled: '',
  failed: 'Copy is blocked in this browser. Select the text and copy it by hand.' };

export default function DocumentDrawer({ title, subtitle, text, onClose, children, printable = false }) {
  const [value, setValue] = useState(text);
  const [status, setStatus] = useState('');
  const act = async (how) => setStatus(RESULT_TEXT[how === 'share' ? await shareText(value, { title }) : await copyText(value)]);
  const print = () => {
    const page = window.open('', '_blank', 'width=820,height=900');
    if (!page) { setStatus('Allow pop-ups to print this page.'); return; }
    page.document.title = title;
    const pre = page.document.createElement('pre');
    pre.textContent = value;
    pre.style.cssText = 'font:14px/1.6 Georgia,serif;white-space:pre-wrap;margin:32px;';
    page.document.body.appendChild(pre);
    page.focus(); page.print();
  };
  return (
    <Drawer title={title} subtitle={subtitle} onClose={onClose} initialFocus="textarea"
      footer={<>
        {printable && <button type="button" className={btnClass('ghost')} onClick={print}><Printer size={15} /> Print</button>}
        <button type="button" className={btnClass('ghost')} onClick={() => act('copy')}><Copy size={15} /> Copy</button>
        <button type="button" className={btnClass('primary')} onClick={() => act('share')}><Share2 size={15} /> Share</button>
      </>}>
      {children}
      <label className="sr-only" htmlFor="ledger-document">{title}</label>
      <textarea id="ledger-document" className="ledger-draft" value={value} spellCheck="true" onChange={(event) => setValue(event.target.value)} />
      <p className="ledger-quiet" role="status">{status || 'Edit freely before you copy or share it.'}</p>
    </Drawer>
  );
}
