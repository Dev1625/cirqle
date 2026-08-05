import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  CalendarDays,
  FileText,
  LayoutDashboard,
  MessageSquareText,
  Network,
  Plus,
  Search,
  Settings,
  UserRoundSearch,
} from 'lucide-react';
import { useLocation, useNavigate } from 'react-router';

import { COMPOSE_EVENT } from '../hooks/useKeyboardShortcuts';
import {
  filterPaletteCommands,
  moveActiveIndex,
  type PaletteCommand,
} from '../lib/commandPalette';
import { Dialog } from './ui/Dialog';

type ExecutableCommand = PaletteCommand & {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  run: () => void;
};

function clickWhenAvailable(selector: string, timeoutMs = 2_500) {
  const startedAt = performance.now();
  const tryClick = () => {
    const target = document.querySelector<HTMLElement>(selector);
    if (target) {
      target.click();
      target.focus();
      return;
    }
    if (performance.now() - startedAt < timeoutMs) {
      window.requestAnimationFrame(tryClick);
    }
  };
  window.requestAnimationFrame(tryClick);
}

export function CommandPalette({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const onContactRecord = /^\/app\/directory\/[^/]+$/.test(location.pathname);

  const commands = useMemo<ExecutableCommand[]>(
    () => [
      {
        id: 'new-contact',
        label: 'Create a contact',
        description: 'Open a blank contact record in Directory',
        category: 'Action',
        keywords: ['add', 'person', 'directory'],
        icon: Plus,
        run: () => {
          navigate('/app/directory');
          clickWhenAvailable('.tour-add-contact-btn');
        },
      },
      {
        id: 'log-meeting',
        label: 'Log a meeting',
        description: onContactRecord
          ? 'Open the meeting log for this contact'
          : 'Choose a contact, then open their meeting log',
        category: 'Action',
        keywords: ['interaction', 'note', 'follow up'],
        icon: CalendarDays,
        run: () => {
          if (onContactRecord) {
            clickWhenAvailable('#contact-tab-meeting');
          } else {
            navigate('/app/directory');
          }
        },
      },
      {
        id: 'compose-outreach',
        label: 'Compose outreach',
        description: onContactRecord
          ? 'Draft a message to this contact'
          : 'Choose a contact to draft a message',
        category: 'Action',
        keywords: ['email', 'message', 'write'],
        icon: MessageSquareText,
        run: () => {
          if (onContactRecord) {
            window.dispatchEvent(new CustomEvent(COMPOSE_EVENT));
          } else {
            navigate('/app/directory');
          }
        },
      },
      {
        id: 'dashboard',
        label: 'Dashboard',
        description: 'Open priorities and relationship signals',
        category: 'Navigate',
        icon: LayoutDashboard,
        run: () => navigate('/app'),
      },
      {
        id: 'directory',
        label: 'Directory',
        description: 'Browse and search contacts',
        category: 'Navigate',
        icon: UserRoundSearch,
        run: () => navigate('/app/directory'),
      },
      {
        id: 'graph',
        label: 'Network graph',
        description: 'Explore the shape of your network',
        category: 'Navigate',
        icon: Network,
        run: () => navigate('/app/graph'),
      },
      {
        id: 'tracker',
        label: 'Tracker',
        description: 'Open the outreach pipeline',
        category: 'Navigate',
        icon: FileText,
        run: () => navigate('/app/tracker'),
      },
      {
        id: 'calendar',
        label: 'Calendar',
        description: 'Review planned follow-ups',
        category: 'Navigate',
        icon: CalendarDays,
        run: () => navigate('/app/calendar'),
      },
      {
        id: 'templates',
        label: 'Templates',
        description: 'Manage reusable outreach',
        category: 'Navigate',
        icon: FileText,
        run: () => navigate('/app/templates'),
      },
      {
        id: 'settings',
        label: 'Settings',
        description: 'Manage profile, connections, usage, and security',
        category: 'Navigate',
        icon: Settings,
        run: () => navigate('/app/settings'),
      },
    ],
    [navigate, onContactRecord],
  );

  const filtered = useMemo(
    () => filterPaletteCommands(commands, query) as ExecutableCommand[],
    [commands, query],
  );

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIndex(0);
  }, [open]);

  useEffect(() => {
    if (activeIndex >= filtered.length) setActiveIndex(0);
  }, [activeIndex, filtered.length]);

  const runCommand = (command: ExecutableCommand) => {
    onClose();
    window.requestAnimationFrame(command.run);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Command menu"
      description="Search navigation and common Cirqle actions."
      initialFocusRef={inputRef}
      className="max-w-xl overflow-hidden bg-white"
    >
      <div className="border-b border-ink/15 p-4">
        <div className="flex items-center gap-3">
          <Search size={17} className="shrink-0 text-muted" aria-hidden="true" />
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActiveIndex((current) =>
                  moveActiveIndex(current, 1, filtered.length),
                );
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActiveIndex((current) =>
                  moveActiveIndex(current, -1, filtered.length),
                );
              } else if (event.key === 'Enter' && filtered[activeIndex]) {
                event.preventDefault();
                runCommand(filtered[activeIndex]);
              }
            }}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={
              filtered[activeIndex]
                ? `${listId}-${filtered[activeIndex].id}`
                : undefined
            }
            aria-autocomplete="list"
            autoComplete="off"
            placeholder="Search actions and pages"
            className="h-11 min-w-0 flex-1 bg-transparent font-mono text-base text-ink outline-none placeholder:text-muted"
          />
          <kbd className="hidden border border-ink/20 bg-paper px-2 py-1 font-mono text-[10px] text-muted sm:block">
            Esc
          </kbd>
        </div>
      </div>

      <div
        id={listId}
        role="listbox"
        aria-label="Commands"
        className="max-h-[min(60vh,28rem)] overflow-y-auto p-2"
      >
        {filtered.length === 0 ? (
          <p role="status" className="px-4 py-10 text-center font-mono text-xs text-muted">
            No matching command. Try a page name or an action like “create.”
          </p>
        ) : (
          filtered.map((command, index) => {
            const Icon = command.icon;
            const active = index === activeIndex;
            return (
              <button
                key={command.id}
                id={`${listId}-${command.id}`}
                type="button"
                role="option"
                aria-selected={active}
                onMouseMove={() => setActiveIndex(index)}
                onClick={() => runCommand(command)}
                className={`flex min-h-14 w-full items-center gap-3 rounded-card px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${
                  active ? 'bg-ink text-paper' : 'text-ink hover:bg-paper'
                }`}
              >
                <Icon
                  size={16}
                  className={active ? 'text-paper' : 'text-brand'}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1">
                  <span className="block font-mono text-xs font-bold uppercase tracking-widest">
                    {command.label}
                  </span>
                  <span
                    className={`mt-0.5 block font-mono text-[11px] leading-snug ${
                      active ? 'text-paper' : 'text-muted'
                    }`}
                  >
                    {command.description}
                  </span>
                </span>
                <span
                  className={`font-mono text-[9px] uppercase tracking-widest ${
                    active ? 'text-paper' : 'text-muted'
                  }`}
                >
                  {command.category}
                </span>
              </button>
            );
          })
        )}
      </div>

      <div className="flex flex-wrap gap-x-5 gap-y-1 border-t border-ink/15 bg-paper/70 px-4 py-3 font-mono text-[10px] uppercase tracking-widest text-muted">
        <span>
          <kbd>↑↓</kbd> move
        </span>
        <span>
          <kbd>Enter</kbd> open
        </span>
        <span>
          <kbd>Esc</kbd> close
        </span>
      </div>
    </Dialog>
  );
}
