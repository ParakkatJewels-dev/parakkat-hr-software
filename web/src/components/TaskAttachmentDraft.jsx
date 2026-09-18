import React, { useId, useState } from 'react';
import { Link2, Paperclip, Plus, X } from 'lucide-react';
import { ACCEPTED_TASK_FILES, taskFileContentType } from '../lib/taskAttachments';

const INPUT = 'w-full min-w-0 text-sm rounded-lg px-3 py-2 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-850';

/** Local draft only: uploads begin after the task and its assignees have been saved. */
export default function TaskAttachmentDraft({ value, onChange, disabled = false }) {
  const id = useId();
  const [error, setError] = useState(null);
  const files = value.files ?? [];
  const links = value.links?.length ? value.links : [{ url: '', label: '' }];
  const changeLink = (index, patch) => onChange({ ...value, links: links.map((link, i) => i === index ? { ...link, ...patch } : link) });
  const addFiles = (event) => {
    const selected = Array.from(event.target.files ?? []);
    event.target.value = '';
    try {
      selected.forEach(taskFileContentType);
      onChange({ ...value, files: [...files, ...selected] });
      setError(null);
    } catch (failure) { setError(failure.message); }
  };

  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-3 border-0 p-0 m-0">
      <legend className="mb-2 text-sm font-semibold text-neutral-700 dark:text-neutral-200">Files &amp; links (optional)</legend>
      <div className="space-y-1">
        <label htmlFor={`${id}-files`} className="flex items-center gap-1.5 text-xs font-semibold"><Paperclip size={13} /> Attach files</label>
        <input id={`${id}-files`} type="file" multiple accept={ACCEPTED_TASK_FILES} onChange={addFiles}
          className={`${INPUT} file:mr-3 file:cursor-pointer file:rounded file:border-0 file:px-2 file:py-1 file:text-xs`}
          aria-describedby={`${id}-file-help`} />
        <p id={`${id}-file-help`} className="text-xs text-neutral-500">Up to 10 MB per file. PDF, JPG, PNG, WebP, HEIC, CSV, TXT, XLSX or DOCX.</p>
        {files.length > 0 && <ul className="space-y-1 pt-1">
          {files.map((file, index) => <li key={`${file.name}-${index}`} className="flex min-w-0 items-center gap-2 text-xs">
            <Paperclip size={12} className="shrink-0" />
            <span className="min-w-0 flex-1 break-words">{file.name} <span className="text-neutral-500">({(file.size / 1048576).toFixed(1)} MB)</span></span>
            <button type="button" aria-label={`Remove file ${file.name}`} className="p-1 text-neutral-500 hover:text-rose-600"
              onClick={() => onChange({ ...value, files: files.filter((_, i) => i !== index) })}><X size={14} /></button>
          </li>)}
        </ul>}
      </div>
      <div className="space-y-2">
        {links.map((link, index) => <div key={index} className="space-y-1">
          <label htmlFor={`${id}-link-${index}`} className="flex items-center gap-1.5 text-xs font-semibold"><Link2 size={13} /> Link{links.length > 1 ? ` ${index + 1}` : ''}</label>
          <div className="flex items-center gap-2">
            <input id={`${id}-link-${index}`} type="text" inputMode="url" className={INPUT} placeholder="Paste a website or Drive link"
              value={link.url} onChange={(event) => changeLink(index, { url: event.target.value })} />
            {(links.length > 1 || link.url || link.label) && <button type="button" aria-label={`Remove link ${index + 1}`} className="shrink-0 p-1 text-neutral-500 hover:text-rose-600"
              onClick={() => onChange({ ...value, links: links.filter((_, i) => i !== index) })}><X size={14} /></button>}
          </div>
          {link.url && <label className="block text-xs text-neutral-500">Link label (optional)
            <input type="text" className={`${INPUT} mt-1`} placeholder="For example: Reference document" value={link.label}
              onChange={(event) => changeLink(index, { label: event.target.value })} maxLength={200} />
          </label>}
        </div>)}
        <button type="button" className="flex items-center gap-1 text-xs text-[var(--work-accent)]"
          onClick={() => onChange({ ...value, links: [...links, { url: '', label: '' }] })}><Plus size={13} /> Add another link</button>
      </div>
      {error && <p role="alert" className="text-xs text-rose-600 dark:text-rose-300">{error}</p>}
    </fieldset>
  );
}
