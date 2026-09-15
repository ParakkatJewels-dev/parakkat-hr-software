import { APP_IDENTITIES } from './appName.js';

function setMeta(document, name, content) {
  let meta = document.querySelector(`meta[name="${name}"]`);
  if (!meta) {
    meta = document.createElement('meta');
    meta.setAttribute('name', name);
    document.head.appendChild(meta);
  }
  meta.setAttribute('content', content);
}

/** Register before adding the manifest, so even a fast cached fetch cannot lose its prompt. */
export function watchPwaIdentity({ identity, document, window, onPrompt, onInstalled }) {
  // A prompt belongs to the manifest/account that produced it; never reuse it after a switch.
  onPrompt(null);
  const beforeInstall = event => {
    event.preventDefault();
    onPrompt(event);
  };
  const installed = () => {
    onPrompt(null);
    onInstalled();
  };
  window.addEventListener('beforeinstallprompt', beforeInstall);
  window.addEventListener('appinstalled', installed);

  let manifest = document.querySelector('link[rel="manifest"]');
  if (!manifest) {
    manifest = document.createElement('link');
    manifest.setAttribute('rel', 'manifest');
    document.head.appendChild(manifest);
  }
  manifest.setAttribute('href', identity.manifestHref);
  setMeta(document, 'apple-mobile-web-app-title', identity.name);
  setMeta(document, 'application-name', identity.name);
  document.title = identity.name;

  return () => {
    window.removeEventListener('beforeinstallprompt', beforeInstall);
    window.removeEventListener('appinstalled', installed);
    onPrompt(null);
    // The next account must resolve its own name before the browser prepares another prompt.
    manifest.remove();
    setMeta(document, 'apple-mobile-web-app-title', APP_IDENTITIES.default.name);
    setMeta(document, 'application-name', APP_IDENTITIES.default.name);
    document.title = APP_IDENTITIES.default.name;
  };
}
