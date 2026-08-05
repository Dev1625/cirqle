import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Outlet, Link, useLocation, Navigate, useNavigate, useSearchParams } from 'react-router';
import { motion } from 'motion/react';
import { useAuth } from '../contexts/AuthContext';
import {
  CheckCircle2,
  Command,
  HelpCircle,
  LogOut,
  Menu,
  PanelLeftClose,
  PlayCircle,
  X,
} from 'lucide-react';
import { auth, db } from '../config/firebase';
import { doc, getDoc } from 'firebase/firestore';
import { Logo } from '../components/Logo';
import { GlobalSearch } from '../components/GlobalNLSearch';
import { useTour, TOURS } from '../contexts/TourContext';
import { COMPOSE_EVENT, ESCAPE_EVENT, useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { Dialog } from '../components/ui/Dialog';
import { CommandPalette } from '../components/CommandPalette';
import { VoiceEnrichmentCenter } from '../components/voice/VoiceEnrichmentCenter';
import { AccountSecurityPanel } from '../components/settings/AccountSecurityPanel';
import { ensureVerifiedUserProfile } from '../lib/userBootstrap';
import { registerCurrentSession } from '../lib/sessionRegistry';
import { clearAllDashboardBriefCaches } from '../lib/dashboardBriefCache';

function routeLabel(pathname: string): string {
  if (/^\/app\/directory\/[^/]+$/.test(pathname)) return 'Contact details';
  return (
    {
      '/app': 'Dashboard',
      '/app/directory': 'Directory',
      '/app/graph': 'Network graph',
      '/app/tracker': 'Tracker',
      '/app/calendar': 'Calendar',
      '/app/templates': 'Templates',
      '/app/settings': 'Settings',
    }[pathname] || 'Cirqle'
  );
}

const AppLayout = () => {
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const trackerMode = searchParams.get('mode') || 'sheet';
  const showGlobalSearch = location.pathname !== '/app/graph';
  const currentRouteLabel = routeLabel(location.pathname);

  const [isInitializing, setIsInitializing] = useState(true);
  const [isDesktopLayout, setIsDesktopLayout] = useState(
    () => typeof window === 'undefined' || window.innerWidth >= 1100,
  );
  // Start collapsed on narrower viewports (tablet widths) so the fixed
  // 256px sidebar doesn't permanently eat a third of the content area.
  const [isSidebarOpen, setIsSidebarOpen] = useState(() => typeof window === 'undefined' || window.innerWidth >= 1100);
  const openNavigationRef = useRef<HTMLButtonElement>(null);
  const closeNavigationRef = useRef<HTMLButtonElement>(null);
  const navigationRef = useRef<HTMLElement>(null);
  useEffect(() => {
    let desktop = window.innerWidth >= 1100;
    const onResize = () => {
      const nextDesktop = window.innerWidth >= 1100;
      if (nextDesktop === desktop) return;
      desktop = nextDesktop;
      setIsDesktopLayout(nextDesktop);
      setIsSidebarOpen(nextDesktop);
    };
    window.addEventListener('resize', onResize, { passive: true });
    return () => window.removeEventListener('resize', onResize);
  }, []);


  // Help Menu State
  const [showHelpMenu, setShowHelpMenu] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const { startTour, completedTours } = useTour();

  useEffect(() => {
    document.title = `${currentRouteLabel} — Cirqle`;
  }, [currentRouteLabel]);

  useEffect(() => {
    let cancelled = false;

    const initUser = async () => {
      if (!user) {
        if (!cancelled) setIsInitializing(false);
        return;
      }

      try {
        // Remove credentials written by older builds. LiteLLM keys now remain
        // in server-only storage and never enter browser storage.
        localStorage.removeItem('CIRQLE_USER_PROXY_KEY');

        if (user.emailVerified) {
          await ensureVerifiedUserProfile(user);
        }

        // Provisioning is authenticated and idempotent. The browser never
        // receives or stores the resulting LiteLLM credential.
        if (user.emailVerified) {
          void registerCurrentSession(user.uid).catch(() => {
            console.warn('[session-registry] temporarily unavailable');
          });
          try {
            const token = await user.getIdToken();
            const response = await fetch('/api/register-user', {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
              },
            });
            if (!response.ok) {
              console.warn(`[ai-provisioning] request failed (${response.status})`);
            }
          } catch {
            // AI surfaces will show a recoverable, user-facing state. A
            // temporary gateway failure must not block the CRM itself.
            console.warn('[ai-provisioning] temporarily unavailable');
          }
        }
      } catch {
        console.warn('[workspace-bootstrap] temporarily unavailable');
      } finally {
        if (!cancelled) setIsInitializing(false);
      }
    };

    initUser();
    return () => {
      cancelled = true;
    };
  }, [user]);

  // `c` composes. On a contact record the page itself opens Draft Outreach;
  // anywhere else there is nobody to draft to yet, so send them to pick one.
  const onContactRecord = /^\/app\/directory\/[^/]+$/.test(location.pathname);
  const openHelp = useCallback(() => {
    setShowCommandPalette(false);
    setShowHelpMenu(true);
  }, []);
  const openCommandPalette = useCallback(() => {
    setShowHelpMenu(false);
    setShowCommandPalette(true);
  }, []);
  useKeyboardShortcuts({
    onCompose: () => {
      if (onContactRecord) window.dispatchEvent(new CustomEvent(COMPOSE_EVENT));
      else navigate('/app/directory');
    },
    onCommandPalette: openCommandPalette,
    onHelp: openHelp,
  });

  useEffect(() => {
    const onEscape = () => {
      setShowHelpMenu(false);
      setShowCommandPalette(false);
      if (window.innerWidth < 1100) setIsSidebarOpen(false);
    };
    window.addEventListener(ESCAPE_EVENT, onEscape);
    return () => window.removeEventListener(ESCAPE_EVENT, onEscape);
  }, []);

  const handleLogout = async () => {
    clearAllDashboardBriefCaches();
    await auth.signOut();
  };

  const openNavigation = () => {
    setIsSidebarOpen(true);
    window.requestAnimationFrame(() => closeNavigationRef.current?.focus());
  };

  const closeNavigation = (restoreFocus = true) => {
    setIsSidebarOpen(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => openNavigationRef.current?.focus());
    }
  };

  const closeNavigationAfterRoute = () => {
    if (window.innerWidth < 1100) closeNavigation(false);
  };

  const trapNavigationFocus = (event: React.KeyboardEvent<HTMLElement>) => {
    if (isDesktopLayout || event.key !== 'Tab' || !navigationRef.current) return;
    const focusable = Array.from(
      navigationRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => element.getClientRects().length > 0);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  if (!user) {
    return <Navigate to="/login" />;
  }

  if (isInitializing) {
    return (
      <div
        className="flex h-screen items-center justify-center bg-paper p-8 font-mono text-ink"
        role="status"
        aria-live="polite"
        aria-busy="true"
      >
        Synchronizing your secure workspace…
      </div>
    );
  }

  if (!user.emailVerified) {
    return (
      <div className="min-h-screen bg-paper text-ink">
        <header className="border-b border-ink/20 bg-rail px-5 py-4 sm:px-8">
          <div className="mx-auto flex max-w-4xl items-center justify-between gap-4">
            <Logo />
            <button
              type="button"
              onClick={handleLogout}
              className="inline-flex min-h-11 items-center gap-2 rounded-card px-3 font-mono text-xs font-bold uppercase tracking-widest text-muted transition-colors hover:bg-white/60 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            >
              <LogOut size={15} aria-hidden="true" />
              Log out
            </button>
          </div>
        </header>
        <main className="mx-auto max-w-4xl p-4 py-8 sm:p-8 sm:py-12">
          <div className="mb-6">
            <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-brand">
              One secure step left
            </p>
            <h1 className="mt-2 font-serif text-3xl font-bold italic sm:text-4xl">
              Confirm your email before Cirqle creates your workspace.
            </h1>
            <p className="mt-3 max-w-2xl font-mono text-xs leading-relaxed text-muted">
              No CRM profile, paid AI key, public card, or Google connection is
              created until the address is verified. You can resend the email,
              reset your password, or permanently delete this pending account
              below.
            </p>
          </div>
          <AccountSecurityPanel user={user} />
        </main>
      </div>
    );
  }

  const navItems = [
    { name: 'Dashboard', path: '/app', class: '' },
    { name: 'Directory', path: '/app/directory', class: 'tour-nav-directory' },
    { name: 'Network Graph', path: '/app/graph', class: 'tour-nav-graph' },
    { 
       name: 'Tracker', 
       path: '/app/tracker',
       class: 'tour-nav-tracker',
       subItems: [
         { name: 'Queue', query: '?mode=queue' },
         { name: 'Sheet', query: '?mode=sheet' },
         { name: 'Recruiting', query: '?mode=recruiting' },
         { name: 'Firm', query: '?mode=firm' },
         { name: 'Industry', query: '?mode=industry' },
         { name: 'Timeline', query: '?mode=calendar' }
       ]
    }, 
    { name: 'Calendar', path: '/app/calendar', class: '' },
    { name: 'Templates', path: '/app/templates', class: '' },
    { name: 'Settings', path: '/app/settings', class: '' },
  ];

  return (
    <div className="relative flex h-screen overflow-hidden bg-transparent">
      <a
        href="#main-content"
        className="fixed left-4 top-3 z-[120] -translate-y-20 rounded-card bg-ink px-4 py-3 font-mono text-xs font-bold uppercase tracking-widest text-paper transition-transform focus:translate-y-0"
      >
        Skip to main content
      </a>
      
      {/* Mobile / Collapsed Menu Hamburger.
          Carries an explicit label: below 1100px the sidebar starts collapsed,
          so this is the *only* route to navigation, and an icon-only button
          with no accessible name left screen-reader users on a phone with an
          unlabelled control and no way in. It never surfaced in a desktop
          audit because the button does not render at that width. */}
      {!isSidebarOpen && (
         <button
           ref={openNavigationRef}
           type="button"
           onClick={openNavigation}
           aria-label="Open primary navigation"
           aria-expanded="false"
           aria-controls="primary-navigation"
           className="fixed left-4 top-4 z-50 inline-flex min-h-11 min-w-11 items-center justify-center rounded-card border border-ink/25 bg-rail transition-colors hover:bg-ink hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-paper sm:left-6 sm:top-6"
         >
           <Menu size={20} aria-hidden="true" />
         </button>
      )}

      {/* Sidebar */}
      {isSidebarOpen && (
        <>
         <button
           type="button"
           aria-label="Close navigation"
           aria-hidden="true"
           tabIndex={-1}
           onClick={() => closeNavigation()}
           className="fixed inset-0 z-20 cursor-default bg-ink/35 min-[1100px]:hidden"
         />
         <aside
           ref={navigationRef}
           id="primary-navigation"
           role={isDesktopLayout ? 'complementary' : 'dialog'}
           aria-label="Primary navigation"
           aria-modal={isDesktopLayout ? undefined : true}
           onKeyDown={trapNavigationFocus}
           className="fixed inset-y-0 left-0 z-30 flex w-[min(20rem,calc(100vw-2rem))] flex-shrink-0 flex-col border-r border-ink/25 bg-rail p-6 shadow-float min-[1100px]:relative min-[1100px]:z-10 min-[1100px]:w-64 min-[1100px]:p-8 min-[1100px]:shadow-none"
         >
           {/* A <button>, not a <div onClick>. As a div this was unreachable by
               keyboard and invisible to assistive tech, so the sidebar could be
               opened but never closed without a mouse. */}
           <div className="flex items-start justify-between gap-4">
             <Logo />
             <button
               ref={closeNavigationRef}
               type="button"
               onClick={() => closeNavigation()}
               aria-label="Collapse primary navigation"
               aria-expanded="true"
               aria-controls="primary-navigation"
               className="-mr-2 -mt-2 inline-flex min-h-11 min-w-11 items-center justify-center rounded-card text-muted transition-colors hover:bg-ink hover:text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
             >
               <PanelLeftClose size={18} aria-hidden="true" />
             </button>
           </div>
           
           <nav aria-label="Primary" className="mt-6 min-h-0 flex-1 overflow-y-auto">
           <ul className="space-y-2">
             {navItems.map((item) => {
               const isActive = location.pathname === item.path;
               
               return (
                 <li key={item.path}>
                   <Link
                     to={item.path}
                     onClick={closeNavigationAfterRoute}
                     aria-current={isActive ? 'page' : undefined}
                     className={`group flex min-h-11 items-center gap-3 rounded-card px-2 transition-colors ${item.class} ${
                       isActive ? 'bg-white/70 text-brand' : 'text-muted hover:bg-white/45 hover:text-ink'
                     }`}
                   >
                     {/* Active state carries the accent rather than plain ink —
                         one more legitimate, restrained use of --color-brand. */}
                     <div aria-hidden="true" className={`w-2 h-2 transition-colors ${isActive ? 'bg-brand' : 'bg-transparent border border-current'}`}></div>
                     <span className="font-mono text-xs uppercase tracking-widest font-bold">{item.name}</span>
                   </Link>
                   
                   {/* Nested Tracker Items */}
                   {isActive && item.subItems && (
                      <ul className="mt-1 ml-5 space-y-1 border-l border-ink/20 pl-3" aria-label="Tracker views">
                         {item.subItems.map((sub) => {
                            const isSubActive = trackerMode === sub.query.replace('?mode=', '');
                            return (
                               <li key={sub.name}>
                                 <Link
                                    to={`${item.path}${sub.query}`}
                                    onClick={closeNavigationAfterRoute}
                                    aria-current={isSubActive ? 'page' : undefined}
                                    className={`flex min-h-11 items-center rounded-card px-2 transition-colors ${
                                       isSubActive ? 'text-brand' : 'text-muted hover:bg-white/45 hover:text-ink'
                                    }`}
                                 >
                                    <span className={`font-mono text-[10px] uppercase tracking-widest ${isSubActive ? 'font-bold' : ''}`}>
                                       {sub.name}
                                    </span>
                                 </Link>
                               </li>
                            );
                         })}
                      </ul>
                   )}
                 </li>
               );
             })}
           </ul>
           </nav>
           
           <div className="mt-4 space-y-1 border-t border-ink/20 pt-4">
             <button
               type="button"
               onClick={() => {
                 if (window.innerWidth < 1100) closeNavigation(false);
                 openCommandPalette();
               }}
               className="flex min-h-11 w-full items-center gap-3 rounded-card px-2 text-left font-mono text-xs font-bold uppercase tracking-widest text-muted transition-colors hover:bg-white/45 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
             >
               <Command size={15} aria-hidden="true" />
               Command menu
               <kbd className="ml-auto border border-ink/20 bg-paper px-1.5 py-0.5 text-[9px] text-muted">
                 Ctrl K
               </kbd>
             </button>
             <button
               type="button"
               onClick={() => {
                 if (window.innerWidth < 1100) closeNavigation(false);
                 openHelp();
               }}
               className="flex min-h-11 w-full items-center gap-3 rounded-card px-2 text-left font-mono text-xs font-bold uppercase tracking-widest text-muted transition-colors hover:bg-white/45 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
             >
               <HelpCircle size={15} aria-hidden="true" /> Help & Tours
             </button>
             <button
               type="button"
               onClick={handleLogout}
               className="flex min-h-11 w-full items-center gap-3 rounded-card px-2 text-left font-mono text-xs font-bold uppercase tracking-widest text-muted transition-colors hover:bg-white/45 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
             >
               <LogOut size={15} aria-hidden="true" /> Log Out
             </button>
           </div>
         </aside>
        </>
      )}

      {/* Main Content Area */}
      <div
        className="flex-1 relative flex flex-col overflow-hidden"
        inert={isSidebarOpen && !isDesktopLayout ? true : undefined}
      >
        <main
          id="main-content"
          tabIndex={-1}
          className="flex-1 overflow-auto bg-transparent outline-none"
        >
          <p className="sr-only" aria-live="polite" aria-atomic="true">
            {currentRouteLabel} loaded
          </p>
          {/* Keyed on the route so each view fades + slides in on navigation
              instead of snapping. Sub-route query changes (e.g. Tracker
              ?mode=) are intentionally excluded so in-page tab switches
              don't re-trigger a full page transition. */}
          <motion.div
            key={location.pathname}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            className={`mx-auto w-full max-w-6xl p-4 pb-8 sm:p-8 ${!isSidebarOpen ? 'pt-20 sm:pt-24' : ''}`}
          >
            <Suspense
              fallback={
                <div
                  className="flex items-center justify-center py-24 font-mono text-xs uppercase tracking-widest text-muted"
                  role="status"
                  aria-live="polite"
                  aria-busy="true"
                >
                  Loading…
                </div>
              }
            >
              <Outlet />
            </Suspense>
          </motion.div>
        </main>

        {/* Reserves real layout space (rather than floating over content) so
            scrollable content can never render underneath/behind it. */}
        {showGlobalSearch && (
          /* Same tinted tone as the sidebar: the two together read as one
             frame of chrome around the paper canvas, which is what lets the
             white cards on that canvas come forward. */
          <div className="tour-global-search z-40 flex shrink-0 justify-center border-t border-ink/25 bg-rail/95 px-4 py-3 backdrop-blur-sm sm:px-8 sm:py-4">
            <div className="w-full max-w-5xl">
              <GlobalSearch />
            </div>
          </div>
        )}
      </div>

      <Dialog
        open={showHelpMenu}
        onClose={() => setShowHelpMenu(false)}
        title="Guided Tours and Help"
        description="Run an interactive walkthrough or review Cirqle shortcuts and recent changes."
        className="max-w-2xl"
      >
            <div className="relative p-5 sm:p-8">
               <button
                 type="button"
                 onClick={() => setShowHelpMenu(false)}
                 className="absolute right-3 top-3 inline-flex min-h-11 min-w-11 items-center justify-center rounded-card text-muted transition-colors hover:bg-ink hover:text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand sm:right-5 sm:top-5"
                 aria-label="Close help"
               >
                 <X size={18} aria-hidden="true" />
               </button>
               <h2 className="mb-8 pr-12 font-serif text-3xl font-bold">Guided Tours & Help</h2>
               
               <div className="space-y-4 mb-12">
                  <h3 className="font-mono text-[10px] uppercase tracking-widest font-bold text-subtle border-b border-ink/20 pb-2 mb-4">Interactive Walkthroughs</h3>
                  {Object.entries(TOURS).map(([tourId, tourDef]) => {
                     const isDone = completedTours.includes(tourId);
                     return (
                        <div key={tourId} className="group flex flex-col items-stretch justify-between gap-3 border border-ink/20 bg-white p-4 transition-colors hover:border-ink sm:flex-row sm:items-center">
                           <div className="flex items-center gap-3">
                              {isDone ? (
                                <CheckCircle2 size={18} className="text-green-700" aria-hidden="true" />
                              ) : (
                                <PlayCircle size={18} className="text-subtle group-hover:text-ink" aria-hidden="true" />
                              )}
                              <div>
                                 <h4 className={`font-mono text-xs uppercase tracking-widest font-bold ${isDone ? 'text-muted' : 'text-ink'}`}>{tourDef.title}</h4>
                                 <p className="font-mono text-[10px] text-subtle mt-1">{tourDef.steps.length} step{tourDef.steps.length === 1 ? '' : 's'}</p>
                              </div>
                           </div>
                           <button
                             type="button"
                             onClick={() => {
                               setShowHelpMenu(false);
                               if (tourId === 'getting_started') navigate('/app');
                               if (tourId === 'adding_contact') navigate('/app/directory');
                               if (tourId === 'the_tracker') navigate('/app/tracker');
                               if (tourId === 'network_graph') navigate('/app/graph');
                               if (tourId === 'nl_search') navigate('/app');
                               if (tourId === 'drafting_outreach') navigate('/app/directory');
                               // TourContext waits for the destination selector; this just lets React commit navigation first.
                               setTimeout(() => {
                                  startTour(tourId);
                               }, 150);
                             }}
                             className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-card border border-ink/20 px-3 py-2 font-mono text-[10px] font-bold uppercase tracking-widest transition-colors hover:bg-ink hover:text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                           >
                             Run Tour
                           </button>
                        </div>
                     );
                  })}
               </div>

               <div className="space-y-6">
                  <h3 className="font-mono text-[10px] uppercase tracking-widest font-bold text-subtle border-b border-ink/20 pb-2 mb-4">What's New in Cirqle</h3>
                  <div className="border-l-2 border-brand pl-4 py-1">
                     <h4 className="font-serif text-lg font-bold">Your card, and everything it files back</h4>
                     <p className="font-mono text-xs mt-2 leading-relaxed text-subtle">Publish a tap-ready card page from Settings &rarr; Connections. When someone saves your contact, they land in your Directory automatically — with the event you were at already tagged. Preview the whole thing without any hardware.</p>
                     <p className="font-mono text-[10px] uppercase text-subtle mt-2">Just Now</p>
                  </div>
                  <div className="border-l-2 border-ink pl-4 py-1">
                     <h4 className="font-serif text-lg font-bold">Briefs, memos and commitments</h4>
                     <p className="font-mono text-xs mt-2 leading-relaxed text-subtle">The Dashboard now reads you in before a meeting, takes a voice memo after it, and pulls out anything you promised. Relationship health explains itself instead of showing a bare number, and can be pinned so the quarterly relationships stop nagging.</p>
                     <p className="font-mono text-[10px] uppercase text-subtle mt-2">Just Now</p>
                  </div>
                  <div className="border-l-2 border-ink pl-4 py-1">
                     <h4 className="font-serif text-lg font-bold">Keyboard shortcuts</h4>
                     <p className="font-mono text-xs mt-2 leading-relaxed text-subtle"><kbd className="font-bold">Ctrl K</kbd> opens the command menu, <kbd className="font-bold">/</kbd> focuses Ask AI, <kbd className="font-bold">c</kbd> starts a draft, <kbd className="font-bold">?</kbd> opens Help, and <kbd className="font-bold">Esc</kbd> closes the active layer.</p>
                     <p className="font-mono text-[10px] uppercase text-subtle mt-2">Just Now</p>
                  </div>
                  <div className="border-l-2 border-ink/20 pl-4 py-1">
                     <h4 className="font-serif text-lg font-bold text-muted">Interactive Guided Tours</h4>
                     <p className="font-mono text-xs mt-2 leading-relaxed text-muted">Interactive spotlights guide you through making an outreach or query. They remain available here whenever you want a refresher.</p>
                     <p className="font-mono text-[10px] uppercase text-muted mt-2">Earlier</p>
                  </div>
                  <div className="border-l-2 border-ink/20 pl-4 py-1">
                     <h4 className="font-serif text-lg font-bold text-muted">Enhanced Filtering in Tracker</h4>
                     <p className="font-mono text-xs mt-2 leading-relaxed text-muted">You can now stack firm filters, kanban modes, and natural language queue queries seamlessly.</p>
                     <p className="font-mono text-[10px] uppercase text-muted mt-2">Last Week</p>
                  </div>
               </div>
            </div>
      </Dialog>

      <CommandPalette
        open={showCommandPalette}
        onClose={() => setShowCommandPalette(false)}
      />
      {user && <VoiceEnrichmentCenter uid={user.uid} />}
    </div>
  );
};

export default AppLayout;
