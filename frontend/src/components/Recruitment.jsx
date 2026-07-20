import React, { useState } from 'react';
import { Briefcase, Users, Plus, Award, ChevronRight, X, User, Loader2, AlertTriangle } from 'lucide-react';
import { useJobs, useCandidates, useAddJob, useSetCandidateStage } from '../data/recruitment';
import { useOrg } from '../data/org';
import { usePermissions } from '../auth/usePermissions';

const STAGES = ['Applied', 'Shortlisted', 'Interview', 'Offered'];
const nextStage = (s) => STAGES[STAGES.indexOf(s) + 1] || s;

export default function Recruitment() {
  const { data: jobs = [], isLoading: jobsLoading, error: jobsError } = useJobs();
  const { data: candidates = [] } = useCandidates();
  const { data: org } = useOrg();
  const { canAny } = usePermissions();
  const addJob = useAddJob();
  const moveCand = useSetCandidateStage();
  const canManage = canAny('recruitment.manage');

  const entities = org?.entities ?? [];
  const [showForm, setShowForm] = useState(false);
  const [job, setJob] = useState({ entity_id: '', title: '', type: 'Full-time', location: '' });

  const submit = async (e) => {
    e.preventDefault();
    if (!job.title || !job.entity_id) return;
    try {
      await addJob.mutateAsync({ entity_id: job.entity_id, title: job.title, type: job.type, location: job.location, openings: 1 });
      setJob({ entity_id: '', title: '', type: 'Full-time', location: '' });
      setShowForm(false);
    } catch { /* shown below */ }
  };

  return (
    <div className="page-shell space-y-6 animate-slide-up">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-xl font-bold text-neutral-900 dark:text-slate-100 font-sans">Recruitment</h2>
          <p className="text-xs text-neutral-500 dark:text-slate-400">Track candidate pipelines and manage openings within your scope.</p>
        </div>
        {canManage && !showForm && (
          <button onClick={() => setShowForm(true)} className="flex items-center gap-1.5 px-4 py-2 bg-black dark:bg-gold-450 dark:text-charcoal-900 text-white text-xs font-semibold rounded-xl hover:opacity-90 cursor-pointer shadow-md">
            <Plus size={14} /> Publish Opening
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-4 gap-6">
        <div className="xl:col-span-3">
          <div className="premium-card p-5 space-y-4">
            <h3 className="font-bold text-xs uppercase tracking-wider text-neutral-850 dark:text-neutral-100 flex items-center">
              <Users size={16} className="mr-2 text-neutral-600 dark:text-neutral-400" /> Candidate Pipeline
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
              {STAGES.map((stage) => {
                const list = candidates.filter((c) => c.stage === stage);
                return (
                  <div key={stage} className="bg-neutral-50/50 dark:bg-neutral-950/40 rounded-xl border border-neutral-200/80 dark:border-neutral-900 p-3.5 space-y-3.5 min-h-[360px]">
                    <div className="flex justify-between items-center border-b border-neutral-200 dark:border-neutral-850 pb-2">
                      <span className="text-[10px] font-bold text-neutral-500 uppercase tracking-widest">{stage}</span>
                      <span className="px-1.5 bg-neutral-200/50 dark:bg-neutral-900 text-neutral-550 dark:text-neutral-405 font-mono text-[9px] rounded-md font-bold border border-neutral-300 dark:border-neutral-800">{list.length}</span>
                    </div>
                    <div className="space-y-2">
                      {list.map((can) => (
                        <div key={can.id} className="bg-white dark:bg-neutral-900 p-3 rounded-lg border border-neutral-200/80 dark:border-neutral-850 hover:border-black dark:hover:border-white transition-all group">
                          <div className="flex justify-between items-start">
                            <div className="min-w-0">
                              <h4 className="font-bold text-neutral-800 dark:text-slate-200 text-xs truncate">{can.name}</h4>
                              <span className="text-[9.5px] text-neutral-500 truncate block mt-0.5">{can.job?.title || '—'}</span>
                            </div>
                            {can.match_score != null && (
                              <div className="flex items-center text-[9px] font-mono px-1 bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-450 rounded-md font-bold"><Award size={10} className="mr-0.5" />{can.match_score}%</div>
                            )}
                          </div>
                          {canManage && (
                            <div className="mt-3 pt-2 border-t border-neutral-100 dark:border-neutral-850/40 flex justify-end gap-1">
                              {stage !== 'Offered' && (
                                <button onClick={() => moveCand.mutate({ id: can.id, stage: nextStage(stage) })} title="Advance" className="p-1 bg-neutral-100 hover:bg-black hover:text-white dark:bg-neutral-850 dark:hover:bg-white dark:hover:text-black rounded text-neutral-600 cursor-pointer border border-neutral-200 dark:border-neutral-800"><ChevronRight size={10} /></button>
                              )}
                              <button onClick={() => moveCand.mutate({ id: can.id, stage: 'Rejected' })} title="Reject" className="p-1 bg-neutral-105 hover:bg-rose-600 hover:text-white dark:bg-neutral-850 dark:hover:bg-rose-500 rounded text-neutral-600 cursor-pointer border border-neutral-200 dark:border-neutral-800"><X size={10} /></button>
                            </div>
                          )}
                        </div>
                      ))}
                      {list.length === 0 && (
                        <div className="py-10 text-center text-neutral-450 text-[10.5px] flex flex-col items-center"><User size={20} className="opacity-30 mb-1" /><span>No applicants</span></div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="xl:col-span-1">
          {showForm && canManage ? (
            <div className="premium-card p-5 space-y-4 animate-fade-in">
              <div className="flex justify-between items-center border-b border-neutral-100 dark:border-neutral-900 pb-2.5">
                <h3 className="font-bold text-xs uppercase tracking-wider text-neutral-800 dark:text-neutral-150">Publish Opening</h3>
                <button onClick={() => setShowForm(false)} className="p-1 hover:bg-neutral-100 dark:hover:bg-neutral-900 rounded text-neutral-450 cursor-pointer"><X size={15} /></button>
              </div>
              <form onSubmit={submit} className="space-y-3 text-xs">
                <Field label="Entity"><select required value={job.entity_id} onChange={(e) => setJob({ ...job, entity_id: e.target.value })} className={INPUT}><option value="">Select…</option>{entities.map((en) => <option key={en.id} value={en.id}>{en.code} — {en.name}</option>)}</select></Field>
                <Field label="Job Title"><input required value={job.title} onChange={(e) => setJob({ ...job, title: e.target.value })} placeholder="e.g. Sales Executive" className={INPUT} /></Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Type"><select value={job.type} onChange={(e) => setJob({ ...job, type: e.target.value })} className={INPUT}><option>Full-time</option><option>Part-time</option><option>Contract</option><option>Internship</option></select></Field>
                  <Field label="Location"><input value={job.location} onChange={(e) => setJob({ ...job, location: e.target.value })} placeholder="Kochi" className={INPUT} /></Field>
                </div>
                {addJob.error && <p className="text-[11px] text-red-500">{addJob.error.message}</p>}
                <div className="flex justify-end gap-2 pt-1">
                  <button type="button" onClick={() => setShowForm(false)} className="px-3 py-2 text-xs font-semibold text-neutral-500 hover:text-neutral-900 dark:hover:text-white cursor-pointer">Cancel</button>
                  <button type="submit" disabled={addJob.isPending} className="px-3.5 py-2 bg-black dark:bg-gold-450 dark:text-charcoal-900 text-white text-xs font-semibold rounded-xl hover:opacity-90 disabled:opacity-60 cursor-pointer flex items-center gap-1.5">{addJob.isPending && <Loader2 size={13} className="animate-spin" />} Publish</button>
                </div>
              </form>
            </div>
          ) : (
            <div className="premium-card p-5 space-y-4">
              <h3 className="font-bold text-xs uppercase tracking-wider text-neutral-855 dark:text-neutral-100 border-b border-neutral-100 dark:border-neutral-900 pb-2.5 flex items-center">
                <Briefcase size={15} className="mr-2 text-neutral-600 dark:text-neutral-400" /> Job Openings
              </h3>
              {jobsLoading ? (
                <div className="flex justify-center py-8 text-gold-500"><Loader2 size={20} className="animate-spin" /></div>
              ) : jobsError ? (
                <div className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-300 py-2"><AlertTriangle size={14} className="shrink-0 mt-0.5" /> <span>{jobsError.message}</span></div>
              ) : jobs.length === 0 ? (
                <p className="text-xs text-neutral-500 py-6 text-center">No openings yet.</p>
              ) : (
                <div className="space-y-3 max-h-[460px] overflow-y-auto pr-1">
                  {jobs.map((j) => (
                    <div key={j.id} className="p-3.5 bg-neutral-50 dark:bg-neutral-950/20 border border-neutral-200 dark:border-neutral-850 rounded-xl space-y-2">
                      <div className="flex justify-between items-start">
                        <h4 className="font-bold text-xs text-neutral-800 dark:text-slate-200 leading-snug">{j.title}</h4>
                        <span className={`text-[8.5px] px-1.5 rounded-md font-bold uppercase font-mono border ${j.status === 'Open' ? 'bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-450 dark:border-emerald-900/30' : 'bg-neutral-200 text-neutral-500 border-neutral-300 dark:bg-neutral-900 dark:text-neutral-450 dark:border-neutral-800'}`}>{j.status}</span>
                      </div>
                      <div className="flex justify-between text-[10px] text-neutral-500"><span>{j.entity?.code}{j.branch?.code ? ` · ${j.branch.code}` : ''}</span><span>{j.location || '—'}</span></div>
                      <div className="text-[9px] text-neutral-450 font-mono border-t border-neutral-100 dark:border-neutral-900/40 pt-2">{j.type} · {j.openings} opening(s)</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const INPUT = 'w-full text-xs rounded-xl px-3 py-1.5 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200/80 dark:border-neutral-850 text-neutral-800 dark:text-neutral-200 focus:outline-none focus:border-gold-500 font-medium';
const Field = ({ label, children }) => (
  <div className="space-y-1"><label className="text-neutral-500 font-semibold uppercase text-[9px] tracking-wider">{label}</label>{children}</div>
);
