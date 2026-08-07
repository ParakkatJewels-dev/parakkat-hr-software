// The picture of an asset, picked while registering it.
//
// Words are the wrong medium for the two jobs this register does. Handing something over means
// agreeing what it looked like at the time, and taking it back means agreeing whether it still
// does — "Fair" settles nothing when the argument is about a cracked lid. And on a list of a
// hundred similar black laptops, a thumbnail identifies an item faster than the code on its
// sticker. One current photograph per asset, replaced when it changes.
import React, { useEffect, useState } from 'react';
import { Camera, X, AlertTriangle } from 'lucide-react';

const MAX_BYTES = 8 * 1024 * 1024;
const ACCEPT = 'image/jpeg,image/png,image/webp,image/heic';

const readable = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

export default function AssetPhotoField({ file, existingUrl, onPick }) {
  const [preview, setPreview] = useState(null);
  const [problem, setProblem] = useState(null);

  // Object URLs are a leak if they are not revoked, and a stale one is a picture of the last file
  // you picked shown against the current one.
  useEffect(() => {
    if (!file) { setPreview(null); return undefined; }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const pick = (chosen) => {
    setProblem(null);
    if (!chosen) { onPick(null); return; }
    if (!chosen.type.startsWith('image/')) {
      setProblem('That is not an image. A photograph of the item, please — JPEG, PNG or HEIC.');
      return;
    }
    if (chosen.size > MAX_BYTES) {
      setProblem(`That photo is ${readable(chosen.size)}. The limit is ${readable(MAX_BYTES)}.`);
      return;
    }
    onPick(chosen);
  };

  const shown = preview ?? existingUrl ?? null;

  return (
    <div className="asset-photo-field">
      <div className="asset-photo-frame" data-empty={shown ? 'false' : 'true'}>
        {shown ? <img src={shown} alt="" /> : <Camera size={22} aria-hidden="true" />}
      </div>

      <div className="asset-photo-copy">
        <label className="asset-photo-pick">
          {/* `capture` is a hint, not a demand: on a phone it offers the camera first, which is
              where this photograph is actually taken, while a laptop still gets a file picker. */}
          <input
            type="file"
            accept={ACCEPT}
            capture="environment"
            onChange={(e) => { pick(e.target.files?.[0] ?? null); e.target.value = ''; }}
          />
          <Camera size={13} />
          {shown ? 'Replace photo' : 'Add a photo'}
        </label>

        {file && (
          <button type="button" className="asset-photo-clear" onClick={() => { setProblem(null); onPick(null); }}>
            <X size={12} /> Remove
          </button>
        )}

        <p className="asset-photo-hint">
          {existingUrl && !file
            ? 'Choosing a new one replaces this.'
            : 'Shown wherever this item is listed, and what a handover argument gets settled against.'}
        </p>

        {problem && (
          <p className="asset-photo-problem" role="alert">
            <AlertTriangle size={12} /> {problem}
          </p>
        )}
      </div>
    </div>
  );
}
