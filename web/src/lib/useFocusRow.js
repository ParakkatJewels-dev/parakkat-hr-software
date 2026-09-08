// The React half of focusRow.js: claim the `?focus=` a notification arrived with, point the page at
// that row, and get the parameter back out of the URL.
//
// The rules live in focusRow.js, without React or the router, so they can be tested directly.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { focusIdFrom, stripFocus } from './focusRow';

/** How long the row stays marked after you land on it. Long enough to find, short enough to forget. */
const HIGHLIGHT_MS = 2600;

/**
 * @returns {{ focusId: string|null, rowProps: (id: string) => object }}
 *
 * `focusId` is the row this screen was sent to — use it to widen a filter or to say the row is no
 * longer there. `rowProps(id)` is spread onto each row; the matching one scrolls itself into view
 * and carries `data-focus-row`, which index.css turns into a brief ring.
 */
export function useFocusRow() {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const urlFocus = focusIdFrom(search);

  // Held in state, not read from the URL each render, because the parameter is cleared immediately
  // and the row still has to be found, paged to and scrolled — all of which happen after that.
  const [focusId, setFocusId] = useState(null);
  const timer = useRef(null);

  useEffect(() => {
    if (!urlFocus) return undefined;
    setFocusId(urlFocus);
    // Consume it: a refresh must not re-scroll, and Back must not re-highlight something already
    // dealt with. replace, so this does not add a history entry of its own.
    navigate({ pathname, search: stripFocus(search) }, { replace: true });
    return undefined;
  }, [urlFocus, pathname, search, navigate]);

  // Stop marking the row after a while. The mark answers "which one did it mean"; once you have
  // read it, a permanently ringed row is just a row that looks wrong.
  useEffect(() => {
    if (!focusId) return undefined;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setFocusId(null), HIGHLIGHT_MS);
    return () => clearTimeout(timer.current);
  }, [focusId]);

  // Stable identity: React calls a ref callback on mount and unmount only, so the scroll happens
  // once, when the row actually appears — which may be after the list has paged to it.
  const attach = useCallback((node) => {
    node?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, []);

  const rowProps = useCallback(
    (id) => (id && id === focusId ? { ref: attach, 'data-focus-row': '' } : {}),
    [focusId, attach]
  );

  return { focusId, rowProps };
}

export default useFocusRow;
