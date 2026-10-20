// Work Ledger: a personal creative-operations ledger (tasks through review, daily progress, help
// given, ideas, campaigns) whose output is a report the owner edits and shares with management.
// Private to its owner and their line managers (read-only) — see migration 0169.
import React from 'react';
import '@fontsource-variable/fraunces';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import { useUrlTab } from '../lib/useUrlTab';
import { useLedgerBootstrap } from '../data/workLedger';
import { humanDbError } from '../lib/dbErrors';
import LedgerReports from './ledger/LedgerReports';
import LedgerSettings from './ledger/LedgerSettings';
import './ledger/ledger.css';

const TABS = [
  { id: 'reports', label: 'Reports', hint: 'Day, week, month or everything — ready to share' },
  { id: 'settings', label: 'Settings', hint: 'Import, export and checks' },
];

export default function WorkLedger() {
  const [tab, setTab] = useUrlTab('reports', TABS.map((item) => item.id));
  const boot = useLedgerBootstrap();
  const owner = boot.data?.owner;
  return (
    <div className="ledger-page">
      <header className="ledger-masthead">
        <p className="ledger-kicker">Work Ledger</p>
        <h1>{owner?.name ? `${owner.name.split(' ')[0]}’s ledger` : 'Your ledger'}</h1>
        {owner?.designation && <p className="ledger-standfirst">{owner.designation}</p>}
      </header>
      <nav className="ledger-tabs" role="tablist" aria-label="Work Ledger sections">
        {TABS.map((item) => (
          <button key={item.id} type="button" role="tab" id={`ledger-tab-${item.id}`} aria-controls={`ledger-panel-${item.id}`}
            aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} className="ledger-tab" onClick={() => setTab(item.id)}>
            {item.label}
          </button>
        ))}
      </nav>
      {boot.error ? (
        <p className="ledger-alert" role="alert">{humanDbError(boot.error) || 'Your ledger could not be opened.'}</p>
      ) : (
        <section className="ledger-panel" role="tabpanel" id={`ledger-panel-${tab}`} aria-labelledby={`ledger-tab-${tab}`}>
          {tab === 'reports' ? <LedgerReports /> : <LedgerSettings boot={boot.data} loading={boot.isLoading} />}
        </section>
      )}
    </div>
  );
}
