// Document Management.
//
// This was a register: a title, a category, and a URL you typed in yourself. There was no file
// upload anywhere in the application, and the footnote at the bottom of this screen said so. Now the
// file is stored — privately, and reached only through a signed link that expires in a minute.
import React, { useMemo, useRef, useState } from 'react';
import {
  FolderOpen, Plus, ShieldAlert, Loader2, AlertTriangle, FileText, FilePlus,
  Download, Trash2, Link2, Upload,
} from 'lucide-react';
import {
  useDocuments, useAddDocument, useDocumentLink, useDeleteDocument,
  fileSize, ACCEPTED_FILES, MAX_FILE_BYTES,
} from '../data/documents';
import { usePermissions } from '../auth/usePermissions';
import { useAuth } from '../auth/AuthContext';
import FormSection, { Field, FIELD } from './ui/FormSection';
import ConfirmDialog from './ui/ConfirmDialog';
import Pagination, { usePagination } from './ui/Pagination';
import PageHeader from './ui/PageHeader';

const CATS = ['Policy', 'HR Letter', 'Identity', 'Contract', 'Certificate', 'Other'];

const EMPTY = { title: '', category: 'Policy', attachSelf: false, url: '' };

export default function DocumentManagement() {
  const { data: docs = [], isLoading, error } = useDocuments();
  const { canAny } = usePermissions();
  const { employee } = useAuth();
  const add = useAddDocument();
  const link = useDocumentLink();
  const remove = useDeleteDocument();
  const canManage = canAny('document.manage');

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [file, setFile] = useState(null);
  const [fileError, setFileError] = useState(null);
  const [confirming, setConfirming] = useState(null);
  const fileInput = useRef(null);
  const stats = useMemo(() => {
    const stored = docs.filter((d) => d.storage_path).length;
    const links = docs.length - stored;
    const personal = docs.filter((d) => d.employee?.full_name).length;
    const signed = docs.filter((d) => d.signed).length;
    return [
      { label: 'Documents', value: docs.length, sub: 'Visible in scope', tone: 'green' },
      { label: 'Stored files', value: stored, sub: `${links} external links`, tone: 'blue' },
      { label: 'Employee docs', value: personal, sub: 'Attached to people', tone: 'amber' },
      { label: 'Signed', value: signed, sub: 'Completed records', tone: 'violet' },
    ];
  }, [docs]);

  // Rejected here as well as by the bucket, because a 40 MB file refused after it has finished
  // uploading is a worse experience than one refused before it starts.
  const pickFile = (picked) => {
    setFileError(null);
    if (!picked) return setFile(null);
    if (picked.size > MAX_FILE_BYTES) {
      setFileError(`That file is ${fileSize(picked.size)}. The limit is ${fileSize(MAX_FILE_BYTES)}.`);
      return setFile(null);
    }
    setFile(picked);
  };

  const reset = () => {
    setForm(EMPTY); setFile(null); setFileError(null);
    if (fileInput.current) fileInput.current.value = '';
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!form.title) return;
    // A record with neither is a title and nothing else, which is how the register filled up with
    // entries nobody could open. The database rejects it too; this says so before the round trip.
    if (!file && !form.url.trim()) {
      setFileError('Attach a file, or give a link to where the document lives.');
      return;
    }

    const payload = { title: form.title, category: form.category };
    if (form.url.trim()) payload.url = form.url.trim();
    if (form.attachSelf && employee?.id) payload.employee_id = employee.id;

    try {
      await add.mutateAsync({ ...payload, file });
      reset();
      setShowForm(false);
    } catch { /* surfaced by FormSection */ }
  };

  // Signed on demand: the link is minted at the moment of the click and opened straight away, so
  // nothing durable is handed out.
  const open = async (doc) => {
    try {
      const href = await link.mutateAsync(doc);
      window.open(href, '_blank', 'noopener');
    } catch { /* surfaced under the list */ }
  };

  const pager = usePagination(docs);

  return (
    <div className="page-shell people-page space-y-5 animate-fade-in">
      <PageHeader
        eyebrow="People"
        icon={FolderOpen}
        title="Documents"
        subtitle="Policies, letters, identity files and company documents within your scope."
        actions={canManage && !showForm && (
          <button onClick={() => setShowForm(true)} className="people-action-button people-action-button-primary">
            <Plus size={14} /> Add document
          </button>
        )}
      />

      <section className="people-insight-grid">
        {stats.map((stat) => (
          <div key={stat.label} className="people-insight-card" data-tone={stat.tone}>
            <span>{stat.label}</span>
            <strong>{stat.value}</strong>
            <em>{stat.sub}</em>
          </div>
        ))}
      </section>

      {/* Opens directly under the button that summons it — it used to render below the
          whole document list, so on a long list nothing appeared to happen. */}
      {showForm && canManage && (
        <FormSection
          title="Add a document"
          subtitle="Attach a file, or record where one lives."
          icon={FilePlus}
          onClose={() => { add.reset(); reset(); setShowForm(false); }}
          onSubmit={submit}
          submitLabel={file ? 'Upload and save' : 'Save document'}
          busy={add.isPending}
          error={add.error?.message ?? fileError}
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Title" htmlFor="doc-title" required>
              <input
                id="doc-title" required value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="e.g. Employee Handbook v5" className={FIELD}
              />
            </Field>
            <Field label="Category" htmlFor="doc-cat">
              <select
                id="doc-cat" value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
                className={FIELD + ' cursor-pointer'}
              >
                {CATS.map((c) => <option key={c}>{c}</option>)}
              </select>
            </Field>
          </div>

          <Field label="File" htmlFor="doc-file">
            <div className="flex flex-wrap items-center gap-2">
              <label
                htmlFor="doc-file"
                className="px-3 py-2 rounded-xl bg-neutral-100 dark:bg-neutral-900 hover:bg-neutral-200 dark:hover:bg-neutral-800 text-xs font-bold flex items-center gap-1.5 cursor-pointer"
              >
                <Upload size={13} /> {file ? 'Choose a different file' : 'Choose a file'}
              </label>
              <input
                id="doc-file" ref={fileInput} type="file" accept={ACCEPTED_FILES} className="sr-only"
                onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
              />
              {file ? (
                <span className="text-xs text-neutral-700 dark:text-neutral-300 truncate">
                  {file.name} <span className="text-neutral-450">· {fileSize(file.size)}</span>
                </span>
              ) : (
                <span className="text-2xs text-neutral-450">
                  PDF, image, Word or Excel · up to {fileSize(MAX_FILE_BYTES)}
                </span>
              )}
            </div>
          </Field>

          <Field label="Or a link, if the document lives elsewhere" htmlFor="doc-url">
            <input
              id="doc-url" type="url" value={form.url}
              onChange={(e) => setForm({ ...form, url: e.target.value })}
              placeholder="https://…" className={FIELD}
            />
          </Field>

          {employee?.id && (
            <label className="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300 cursor-pointer">
              <input
                type="checkbox" checked={form.attachSelf}
                onChange={(e) => setForm({ ...form, attachSelf: e.target.checked })}
                className="accent-[#0ea971] cursor-pointer"
              />
              Attach to my own record (otherwise it is company-wide)
            </label>
          )}
        </FormSection>
      )}

      <div className="premium-card people-library-card space-y-4">
        <div className="people-panel-head">
          <span><FolderOpen size={15} /> Document library</span>
          <em>{pager.from}–{pager.to} of {pager.count}</em>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-10 text-[#0ea971]"><Loader2 size={22} className="animate-spin" /></div>
        ) : error ? (
          <div className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-300 py-3"><AlertTriangle size={15} className="shrink-0 mt-0.5" /> <span>{error.message}</span></div>
        ) : docs.length === 0 ? (
          <div className="people-empty-state is-compact">
            <FolderOpen size={24} />
            <strong>No documents yet</strong>
            <span>Files and policy links will appear here when added.</span>
          </div>
        ) : (
          <div className="people-document-grid">
            {pager.slice.map((d) => (
              <div key={d.id} className="people-document-card">
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className="people-document-icon">
                    {d.storage_path ? <FileText size={16} /> : <Link2 size={16} />}
                  </span>
                  <div className="min-w-0">
                    <span className="text-xs font-bold text-neutral-800 dark:text-slate-200 block truncate">{d.title}</span>
                    <span className="text-2xs text-neutral-500 block truncate">
                      {d.category || 'Uncategorized'}
                      {d.employee?.full_name ? ` · ${d.employee.full_name}` : ' · Company-wide'}
                      {d.storage_path ? ` · ${fileSize(d.size_bytes)}` : ' · link'}
                    </span>
                  </div>
                </div>
                <div className="mobile-list-actions flex items-center gap-1 shrink-0">
                  {d.signed && <span className="text-2xs px-1.5 py-0.5 bg-emerald-100 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-450 rounded-md font-mono">SIGNED</span>}
                  <button
                    onClick={() => open(d)}
                    disabled={link.isPending}
                    title={d.storage_path ? 'Download' : 'Open the link'}
                    aria-label={d.storage_path ? `Download ${d.title}` : `Open ${d.title}`}
                    className="people-icon-button"
                  >
                    {link.isPending ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                  </button>
                  {canManage && (
                    <button
                      onClick={() => setConfirming(d)}
                      title="Delete" aria-label={`Delete ${d.title}`}
                      className="people-icon-button is-danger"
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {link.error ? (
          <div className="flex items-start gap-2 text-xs text-red-600 dark:text-red-400">
            <AlertTriangle size={13} className="shrink-0 mt-0.5" /> <span>{link.error.message}</span>
          </div>
        ) : null}
        {remove.error ? (
          <div className="flex items-start gap-2 text-xs text-red-600 dark:text-red-400">
            <AlertTriangle size={13} className="shrink-0 mt-0.5" /> <span>{remove.error.message}</span>
          </div>
        ) : null}

        <div className="p-3.5 bg-neutral-100 dark:bg-neutral-900/60 border border-neutral-200 dark:border-neutral-850 rounded-xl flex items-start gap-2 text-xs text-neutral-500 dark:text-neutral-450">
          <ShieldAlert size={14} className="text-neutral-600 dark:text-neutral-400 shrink-0 mt-0.5" />
          <p>
            Files are stored privately and are not reachable by URL. Each download link is signed at
            the moment you click it and expires within a minute, and a file is visible to exactly the
            people who can see its record.
          </p>
        </div>
      </div>

      {confirming && (
        <ConfirmDialog
          title={`Delete ${confirming.title}?`}
          confirmLabel="Delete"
          busy={remove.isPending}
          error={remove.error?.message}
          onCancel={() => { remove.reset(); setConfirming(null); }}
          onConfirm={async () => {
            try { await remove.mutateAsync(confirming); setConfirming(null); } catch { /* shown in the dialog */ }
          }}
        >
          {/* Says which of the two this is, because one is recoverable and the other is not. */}
          {confirming.storage_path ? (
            <p>
              The record and the stored file will both be deleted permanently.
              {confirming.file_name ? <> <span className="font-mono">{confirming.file_name}</span></> : null}
            </p>
          ) : (
            <p>The record will be removed. Whatever it links to is not affected.</p>
          )}
        </ConfirmDialog>
      )}

      <Pagination {...pager} noun="documents" />
    </div>
  );
}
