import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Home } from 'lucide-react';
import BrandMark from '../components/ui/BrandMark';
import { btnClass } from '../components/ui/Btn';

export default function NotFound({ appName = 'Parakkat', standalone = false }) {
  useEffect(() => {
    if (!standalone) return undefined;
    const previous = document.title;
    document.title = `Page not found · ${appName}`;
    return () => { document.title = previous; };
  }, [appName, standalone]);
  const Container = standalone ? 'main' : 'section';
  return <Container className={`${standalone ? 'min-h-svh bg-neutral-50 dark:bg-charcoal-900 px-4' : 'page-shell min-h-[55vh]'} flex min-w-0 items-center justify-center py-8 sm:py-14`} aria-labelledby="not-found-title">
    <div className="premium-card w-full max-w-md space-y-5 p-5 text-center sm:p-8">
      <div className="flex min-w-0 items-center justify-center gap-2 text-sm font-bold text-neutral-700 dark:text-neutral-200">
        <BrandMark size={24} /><span className="break-words">{appName}</span>
      </div>
      <div className="text-6xl font-bold tracking-tight text-brand-ink" aria-label="Error 404">404</div>
      <div className="space-y-2"><h1 id="not-found-title" className="text-xl font-bold text-neutral-900 dark:text-white">Page not found</h1>
        <p className="text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">This page doesn’t exist or the link has changed.</p>
        <p className="text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">Go to Home to continue with your work.</p></div>
      <Link to="/dashboard" className={`${btnClass('primary')} min-h-11 w-full sm:w-auto sm:px-5`}><Home size={17} aria-hidden="true" />Go to Home</Link>
    </div>
  </Container>;
}
