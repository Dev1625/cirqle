import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import { ACTIONS, EVENTS, Joyride, STATUS } from 'react-joyride';
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

export const TOURS: Record<string, { title: string, steps: any[] }> = {
  getting_started: {
    title: 'Getting Started',
    steps: [
      {
        target: 'body',
        content: 'Welcome to Cirqle. Let us show you around your new intelligent CRM.',
        placement: 'center',
        disableBeacon: true,
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
        disableBeacon: true,
      },
      {
        target: '.tour-csv-btn',
        content: 'Upload your entire LinkedIn connections CSV file to bootstrap your network instantly.',
        placement: 'bottom',
      },
      {
        target: '.tour-directory-list',
        content: 'Every saved contact appears here. Open a contact to add notes, draft outreach, or track replies.',
        placement: 'top',
      }
    ]
  },
  drafting_outreach: {
    title: 'Drafting an Outreach',
    steps: [
      {
        target: '.tour-directory-list',
        content: 'Start from the Directory and open the contact you want to reach out to.',
        placement: 'top',
        disableBeacon: true,
      },
      {
        target: '.tour-add-contact-btn',
        content: 'If the person is not in Cirqle yet, add them first. Contact profiles include AI drafting and reply tracking once opened.',
        placement: 'bottom',
      }
    ]
  },
  the_tracker: {
    title: 'The Tracker',
    steps: [
      {
        target: '.tour-tracker-sheet',
        content: 'The Sheet view acts as your central command. Click into any record to view details.',
        placement: 'bottom',
        disableBeacon: true,
      },
      {
        target: '.tour-filter-btn',
        content: 'Open the filters panel to slice your pipeline by Firm, Industry, or stage.',
        placement: 'bottom',
      },
      {
        target: '.tour-tracker-modes',
        content: 'Switch between grouped firm views or time-based queue views.',
        placement: 'bottom'
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
        disableBeacon: true,
      },
      {
        target: '.tour-graph-clusters',
        content: 'Use these industry chips to isolate one lane at a time without changing the graph layout.',
        placement: 'top',
      },
      {
        target: '.tour-graph-node',
        content: 'Pan, zoom, click, or drag nodes here. Zoom only moves the camera, so the graph stays settled instead of rebouncing.',
        placement: 'bottom',
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
        disableBeacon: true,
      }
    ]
  }
};

export const TourProvider = ({ children }: { children: React.ReactNode }) => {
  const { user } = useAuth();
  const [completedTours, setCompletedTours] = useState<string[]>([]);
  const [run, setRun] = useState(false);
  const [activeTour, setActiveTour] = useState<string | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [hasBootstrapped, setHasBootstrapped] = useState(false);
  const startTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!user) {
      setCompletedTours([]);
      setRun(false);
      setActiveTour(null);
      setStepIndex(0);
      setHasBootstrapped(false);
      if (startTimerRef.current) {
        window.clearTimeout(startTimerRef.current);
        startTimerRef.current = null;
      }
      return;
    }

    const loadState = async () => {
      const userRef = doc(db, 'users', user.uid);
      const snap = await getDoc(userRef);

      if (snap.exists()) {
        const data = snap.data();
        const done = data.completedTours || [];
        setCompletedTours(done);

        const hasSeenInitialTour = Boolean(data.hasSeenInitialTour);
        if (!hasSeenInitialTour) {
          await updateDoc(userRef, {
            hasSeenInitialTour: true
          });

          if (!done.includes('getting_started')) {
            window.setTimeout(() => startTour('getting_started'), 1000);
          }
        }
      }

      setHasBootstrapped(true);
    };
    loadState();
  }, [user]);

  useEffect(() => () => {
    if (startTimerRef.current) {
      window.clearTimeout(startTimerRef.current);
    }
  }, []);

  const startTour = (tourId: string) => {
    const tour = TOURS[tourId];
    if (!tour) return;

    if (startTimerRef.current) {
      window.clearTimeout(startTimerRef.current);
      startTimerRef.current = null;
    }

    setActiveTour(tourId);
    setStepIndex(0);
    setRun(false);

    const firstAnchoredStep = tour.steps.find((step) => typeof step.target === 'string' && step.target !== 'body');
    const firstTarget = firstAnchoredStep?.target as string | undefined;
    let attempts = 0;

    const launchWhenReady = () => {
      const targetReady = !firstTarget || Boolean(document.querySelector(firstTarget));
      const shouldGiveUpWaiting = attempts >= 30;

      if (targetReady || shouldGiveUpWaiting) {
        startTimerRef.current = null;
        setRun(true);
        return;
      }

      attempts += 1;
      startTimerRef.current = window.setTimeout(launchWhenReady, 100);
    };

    startTimerRef.current = window.setTimeout(launchWhenReady, 100);
  };

  const handleJoyrideCallback = async (data: any) => {
    const { action, index, status, type } = data;
    const finishedStatuses: string[] = [STATUS.FINISHED, STATUS.SKIPPED];

    if (finishedStatuses.includes(status)) {
      setRun(false);
      if (activeTour && user) {
        const newCompleted = Array.from(new Set([...completedTours, activeTour]));
        setCompletedTours(newCompleted);
        await updateDoc(doc(db, 'users', user.uid), {
          completedTours: newCompleted
        });
      }
      setActiveTour(null);
      setStepIndex(0);
      return;
    }

    if ([EVENTS.STEP_AFTER, EVENTS.TARGET_NOT_FOUND].includes(type)) {
      const direction = action === ACTIONS.PREV ? -1 : 1;
      setStepIndex(Math.max(index + direction, 0));
    }
  };

  return (
    <TourContext.Provider value={{ startTour, completedTours, isTourRunning: run }}>
      {hasBootstrapped && activeTour && TOURS[activeTour] && (
        <Joyride
          {...({
            steps: TOURS[activeTour].steps,
            run: run,
            stepIndex,
            continuous: true,
            showProgress: true,
            showSkipButton: true,
            callback: handleJoyrideCallback,
            scrollOffset: 120,
            spotlightPadding: 8,
            targetWaitTimeout: 2000,
            styles: {
              buttonNext: {
                backgroundColor: '#1A1A1A',
                color: '#FAFAFA',
                fontFamily: 'monospace',
                fontSize: '12px',
                textTransform: 'uppercase',
                letterSpacing: '0.1em',
                fontWeight: 'bold',
                borderRadius: '0'
              },
              buttonBack: {
                color: '#1A1A1A',
                fontFamily: 'monospace',
                fontSize: '12px',
                textTransform: 'uppercase',
                letterSpacing: '0.1em',
                marginRight: '1rem',
              },
              buttonSkip: {
                color: '#D32F2F',
                fontFamily: 'monospace',
                fontSize: '12px',
                textTransform: 'uppercase',
                letterSpacing: '0.1em',
              },
              tooltipContent: {
                fontFamily: 'monospace',
                fontSize: '14px',
                lineHeight: '1.5'
              }
            },
            floaterProps: {
              disableAnimation: true
            }
          } as any)}
        />
      )}
      {children}
    </TourContext.Provider>
  );
};

export const useTour = () => useContext(TourContext);
