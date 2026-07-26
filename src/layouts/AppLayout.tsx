import React, { Suspense, useEffect, useState } from 'react';
import { Outlet, Link, useLocation, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { motion } from 'motion/react';
import { useAuth } from '../contexts/AuthContext';
import { Network, Navigation, Settings, FileText, LogOut, Menu, HelpCircle, CheckCircle2, PlayCircle } from 'lucide-react';
import { auth, db } from '../config/firebase';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { Logo } from '../components/Logo';
import { GlobalSearch } from '../components/GlobalNLSearch';
import { useTour, TOURS } from '../contexts/TourContext';
import { useCaptureDrain } from '../hooks/useCaptureDrain';
import { COMPOSE_EVENT, ESCAPE_EVENT, useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';

const AppLayout = () => {
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const trackerMode = searchParams.get('mode') || 'sheet';
  const showGlobalSearch = location.pathname !== '/app/graph';

  const [isInitializing, setIsInitializing] = useState(true);
  // Start collapsed on narrower viewports (tablet widths) so the fixed
  // 256px sidebar doesn't permanently eat a third of the content area.
  const [isSidebarOpen, setIsSidebarOpen] = useState(() => typeof window === 'undefined' || window.innerWidth >= 1100);
  // Held here rather than per-page so a card tap files itself wherever the
  // owner happens to land in the app.
  const [profile, setProfile] = useState<any>(null);


  // Help Menu State
  const [showHelpMenu, setShowHelpMenu] = useState(false);
  const { startTour, completedTours } = useTour();

  useEffect(() => {
    const initUser = async () => {
      if (!user) return;
      try {
        const docRef = doc(db, 'users', user.uid);
        const docSnap = await getDoc(docRef);
        let currentApiKey = null;

        if (!docSnap.exists()) {
           await setDoc(docRef, {
             userId: user.uid,
             createdAt: serverTimestamp(),
             updatedAt: serverTimestamp(),
             name: null,
             role: null,
             company: null,
             bio: null,
             resumeText: null,
             targetIndustries: [],
           });
        } else {
           const data = docSnap.data();
           setProfile(data);
           if (data && data.apiKey) {
             currentApiKey = data.apiKey;
           }
        }

        // If the user does not have a virtual API key yet, generate one securely
        if (!currentApiKey) {
          try {
            const res = await fetch('/api/register-user', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({ userId: user.uid })
            });

            if (res.ok) {
              const resData = await res.json();
              if (resData.apiKey) {
                currentApiKey = resData.apiKey;
                // Save the key securely to the user's Firestore document
                await setDoc(docRef, { apiKey: currentApiKey }, { merge: true });
              }
            } else {
              console.error("Failed to generate key from serverless API:", await res.text());
            }
          } catch (apiErr) {
            console.error("Error generating API key:", apiErr);
          }
        }

        // Load the key into local storage for the Google GenAI SDK to use
        if (currentApiKey) {
          localStorage.setItem('CIRQLE_USER_PROXY_KEY', currentApiKey);
        }
      } catch (err) {
        console.error("Failed to initialize user document:", err);
      } finally {
        setIsInitializing(false);
      }
    };
    if (user) {
      initUser();
    } else {
      setIsInitializing(false);
    }
  }, [user]);

  // Files any card taps that happened while the owner was away.
  useCaptureDrain(user?.uid, profile);

  // `c` composes. On a contact record the page itself opens Draft Outreach;
  // anywhere else there is nobody to draft to yet, so send them to pick one.
  const onContactRecord = /^\/app\/directory\/[^/]+$/.test(location.pathname);
  useKeyboardShortcuts({
    onCompose: () => {
      if (onContactRecord) window.dispatchEvent(new CustomEvent(COMPOSE_EVENT));
      else navigate('/app/directory');
    },
  });

  useEffect(() => {
    const onEscape = () => setShowHelpMenu(false);
    window.addEventListener(ESCAPE_EVENT, onEscape);
    return () => window.removeEventListener(ESCAPE_EVENT, onEscape);
  }, []);

  const handleLogout = async () => {
    await auth.signOut();
  };

  useEffect(() => {
    if (!showHelpMenu) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowHelpMenu(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showHelpMenu]);

  if (!user) {
    return <Navigate to="/login" />;
  }

  if (isInitializing) {
    return <div className="p-8 font-mono flex items-center justify-center h-screen bg-paper text-ink">Synchronizing secure context...</div>;
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
    <div className="flex h-screen overflow-hidden bg-transparent relative">
      
      {/* Mobile / Collapsed Menu Hamburger */}
      {!isSidebarOpen && (
         <button 
           onClick={() => setIsSidebarOpen(true)}
           className="absolute top-6 left-6 z-50 p-2 bg-rail border border-ink/25 rounded-card hover:bg-ink hover:text-white transition-colors"
         >
           <Menu size={20} />
         </button>
      )}

      {/* Sidebar */}
      {isSidebarOpen && (
         <aside className="w-64 flex-shrink-0 border-r border-ink/25 bg-rail p-8 z-10 flex flex-col relative transition-all duration-300">
           <div onClick={() => setIsSidebarOpen(false)} className="cursor-pointer group relative">
             <Logo />
             <div className="absolute -right-2 top-0 opacity-0 group-hover:opacity-100 font-mono text-[10px] bg-ink text-white px-2 py-0.5 pointer-events-none transition-opacity">
                Close
             </div>
           </div>
           
           <ul className="space-y-6 flex-1 mt-8">
             {navItems.map((item) => {
               const isActive = location.pathname === item.path;
               
               return (
                 <li key={item.path}>
                   <Link
                     to={item.path}
                     className={`flex items-center gap-3 group cursor-pointer transition-colors ${item.class} ${
                       isActive ? 'text-brand' : 'text-muted hover:text-ink'
                     }`}
                   >
                     {/* Active state carries the accent rather than plain ink —
                         one more legitimate, restrained use of --color-brand. */}
                     <div className={`w-2 h-2 transition-colors ${isActive ? 'bg-brand' : 'bg-transparent border border-current'}`}></div>
                     <span className="font-mono text-xs uppercase tracking-widest font-bold">{item.name}</span>
                   </Link>
                   
                   {/* Nested Tracker Items */}
                   {isActive && item.subItems && (
                      <ul className="mt-4 ml-5 space-y-4 border-l border-ink/20 pl-4">
                         {item.subItems.map((sub) => {
                            const isSubActive = trackerMode === sub.query.replace('?mode=', '');
                            return (
                               <li key={sub.name}>
                                 <Link
                                    to={`${item.path}${sub.query}`}
                                    className={`flex items-center gap-2 group cursor-pointer transition-colors ${
                                       isSubActive ? 'text-brand' : 'text-muted hover:text-ink'
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
           
           <div className="mt-auto pt-6 border-t border-ink/20 space-y-4">
             <button
               onClick={() => setShowHelpMenu(true)}
               className="flex items-center gap-3 text-muted hover:text-ink transition-colors w-full text-left font-mono text-xs uppercase tracking-widest font-bold"
             >
               <HelpCircle size={14} /> Help & Tours
             </button>
             <button
               onClick={handleLogout}
               className="flex items-center gap-3 text-muted hover:text-ink transition-colors w-full text-left font-mono text-xs uppercase tracking-widest font-bold"
             >
               <LogOut size={14} /> Log Out
             </button>
           </div>
         </aside>
      )}

      {/* Main Content Area */}
      <div className="flex-1 relative flex flex-col overflow-hidden">
        <main className="flex-1 overflow-auto bg-transparent">
          {/* Keyed on the route so each view fades + slides in on navigation
              instead of snapping. Sub-route query changes (e.g. Tracker
              ?mode=) are intentionally excluded so in-page tab switches
              don't re-trigger a full page transition. */}
          <motion.div
            key={location.pathname}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            className={`p-8 max-w-6xl mx-auto w-full pb-8 ${!isSidebarOpen ? 'pt-24' : ''}`}
          >
            <Suspense
              fallback={
                <div className="flex items-center justify-center py-24 font-mono text-xs uppercase tracking-widest text-muted">
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
          <div className="shrink-0 z-40 border-t border-ink/25 bg-rail/95 backdrop-blur-sm px-8 py-4 flex justify-center tour-global-search">
            <div className="w-full max-w-5xl">
              <GlobalSearch />
            </div>
          </div>
        )}
      </div>

      {/* Embedded Help Menu Overlay */}
      {showHelpMenu && (
         <div className="fixed inset-0 z-50 bg-ink/70 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in" onClick={(e) => { if (e.target === e.currentTarget) setShowHelpMenu(false); }}>
            <div className="bg-paper border border-ink/15 rounded-card p-8 w-full max-w-2xl max-h-[85vh] overflow-y-auto shadow-float animate-fade-scale-in relative">
               <button onClick={() => setShowHelpMenu(false)} className="absolute top-6 right-6 font-mono text-xl hover:text-red-500 transition-colors">X</button>
               <h2 className="font-serif text-3xl font-bold mb-8">Guided Tours & Help</h2>
               
               <div className="space-y-4 mb-12">
                  <h3 className="font-mono text-[10px] uppercase tracking-widest font-bold text-subtle border-b border-ink/20 pb-2 mb-4">Interactive Walkthroughs</h3>
                  {Object.entries(TOURS).map(([tourId, tourDef]) => {
                     const isDone = completedTours.includes(tourId);
                     return (
                        <div key={tourId} className="flex items-center justify-between p-4 border border-ink/20 bg-white hover:border-ink transition-colors group">
                           <div className="flex items-center gap-3">
                              {isDone ? (
                                <CheckCircle2 size={18} className="text-green-600" />
                              ) : (
                                <PlayCircle size={18} className="text-subtle group-hover:text-ink" />
                              )}
                              <div>
                                 <h4 className={`font-mono text-xs uppercase tracking-widest font-bold ${isDone ? 'text-muted' : 'text-ink'}`}>{tourDef.title}</h4>
                                 <p className="font-mono text-[10px] text-subtle mt-1">{tourDef.steps.length} step{tourDef.steps.length === 1 ? '' : 's'}</p>
                              </div>
                           </div>
                           <button 
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
                             className="text-[10px] font-mono uppercase font-bold tracking-widest border border-ink/15 rounded-card px-3 py-1 hover:bg-ink hover:text-white transition-colors"
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
                     <p className="font-mono text-xs mt-2 leading-relaxed text-ink/80">Publish a tap-ready card page from Settings &rarr; Connections. When someone saves your contact, they land in your Directory automatically — with the event you were at already tagged. Preview the whole thing without any hardware.</p>
                     <p className="font-mono text-[10px] uppercase text-subtle mt-2">Just Now</p>
                  </div>
                  <div className="border-l-2 border-ink pl-4 py-1">
                     <h4 className="font-serif text-lg font-bold">Briefs, memos and commitments</h4>
                     <p className="font-mono text-xs mt-2 leading-relaxed text-ink/80">The Dashboard now reads you in before a meeting, takes a voice memo after it, and pulls out anything you promised. Relationship health explains itself instead of showing a bare number, and can be pinned so the quarterly relationships stop nagging.</p>
                     <p className="font-mono text-[10px] uppercase text-subtle mt-2">Just Now</p>
                  </div>
                  <div className="border-l-2 border-ink pl-4 py-1">
                     <h4 className="font-serif text-lg font-bold">Keyboard shortcuts</h4>
                     <p className="font-mono text-xs mt-2 leading-relaxed text-ink/80"><span className="font-bold">/</span> focuses Ask AI, <span className="font-bold">c</span> starts a draft, <span className="font-bold">Esc</span> closes whatever is open.</p>
                     <p className="font-mono text-[10px] uppercase text-subtle mt-2">Just Now</p>
                  </div>
                  <div className="border-l-2 border-ink/20 pl-4 py-1">
                     <h4 className="font-serif text-lg font-bold opacity-70">Interactive Guided Tours</h4>
                     <p className="font-mono text-xs mt-2 leading-relaxed text-ink/60">We've ripped out the static tutorial modals and replaced them with interactive spotlights that guide you through making an actual outreach or query. Available anytime dynamically under Help.</p>
                     <p className="font-mono text-[10px] uppercase text-subtle mt-2 opacity-70">Earlier</p>
                  </div>
                  <div className="border-l-2 border-ink/20 pl-4 py-1">
                     <h4 className="font-serif text-lg font-bold text-muted">Enhanced Filtering in Tracker</h4>
                     <p className="font-mono text-xs mt-2 leading-relaxed text-muted">You can now stack firm filters, kanban modes, and natural language queue queries seamlessly.</p>
                     <p className="font-mono text-[10px] uppercase text-muted mt-2">Last Week</p>
                  </div>
               </div>
            </div>
         </div>
      )}
    </div>
  );
};

export default AppLayout;
