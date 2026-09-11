import { useLayoutEffect, useRef, useState } from 'react';
import { clamp, constrainLens, dragIntent, insideDock, nearestDestination, stepSpring } from './liquidGlassMotion.js';

/** A small DOM-only spring: motion never rerenders the application or samples its content. */
export default function LiquidGlassNav({ items, activeId, onSelect, menuOpen = false, isPwaInstalled = false }) {
  const navRef = useRef(null);
  const lensRef = useRef(null);
  const buttonsRef = useRef(new Map());
  const controllerRef = useRef({});
  const latest = useRef({ items, activeId, onSelect });
  latest.current = { items, activeId, onSelect };
  const [failedAvatar, setFailedAvatar] = useState(null);
  // Parent renders may recreate items; only a changed set of destinations rebuilds measurement.
  const destinationKey = items.map(item => `${item.id}:${!!item.disabled}`).join('|');

  useLayoutEffect(() => {
    const nav = navRef.current;
    const lens = lensRef.current;
    if (!nav || !lens) return undefined;
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const motion = { x: 0, width: 0, velocity: 0, widthVelocity: 0, targetX: 0, targetWidth: 0,
      frame: 0, last: 0, ready: false, reduced: preference.matches, press: 0, lightX: 50, lightY: 15 };
    let geometry = null;
    let gesture = null;
    let hovered = false;
    let suppressClickUntil = 0;
    let previewId = null;
    let disposed = false;

    function paint() {
      const requestedStretch = motion.reduced ? 0 : Math.min(Math.abs(motion.velocity) / 6500, 0.13);
      // Spring energy may overshoot the target, but the expanded lens stays inside the dock.
      const { x: paintedX, stretch } = geometry
        ? constrainLens(motion.x, motion.width, requestedStretch, geometry.innerWidth)
        : { x: motion.x, stretch: 0 };
      nav.style.setProperty('--glass-x', `${paintedX.toFixed(3)}px`);
      nav.style.setProperty('--glass-width', `${motion.width.toFixed(3)}px`);
      nav.style.setProperty('--glass-stretch', String(1 + stretch));
      nav.style.setProperty('--glass-squash', String(1 - stretch * 0.34 - (motion.reduced ? 0 : motion.press * 0.035)));
      nav.style.setProperty('--glass-press', String(motion.press));
      nav.style.setProperty('--glass-light-x', `${motion.lightX.toFixed(2)}%`);
      nav.style.setProperty('--glass-light-y', `${motion.lightY.toFixed(2)}%`);
    }

    function stop() {
      if (motion.frame) cancelAnimationFrame(motion.frame);
      motion.frame = 0;
      motion.last = 0;
    }

    function tick(now) {
      motion.frame = 0;
      if (disposed || !geometry) return;
      const dt = motion.last ? (now - motion.last) / 1000 : 1 / 60;
      motion.last = now;
      const nextX = stepSpring(motion.x, motion.velocity, motion.targetX, dt);
      const nextWidth = stepSpring(motion.width, motion.widthVelocity, motion.targetWidth, dt);
      motion.x = nextX.position;
      motion.velocity = nextX.velocity;
      motion.width = nextWidth.position;
      motion.widthVelocity = nextWidth.velocity;
      const settled = motion.reduced || (Math.abs(motion.x - motion.targetX) < 0.05
        && Math.abs(motion.width - motion.targetWidth) < 0.05
        && Math.abs(motion.velocity) < 0.6 && Math.abs(motion.widthVelocity) < 0.6);
      if (settled) {
        motion.x = motion.targetX;
        motion.width = motion.targetWidth;
        motion.velocity = motion.widthVelocity = 0;
        motion.last = 0;
      }
      paint();
      if (!settled) motion.frame = requestAnimationFrame(tick);
    }

    function schedule() {
      if (geometry && !motion.frame && !disposed) motion.frame = requestAnimationFrame(tick);
    }

    function target(destination, immediate = false, x = destination?.x) {
      lens.dataset.visible = String(!!destination);
      if (!destination || !geometry) {
        motion.velocity = motion.widthVelocity = 0;
        stop();
        paint();
        return;
      }
      motion.targetX = x;
      motion.targetWidth = destination.width;
      if (immediate || motion.reduced || !motion.ready) {
        stop();
        motion.x = x;
        motion.width = destination.width;
        motion.velocity = motion.widthVelocity = 0;
        motion.ready = true;
        paint();
      } else schedule();
    }

    function syncActive(immediate = false) {
      if (!gesture) target(geometry?.destinations.find(item => item.id === latest.current.activeId && !item.disabled), immediate);
    }

    function setPreview(id) {
      if (id === previewId) return;
      if (previewId) buttonsRef.current.get(previewId)?.removeAttribute('data-glass-preview');
      previewId = id;
      if (id) buttonsRef.current.get(id)?.setAttribute('data-glass-preview', 'true');
    }

    function setPress(pressed) {
      motion.press = pressed ? 1 : 0;
      nav.dataset.glassActive = String(pressed || hovered);
      schedule();
    }

    function light(event) {
      if (!geometry || motion.reduced) return;
      motion.lightX = clamp((event.clientX - geometry.rect.left) / geometry.rect.width * 100, 0, 100);
      motion.lightY = clamp((event.clientY - geometry.rect.top) / geometry.rect.height * 100, 0, 100);
      schedule();
    }

    function endGesture(restore = true) {
      const previous = gesture;
      gesture = null;
      nav.dataset.glassDragging = 'false';
      setPreview(null);
      setPress(false);
      if (previous && nav.hasPointerCapture?.(previous.pointerId)) nav.releasePointerCapture(previous.pointerId);
      if (restore) syncActive();
      return previous;
    }

    function cancel() {
      if (gesture) suppressClickUntil = performance.now() + 600;
      endGesture();
    }

    function measure() {
      const rect = nav.getBoundingClientRect();
      if (!rect.width || !rect.height) {
        cancel();
        geometry = null;
        stop();
        return;
      }
      // Grid tracks, unlike transformed button rectangles, stay exact during hover/press effects.
      const style = getComputedStyle(nav);
      const borderLeft = parseFloat(style.borderLeftWidth) || 0;
      const borderRight = parseFloat(style.borderRightWidth) || 0;
      const paddingLeft = parseFloat(style.paddingLeft) || 0;
      const paddingRight = parseFloat(style.paddingRight) || 0;
      const gap = parseFloat(style.columnGap) || 0;
      const count = latest.current.items.length;
      const width = count ? (rect.width - borderLeft - borderRight - paddingLeft - paddingRight - gap * (count - 1)) / count : 0;
      geometry = { rect, origin: rect.left + borderLeft, innerWidth: rect.width - borderLeft - borderRight, destinations: latest.current.items.map((item, index) => ({
        id: item.id, disabled: item.disabled, x: paddingLeft + index * (width + gap), width,
      })) };
      if (gesture) cancel();
      syncActive(true);
    }

    const controller = {
      syncActive() { if (gesture) cancel(); else syncActive(); },
      down(event) {
        if (!geometry || !event.isPrimary || event.button !== 0 || gesture) return;
        const button = event.target.closest('button[data-glass-destination]');
        if (!button || button.disabled) return;
        suppressClickUntil = 0;
        gesture = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, dragging: false };
        setPress(true);
        light(event);
      },
      move(event) {
        light(event);
        if (!gesture || event.pointerId !== gesture.pointerId || !geometry) return;
        if (!gesture.dragging) {
          const intent = dragIntent(gesture.startX, gesture.startY, event.clientX, event.clientY);
          if (intent === 'scroll') { cancel(); return; }
          if (intent !== 'scrub') return;
          gesture.dragging = true;
          nav.dataset.glassDragging = 'true';
          nav.setPointerCapture?.(event.pointerId);
        }
        event.preventDefault();
        const x = event.clientX - geometry.origin;
        const destination = nearestDestination(geometry.destinations, x);
        if (!destination) return;
        const enabled = geometry.destinations.filter(item => !item.disabled);
        const first = enabled[0];
        const last = enabled[enabled.length - 1];
        setPreview(destination.id);
        target(destination, false, clamp(x - destination.width / 2, first.x, last.x));
      },
      up(event) {
        if (!gesture || event.pointerId !== gesture.pointerId) return;
        const wasDrag = gesture.dragging;
        const destination = wasDrag && geometry && insideDock(geometry.rect, event.clientX, event.clientY)
          ? nearestDestination(geometry.destinations, event.clientX - geometry.origin) : null;
        if (wasDrag) { event.preventDefault(); suppressClickUntil = performance.now() + 600; }
        endGesture(!destination);
        if (destination) {
          target(destination);
          const button = buttonsRef.current.get(destination.id);
          // Keep the actual button as the event target, including the Profile-menu focus return.
          button?.focus({ preventScroll: true });
          button?.click();
          if (destination.id === 'menu') syncActive();
        }
      },
      cancel(event) { if (gesture && event.pointerId === gesture.pointerId) cancel(); },
      enter(event) {
        hovered = event.pointerType === 'mouse';
        nav.dataset.glassActive = String(hovered || !!gesture);
        light(event);
      },
      leave() {
        hovered = false;
        nav.dataset.glassActive = String(!!gesture);
        if (!gesture) { motion.lightX = 50; motion.lightY = 15; schedule(); }
      },
      clickCapture(event) {
        if (event.detail > 0 && performance.now() < suppressClickUntil) {
          suppressClickUntil = 0;
          event.preventDefault();
          event.stopPropagation();
        }
      },
    };
    controllerRef.current = controller;
    function releaseOutside(event) {
      if (gesture && event.pointerId === gesture.pointerId && geometry && !insideDock(geometry.rect, event.clientX, event.clientY)) cancel();
    }
    function preferenceChanged() {
      motion.reduced = preference.matches;
      if (motion.reduced) {
        motion.lightX = 50;
        motion.lightY = 15;
        target(geometry?.destinations.find(item => item.id === latest.current.activeId && !item.disabled), true);
      }
    }
    const observer = new ResizeObserver(measure);
    observer.observe(nav);
    window.addEventListener('resize', measure);
    window.addEventListener('pointerup', releaseOutside);
    window.addEventListener('pointercancel', controller.cancel);
    window.addEventListener('blur', cancel);
    preference.addEventListener('change', preferenceChanged);
    measure();
    return () => {
      disposed = true;
      endGesture(false);
      stop();
      observer.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('pointerup', releaseOutside);
      window.removeEventListener('pointercancel', controller.cancel);
      window.removeEventListener('blur', cancel);
      preference.removeEventListener('change', preferenceChanged);
      controllerRef.current = {};
    };
  }, [destinationKey]);

  useLayoutEffect(() => { controllerRef.current.syncActive?.(); }, [activeId, destinationKey]);

  return <nav ref={navRef} className="mobile-bottom-nav liquid-glass-nav lg:hidden"
    aria-label="Primary mobile navigation" data-pwa={isPwaInstalled ? 'true' : 'false'}
    data-glass-active="false" data-glass-dragging="false" style={{ '--nav-count': items.length }}
    onPointerDown={event => controllerRef.current.down?.(event)}
    onPointerMove={event => controllerRef.current.move?.(event)}
    onPointerUp={event => controllerRef.current.up?.(event)}
    onPointerCancel={event => controllerRef.current.cancel?.(event)}
    onLostPointerCapture={event => controllerRef.current.cancel?.(event)}
    onPointerEnter={event => controllerRef.current.enter?.(event)}
    onPointerLeave={() => controllerRef.current.leave?.()}
    onClickCapture={event => controllerRef.current.clickCapture?.(event)}>
    <span className="liquid-glass-nav__surface" aria-hidden="true" />
    <span className="liquid-glass-nav__rim" aria-hidden="true" />
    <span className="liquid-glass-nav__sheen" aria-hidden="true" />
    <span ref={lensRef} className="mobile-bottom-nav-indicator liquid-glass-nav__lens" data-visible="false" aria-hidden="true" />
    {items.map(item => {
      const Icon = item.icon;
      const active = item.id === activeId && item.id !== 'menu';
      return <button key={item.id} ref={node => { if (node) buttonsRef.current.set(item.id, node); else buttonsRef.current.delete(item.id); }}
        type="button" className={`mobile-bottom-nav-item${active ? ' mobile-bottom-nav-item-active' : ''}`}
        data-glass-destination={item.id} disabled={item.disabled}
        aria-label={item.label} aria-current={active ? 'page' : undefined}
        aria-haspopup={item.id === 'menu' ? 'dialog' : undefined}
        aria-controls={item.id === 'menu' ? 'mobile-navigation' : undefined}
        aria-expanded={item.id === 'menu' ? menuOpen : undefined}
        onClick={event => latest.current.onSelect(item, event)}>
        {item.id === 'profile' ? <span className="mobile-bottom-nav-icon" aria-hidden="true"><span className="mobile-bottom-nav-avatar">
          {item.avatarUrl && item.avatarUrl !== failedAvatar
            ? <img src={item.avatarUrl} alt="" draggable="false" onError={() => setFailedAvatar(item.avatarUrl)} />
            : item.initials || 'Me'}
        </span></span> : <span className="mobile-bottom-nav-icon" aria-hidden="true">{Icon && <Icon size={20} />}</span>}
        <span className="mobile-bottom-nav-label" aria-hidden="true">{item.label}</span>
      </button>;
    })}
  </nav>;
}
