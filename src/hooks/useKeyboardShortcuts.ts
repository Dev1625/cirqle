import { useEffect } from 'react';

/**
 * App-wide keyboard shortcuts.
 *
 *   /    focus the Ask-AI search bar
 *   c    compose / draft outreach
 *   Esc  close whatever is open
 *
 * Two rules that make the difference between a shortcut layer people use and
 * one they disable:
 *
 * 1. Never steal a key while the user is typing. Anything originating in an
 *    input, textarea or contenteditable is ignored outright — otherwise "c"
 *    vanishes mid-word in the notes field.
 * 2. Never swallow a modifier chord. Ctrl/Cmd/Alt combinations belong to the
 *    browser and the OS, and rebinding Cmd-C would be indefensible.
 *
 * `c` and `Esc` dispatch CustomEvents rather than calling into page state, so
 * any screen can opt in by listening and screens that do not care are
 * unaffected. Esc additionally stays handled locally by the modals that
 * already listen for it (ConfirmContext, VoiceMemo) — this is a supplement,
 * not a replacement.
 */

export const COMPOSE_EVENT = 'cirqle:compose';
export const ESCAPE_EVENT = 'cirqle:escape';

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
}

export function useKeyboardShortcuts(options: { onCompose?: () => void } = {}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      if (event.key === 'Escape') {
        // Deliberately not gated on isTypingTarget: Escape out of a field is
        // exactly when you most want the panel to close.
        window.dispatchEvent(new CustomEvent(ESCAPE_EVENT));
        return;
      }

      if (isTypingTarget(event.target)) return;

      if (event.key === '/') {
        const search = document.querySelector<HTMLInputElement>('[data-shortcut="global-search"]');
        if (search) {
          event.preventDefault();
          search.focus();
          search.select();
        }
        return;
      }

      if (event.key === 'c' || event.key === 'C') {
        event.preventDefault();
        if (options.onCompose) options.onCompose();
        else window.dispatchEvent(new CustomEvent(COMPOSE_EVENT));
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [options.onCompose]);
}

/** Convenience for pages that want to react to the global `c` shortcut. */
export function useComposeShortcut(handler: () => void) {
  useEffect(() => {
    const onCompose = () => handler();
    window.addEventListener(COMPOSE_EVENT, onCompose);
    return () => window.removeEventListener(COMPOSE_EVENT, onCompose);
  }, [handler]);
}
