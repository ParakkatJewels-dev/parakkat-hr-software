// The sync program for the Easy Time Pro machine, offered as a download (Attendance setup -> Sync
// status). It used to travel on a pen drive or as a git clone, and a copied folder brought the
// development machine's settings along. The zip (made by `npm run pack:attendance`) has the code
// and the installer only: Install.bat asks for the Easy Time Pro login and the database password,
// and run from a new folder it takes over an existing install (settings and Windows service).
import React, { useEffect, useState } from 'react';
import { Download, MonitorDown } from 'lucide-react';
import { btnClass } from '../ui/Btn';
import './syncServiceDownload.css';

export const SYNC_PACKAGE_URL = '/downloads/parakkat-attendance-sync.zip';
const MANIFEST_URL = '/downloads/parakkat-attendance-sync.json';

const packedOn = (iso) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

export default function SyncServiceDownload() {
  const [info, setInfo] = useState(null);
  useEffect(() => {
    let live = true;
    fetch(MANIFEST_URL, { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((manifest) => { if (live) setInfo(manifest); })
      .catch(() => {});
    return () => { live = false; };
  }, []);

  return (
    <section className="premium-card sync-download" aria-labelledby="sync-download-title">
      <div className="sync-download-head">
        <span className="sync-download-icon" aria-hidden="true"><MonitorDown size={20} /></span>
        <div className="min-w-0">
          <h3 id="sync-download-title">Sync program for the Easy Time Pro computer</h3>
          <p>
            Download it on the computer that runs Easy Time Pro.
            {info?.packed_at ? ` Updated ${packedOn(info.packed_at)}${info.bytes ? ` · ${Math.round(info.bytes / 1024)} KB` : ''}.` : ''}
          </p>
        </div>
        <a className={btnClass('primary')} href={SYNC_PACKAGE_URL} download>
          <Download size={16} aria-hidden="true" /> Download
        </a>
      </div>
      <ol className="sync-download-steps">
        <li><strong>Unzip</strong> it into a folder that stays, for example <code>D:\Parakkat\attendance-sync</code>.</li>
        <li><strong>Double-click Install.bat</strong> and allow administrator access. It installs Node packages, builds and starts the sync as a Windows service.</li>
        <li>When asked, enter the <strong>Easy Time Pro login</strong> and the <strong>database password</strong> (Supabase → Project Settings → Database).</li>
      </ol>
      <p className="sync-download-note">
        Updating: unzip the new download anywhere and run Install.bat. If the sync is already installed from another folder, it
        brings that folder’s settings across and moves the service here. If the database password was changed in Supabase, type
        the new one when Install.bat asks.
      </p>
    </section>
  );
}
