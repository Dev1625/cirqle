import React, { createContext, useContext, useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { EVENTS, Joyride, STATUS, type EventHandler, type Placement, type Step } from 'react-joyride';
import { useLocation, useNavigate } from 'react-router-dom';
import { doc, getDoc, updateDoc } from 'firebase/firestore';
import { db } from '../config/firebase';
import { useAuth } from './AuthContext';

type TourContextType = {
  startTour: (tourId: string) => void;
  completedTours: string[];
  isTourRunning: boolean;
};

const TourContext = createContext<TourContextType>({
  startTour: () => {},
  completedTours: [],
  isTourRunning: false
});

/**
 * A step in one of Cirqle's guided tours.
 *
 * `route` is the important addition. Every tour but one points at elements
 * that only exist on a particular page, and previously it was the caller's
 * job to navigate there first — a hardcoded if-chain in AppLayout that had to
 * be kept in sync with this file by hand, and that only covered the tour's
 * *first* step. A tour that wanted to cross pages simply could not. Now each
 * step declares the route it lives on and the tour drives the router itself,
 * so a tour can be started from anywhere and can span as many pages as it
 * likes.
 */
type TourStep = {
  target: string;
  content: string;
  placement?: Placement | 'auto' | 'center';
  /** Route the target lives on. Omitted for steps that are page-agnostic. */
  route?: string;
};

export const TOURS: Record<string, { title: string; steps: TourStep[] }> = {
  getting_started: {
    title: 'Getting Started',
    steps: [
      {
        target: 'body',
        content: 'Welcome to Cirqle. Let us show you around your new intelligent CRM.',
        placement: 'center',
        route: '/app',
      },
      {
        target: '.tour-nav-directory',
        content: 'Your Directory is where you store all your contacts. The AI will structure notes you dump in here automatically.',
        placement: 'right',
      },
      {
        target: '.tour-nav-tracker',
        content: 'The Tracker rolls up every interaction and flags pending action items.',
        placement: 'right',
      },
      {
        target: '.tour-nav-graph',
        content: 'The Graph helps you visualize your network connections and identify gap opportunities.',
        placement: 'right',
      },
      {
        target: '.tour-global-search',
        content: 'And this is the bar you will use most: ask a question in plain English and Cirqle answers it against your whole directory.',
        placement: 'top',
        route: '/app',
      }
    ]
  },
  adding_contact: {
    title: 'Adding a Contact',
    steps: [
      {
        target: '.tour-add-contact-btn',
        content: 'Click here to add a contact. From there, you can paste messy notes for AI parsing or enter the details manually.',
        placement: 'bottom',
        route: '/app/directory',
      },
      {
        target: '.tour-csv-btn',
        content: 'Upload your entire LinkedIn connections CSV file to bootstrap your network instantly.',
        placement: 'bottom',
        route: '/app/directory',
      },
      {
        target: '.tour-directory-list',
        content: 'Every saved contact appears here. Open a contact to add notes, draft outreach, or track replies.',
        // The list can be taller than the viewport; anchoring to its edge
        // pushes the tooltip off-screen. The spotlight still marks it.
        placement: 'center',
        route: '/app/directory',
      }
    ]
  },
  drafting_outreach: {
    title: 'Drafting an Outreach',
    steps: [
      {
        target: '.tour-directory-list',
        content: 'Start from the Directory and open the contact you want to reach out to.',
        placement: 'center',
        route: '/app/directory',
      },
      {
        target: '.tour-add-contact-btn',
        content: 'If the person is not in Cirqle yet, add them first. Contact profiles include AI drafting and reply tracking once opened.',
        placement: 'bottom',
        route: '/app/directory',
      },
      {
        target: '.tour-tracker-sheet',
        content: 'Once a draft goes out it lands here in the Tracker, where you can watch for the reply and log what happened.',
        placement: 'center',
        route: '/app/tracker',
      }
    ]
  },
  the_tracker: {
    title: 'The Tracker',
    steps: [
      {
        target: '.tour-tracker-sheet',
        content: 'The Sheet view acts as your central command. Click into any record to view details.',
        // The sheet fills the viewport, so an edge-anchored tooltip lands
        // half off-screen behind the toolbar.
        placement: 'center',
        route: '/app/tracker',
      },
      {
        target: '.tour-filter-btn',
        content: 'Open the filters panel to slice your pipeline by Firm, Industry, or stage.',
        placement: 'bottom',
        route: '/app/tracker',
      },
      {
        target: '.tour-tracker-modes',
        content: 'Switch between grouped firm views or time-based queue views.',
        placement: 'bottom',
        route: '/app/tracker',
      }
    ]
  },
  network_graph: {
    title: 'Network Graph',
    steps: [
      {
        target: '.tour-graph-detail-toggle',
        content: 'Turn on Detail Overlay when you want relationship signal encoded into contact size and outline strength.',
        placement: 'bottom',
        route: '/app/graph',
      },
      {
        target: '.tour-graph-clusters',
        content: 'Use these industry chips to isolate one lane at a time without changing the graph layout.',
        placement: 'top',
        route: '/app/graph',
      },
      {
        target: '.tour-graph-node',
        content: 'Pan, zoom, click, or drag nodes here. Zoom only moves the camera, so the graph stays settled instead of rebouncing.',
        placement: 'top',
        route: '/app/graph',
      }
    ]
  },
  nl_search: {
    title: 'Natural Language Search',
    steps: [
      {
        target: '.tour-global-search',
        content: 'Ask any question like "Who do I know in NY?" or "List my pending action items".',
        placement: 'top',
        route: '/app',
      }
    ]
  }
};

/** Polls for a selector, because route chunks are lazy and mount async. */
function waitForSelector(selector: string, timeoutMs = 6000): Promise<void> {
  if (selector === 'body' || document.querySelector(selector)) return Promise.resolve();

  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      // Resolve either way on timeout: Joyride's own TARGET_NOT_FOUND handling
      // is a better failure mode than hanging the tour forever.
      if (document.querySelector(selector) || Date.now() > deadline) {
        resolve();
        return;
      }
      window.setTimeout(tick, 60);
    };
    tick();
  });
}

export const TourProvider = ({ children }: { children: React.ReactNode }) => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [completedTours, setCompletedTours] = useState<string[]>([]);
  const [run, setRun] = useState(false);
  const [activeTour, setActiveTour] = useState<string | null>(null);
  const [hasBootstrapped, setHasBootstrapped] = useState(false);

  // `before` hooks are captured in a memo that must not re-run on every
  // navigation (re-creating the steps array restarts the tour), so routing is
  // reached through refs rather than closed-over values.
  const navigateRef = useRef(navigate);
  const pathnameRef = useRef(location.pathname);
  navigateRef.current = navigate;
  pathnameRef.current = location.pathname;

  // Guards the completion write, which several events can otherwise trigger.
  const settledRef = useRef(false);

  useEffect(() => {
    if (!user) {
      setCompletedTours([]);
      setRun(false);
      setActiveTour(null);
      setHasBootstrapped(false);
      return;
    }

    let cancelled = false;
    const loadState = async () => {
      const userRef = doc(db, 'users', user.uid);
      const snap = await getDoc(userRef);

      if (snap.exists() && !cancelled) {
        const data = snap.data();
        const done = data.completedTours || [];
        setCompletedTours(done);

        const hasSeenInitialTour = Boolean(data.hasSeenInitialTour);
        if (!hasSeenInitialTour) {
          await updateDoc(userRef, { hasSeenInitialTour: true });

          if (!done.includes('getting_started') && !cancelled) {
            window.setTimeout(() => startTour('getting_started'), 800);
          }
        }
      }

      if (!cancelled) setHasBootstrapped(true);
    };
    loadState();
    return () => { cancelled = true; };
  }, [user]);

  const startTour = useCallback((tourId: string) => {
    if (!TOURS[tourId]) return;
    settledRef.current = false;
    // Remount Joyride cleanly if a tour is already up, otherwise it keeps the
    // previous tour's step index.
    setRun(false);
    setActiveTour(null);
    window.setTimeout(() => {
      setActiveTour(tourId);
      setRun(true);
    }, 0);
  }, []);

  /**
   * Steps for the running tour, with each step's `before` hook responsible for
   * getting the app to the page that step's target lives on and waiting for it
   * to mount. Joyride awaits these hooks and shows its loader meanwhile, which
   * is exactly the behaviour a cross-page tour needs.
   */
  const steps = useMemo<Step[]>(() => {
    const tour = activeTour ? TOURS[activeTour] : null;
    if (!tour) return [];

    return tour.steps.map((step) => ({
      target: step.target,
      content: step.content,
      placement: step.placement,
      before: async () => {
        if (step.route && pathnameRef.current !== step.route) {
          navigateRef.current(step.route);
        }
        await waitForSelector(step.target);
      },
    }));
  }, [activeTour]);

  const finish = useCallback(async () => {
    if (settledRef.current) return;
    settledRef.current = true;
    setRun(false);

    const finishedTour = activeTour;
    setActiveTour(null);

    if (finishedTour && user) {
      const newCompleted = Array.from(new Set([...completedTours, finishedTour]));
      setCompletedTours(newCompleted);
      try {
        await updateDoc(doc(db, 'users', user.uid), { completedTours: newCompleted });
      } catch (err) {
        // A tour finishing is not worth surfacing an error over; the next
        // load simply won't show it as completed.
        console.warn('Could not record tour completion', err);
      }
    }
  }, [activeTour, completedTours, user]);

  const handleEvent = useCallback<EventHandler>((data) => {
    if (data.type === EVENTS.TARGET_NOT_FOUND) {
      console.warn(`[Cirqle tours] step ${data.index} target not found:`, data.step?.target);
    }

    if (data.status === STATUS.FINISHED || data.status === STATUS.SKIPPED) {
      void finish();
    }
  }, [finish]);

  return (
    <TourContext.Provider value={{ startTour, completedTours, isTourRunning: run }}>
      {hasBootstrapped && activeTour && TOURS[activeTour] && (
        <Joyride
          key={activeTour}
          steps={steps}
          run={run}
          continuous
          onEvent={handleEvent}
          options={{
            primaryColor: '#7A2331',
            // Above the app's own layers: the help modal sits at z-50 and the
            // global search rail at z-40.
            zIndex: 1000,
            showProgress: true,
            // Tours here are launched deliberately from the Help menu, so the
            // extra "click this pulsing dot first" hop is pure friction.
            skipBeacon: true,
            scrollOffset: 120,
            spotlightPadding: 8,
            spotlightRadius: 7,
            // Lazy route chunks plus a Firestore round trip: give targets real
            // time to appear before declaring them missing.
            targetWaitTimeout: 6000,
            beforeTimeout: 12000,
            buttons: ['back', 'close', 'skip', 'primary'],
            closeButtonAction: 'skip',
            // The overlay covers the whole screen during every step; closing
            // the tour on a stray click there was too easy to do by accident.
            overlayClickAction: false,
          }}
          locale={{
            last: 'Done',
            skip: 'Skip',
            nextWithProgress: 'Next ({current}/{total})',
          }}
          styles={{
            tooltip: {
              borderRadius: '7px',
              fontFamily: 'Inconsolata, ui-monospace, monospace',
            },
            tooltipContent: {
              fontFamily: 'Inconsolata, ui-monospace, monospace',
              fontSize: '14px',
              lineHeight: '1.5',
              color: '#1A1A1A',
            },
            buttonPrimary: {
              backgroundColor: '#1A1A1A',
              color: '#F5F0E8',
              fontFamily: 'Inconsolata, ui-monospace, monospace',
              fontSize: '12px',
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
              fontWeight: 'bold',
              borderRadius: '7px',
            },
            buttonBack: {
              color: '#1A1A1A',
              fontFamily: 'Inconsolata, ui-monospace, monospace',
              fontSize: '12px',
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
              marginRight: '1rem',
            },
            buttonSkip: {
              color: '#7A2331',
              fontFamily: 'Inconsolata, ui-monospace, monospace',
              fontSize: '12px',
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
            },
          }}
        />
      )}
      {children}
    </TourContext.Provider>
  );
};

export const useTour = () => useContext(TourContext);
