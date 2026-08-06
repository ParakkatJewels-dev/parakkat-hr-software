import React, { useMemo, useState } from 'react';
import { Briefcase, Users, Plus, Award, ChevronRight, X, User, Loader2, AlertTriangle } from 'lucide-react';
import { useJobs, useCandidates, useAddJob, useSetCandidateStage } from '../data/recruitment';
import { useVisibleOrg } from '../data/org';
import { usePermissions } from '../auth/usePermissions';
import PageHeader from './ui/PageHeader';

const STAGES = ['Applied', 'Shortlisted', 'Interview', 'Offered'];
const nextStage = (s) => STAGES[STAGES.indexOf(s) + 1] || s;

export default function Recruitment() {
  const { data: jobs = [], isLoading: jobsLoading, error: jobsError } = useJobs();
  const { data: candidates = [] } = useCandidates();
  const { data: org } = useVisibleOrg();
  const { canAny } = usePermissions();
  const addJob = useAddJob();
  const moveCand = useSetCandidateStage();
  const canManage = canAny('recruitment.manage');

  const entities = org?.entities ?? [];
  const [showForm, setShowForm] = useState(false);
  const [job, setJob] = useState({ entity_id: '', title: '', type: 'Full-time', location: '' });
  const pipelineStats = useMemo(() => {
    const openJobs = jobs.filter((j) => j.status === 'Open').length;
    const offered = candidates.filter((c) => c.stage === 'Offered').length;
    const scored = candidates.filter((c) => c.match_score != null);
    const avgMatch = scored.length
      ? Math.round(scored.reduce((sum, c) => sum + Number(c.match_score || 0), 0) / scored.length)
      : 0;
    return [
      { label: 'Open roles', value: openJobs, sub: `${jobs.length} total postings`, tone: 'green' },
      { label: 'Candidates', value: candidates.length, sub: 'Across pipeline', tone: 'blue' },
      { label: 'Offers', value: offered, sub: 'Reached final stage', tone: 'amber' },
      { label: 'Avg match', value: avgMatch ? `${avgMatch}%` : '—', sub: scored.length ? `${scored.length} scored` : 'No scores yet', tone: 'violet' },
    ];
  }, [jobs, candidates]);

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
    <div className="page-shell people-page space-y-5 animate-slide-up">
      <PageHeader
        eyebrow="People"
        icon={Briefcase}
        title="Hiring"
        subtitle="Track candidate pipelines and manage openings within your scope."
        actions={canManage && !showForm && (
          <button onClick={() => setShowForm(true)} className="people-action-button people-action-button-primary">
            <Plus size={14} /> Publish Opening
          </button>
        )}
      />

      <section className="people-insight-grid">
        {pipelineStats.map((stat) => (
          <div key={stat.label} className="people-insight-card" data-tone={stat.tone}>
            <span>{stat.label}</span>
            <strong>{stat.value}</strong>
            <em>{stat.sub}</em>
          </div>
        ))}
      </section>

      <div className="people-workspace grid grid-cols-1 xl:grid-cols-4 gap-5">
        <div className={`${showForm ? 'xl:col-span-3' : 'xl:col-span-4'}`}>
          <div className="premium-card people-board space-y-4">
            <div className="people-panel-head">
              <span><Users size={15} /> Candidate pipeline</span>
              <em>{candidates.length} active profiles</em>
            </div>
            <div className="people-kanban-grid grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
              {STAGES.map((stage) => {
                const list = candidates.filter((c) => c.stage === stage);
                return (
                  <div key={stage} className="people-kanban-column">
                    <div className="people-kanban-head">
                      <span>{stage}</span>
                      <b>{list.length}</b>
                    </div>
                    <div className="space-y-2">
                      {list.map((can) => (
                        <div key={can.id} className="people-candidate-card">
                          <div className="mobile-list-row flex justify-between items-start">
                            <div className="min-w-0">
                              <h4 className="font-bold text-neutral-800 dark:text-slate-200 text-xs truncate">{can.name}</h4>
                              <span className="text-2xs text-neutral-500 truncate block mt-0.5">{can.job?.title || '—'}</span>
                            </div>
                            {can.match_score != null && (
                              <div className="flex items-center text-2xs font-mono px-1 bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-450 rounded-md font-bold"><Award size={10} className="mr-0.5" />{can.match_score}%</div>
                            )}
                          </div>
                          {canManage && (
                            <div className="people-card-actions">
                              {stage !== 'Offered' && (
                                <button onClick={() => moveCand.mutate({ id: can.id, stage: nextStage(stage) })} title="Advance" aria-label="Advance"><ChevronRight size={12} /></button>
                              )}
                              <button onClick={() => moveCand.mutate({ id: can.id, stage: 'Rejected' })} title="Reject" aria-label="Reject" className="is-danger"><X size={12} /></button>
                            </div>
                          )}
                        </div>
                      ))}
                      {list.length === 0 && (
                        <div className="people-empty-mini"><User size={20} /><span>No applicants</span></div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="order-first xl:order-none xl:col-span-1">
          {showForm && canManage ? (
            <div className="premium-card people-side-panel space-y-4 animate-fade-in">
              <div className="people-panel-head">
                <span>Publish opening</span>
                <button onClick={() => setShowForm(false)} aria-label="Close opening form"><X size={15} /></button>
              </div>
              <form onSubmit={submit} className="space-y-3 text-xs">
                <Field label="Entity"><select required value={job.entity_id} onChange={(e) => setJob({ ...job, entity_id: e.target.value })} className={INPUT}><option value="">Select…</option>{entities.map((en) => <option key={en.id} value={en.id}>{en.code} — {en.name}</option>)}</select></Field>
                <Field label="Job Title"><input required value={job.title} onChange={(e) => setJob({ ...job, title: e.target.value })} placeholder="e.g. Sales Executive" className={INPUT} /></Field>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Field label="Type"><select value={job.type} onChange={(e) => setJob({ ...job, type: e.target.value })} className={INPUT}><option>Full-time</option><option>Part-time</option><option>Contract</option><option>Internship</option></select></Field>
                  <Field label="Location"><input value={job.location} onChange={(e) => setJob({ ...job, location: e.target.value })} placeholder="Kochi" className={INPUT} /></Field>
                </div>
                {addJob.error && <p className="text-xs text-red-500">{addJob.error.message}</p>}
                <div className="people-form-actions">
                  <button type="button" onClick={() => setShowForm(false)} className="people-action-button people-action-button-secondary">Cancel</button>
                  <button type="submit" disabled={addJob.isPending} className="people-action-button people-action-button-primary">{addJob.isPending && <Loader2 size={13} className="animate-spin" />} Publish</button>
                </div>
              </form>
            </div>
          ) : (
            <div className="premium-card people-side-panel space-y-4">
              <div className="people-panel-head">
                <span><Briefcase size={15} /> Job openings</span>
              </div>
              {jobsLoading ? (
                <div className="flex justify-center py-8 text-[#0ea971]"><Loader2 size={20} className="animate-spin" /></div>
              ) : jobsError ? (
                <div className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-300 py-2"><AlertTriangle size={14} className="shrink-0 mt-0.5" /> <span>{jobsError.message}</span></div>
              ) : jobs.length === 0 ? (
                <p className="people-empty-mini">No openings yet.</p>
              ) : (
                <div className="space-y-3 max-h-[460px] overflow-y-auto pr-1">
                  {jobs.map((j) => (
                    <div key={j.id} className="people-opening-card">
                      <div className="mobile-list-row flex justify-between items-start">
                        <h4 className="font-bold text-xs text-neutral-800 dark:text-slate-200 leading-snug">{j.title}</h4>
                        <span className={`text-2xs px-1.5 rounded-md font-bold uppercase font-mono border ${j.status === 'Open' ? 'bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-450 dark:border-emerald-900/30' : 'bg-neutral-200 text-neutral-500 border-neutral-300 dark:bg-neutral-900 dark:text-neutral-450 dark:border-neutral-800'}`}>{j.status}</span>
                      </div>
                      <div className="mobile-list-row flex justify-between text-2xs text-neutral-500"><span>{j.entity?.code}{j.branch?.code ? ` · ${j.branch.code}` : ''}</span><span>{j.location || '—'}</span></div>
                      <div className="text-2xs text-neutral-450 font-mono border-t border-neutral-100 dark:border-neutral-900/40 pt-2">{j.type} · {j.openings} opening(s)</div>
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

const INPUT = 'w-full text-xs rounded-xl px-3 py-1.5 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200/80 dark:border-neutral-850 text-neutral-800 dark:text-neutral-200 focus:outline-none focus:border-[#0ea971] font-medium';
const Field = ({ label, children }) => (
  <div className="space-y-1"><label className="text-neutral-500 font-semibold uppercase text-2xs tracking-wider">{label}</label>{children}</div>
);
