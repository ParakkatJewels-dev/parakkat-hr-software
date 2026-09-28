import { Check, Copy, X } from 'lucide-react';

export default function LoginHandoverNotice({ login, onDismiss }) {
  const fields = [['Email', login.email]];
  if (login.created && login.password) fields.push(['Temporary password', login.password]);
  return (
    <div className="premium-card border-brand/40 animate-fade-in" role="status">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5 min-w-0">
          <span className="shrink-0 w-8 h-8 rounded-xl bg-brand/10 text-brand-ink flex items-center justify-center">
            <Check size={16} />
          </span>
          <div className="min-w-0">
            <p className="text-base font-bold text-neutral-900 dark:text-white">
              {login.created ? `${login.name} can now sign in` : `Existing login linked to ${login.name}`}
            </p>
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
              {login.created
                ? 'No email was sent — pass these on yourself. The password is not shown again.'
                : 'Their password is unchanged. Use their current password, or reset it from Administration → Users & Access.'}
            </p>
          </div>
        </div>
        <button onClick={onDismiss} aria-label="Dismiss the login details"
          className="shrink-0 p-1.5 rounded-lg text-neutral-400 hover:text-neutral-900 dark:hover:text-white hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-pointer transition-colors">
          <X size={15} />
        </button>
      </div>
      <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
        {fields.map(([label, value]) => (
          <div key={label} className="flex items-center justify-between gap-2 rounded-xl bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-855 px-3 py-2">
            <div className="min-w-0">
              <p className="text-2xs uppercase tracking-wider font-bold text-neutral-400">{label}</p>
              <p className="text-base font-mono text-neutral-800 dark:text-neutral-200 truncate">{value}</p>
            </div>
            <button onClick={() => navigator.clipboard?.writeText(value)} title={`Copy ${label.toLowerCase()}`}
              aria-label={`Copy ${label.toLowerCase()}`}
              className="shrink-0 p-1.5 rounded-lg text-neutral-400 hover:text-brand-ink cursor-pointer transition-colors">
              <Copy size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
