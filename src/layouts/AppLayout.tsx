import React, { useEffect, useState } from 'react';
import { Outlet, Link, useLocation, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { Network, Navigation, Settings, FileText, LogOut, Menu, HelpCircle, CheckCircle2, PlayCircle } from 'lucide-react';
import { auth, db } from '../config/firebase';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { Logo } from '../components/Logo';
import { GlobalSearch } from '../components/GlobalNLSearch';
import { useTour, TOURS } from '../contexts/TourContext';
import { useCaptureDrain } from '../hooks/useCaptureDrain';

const AppLayout = () => {
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const trackerMode = searchParams.get('mode') || 'sheet';
  const showGlobalSearch = location.pathname !== '/app/graph';

  const [isInitializing, setIsInitializing] = useState(true);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
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

  const handleLogout = async () => {
    await auth.signOut();
  };

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
           className="absolute top-6 left-6 z-50 p-2 bg-paper border border-ink shadow-[4px_4px_0px_0px_rgba(26,26,26,1)] hover:bg-ink hover:text-white transition-colors"
         >
           <Menu size={20} />
         </button>
      )}

      {/* Sidebar */}
      {isSidebarOpen && (
         <aside className="w-64 flex-shrink-0 border-r border-ink bg-paper p-8 z-10 flex flex-col relative transition-all duration-300">
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
                     className={`flex items-center gap-3 group cursor-pointer transition-opacity ${item.class} ${
                       isActive ? 'opacity-100' : 'opacity-40 hover:opacity-100'
                     }`}
                   >
                     <div className={`w-2 h-2 ${isActive ? 'bg-ink' : 'bg-transparent border border-ink'}`}></div>
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
                                    className={`flex items-center gap-2 group cursor-pointer transition-opacity ${
                                       isSubActive ? 'opacity-100 text-ink' : 'opacity-50 hover:opacity-100'
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
               className="flex items-center gap-3 opacity-40 hover:opacity-100 transition-opacity w-full text-left font-mono text-xs uppercase tracking-widest font-bold"
             >
               <HelpCircle size={14} /> Help & Tours
             </button>
             <button 
               onClick={handleLogout}
               className="flex items-center gap-3 opacity-40 hover:opacity-100 transition-opacity w-full text-left font-mono text-xs uppercase tracking-widest font-bold"
             >
               <LogOut size={14} /> Log Out
             </button>
           </div>
         </aside>
      )}

      {/* Main Content Area */}
      <div className="flex-1 relative flex flex-col overflow-hidden">
        <main className="flex-1 overflow-auto bg-transparent">
          <div className={`p-8 max-w-6xl mx-auto w-full transition-all ${showGlobalSearch ? 'pb-48' : 'pb-8'} ${!isSidebarOpen ? 'pt-24' : ''}`}>
            <Outlet />
          </div>
        </main>
        
        {showGlobalSearch && (
          <div className="absolute bottom-8 left-8 right-8 z-40 pointer-events-none flex justify-center tour-global-search">
            <div className="w-full max-w-5xl pointer-events-auto">
              <GlobalSearch />
            </div>
          </div>
        )}
      </div>

      {/* Embedded Help Menu Overlay */}
      {showHelpMenu && (
         <div className="fixed inset-0 z-50 bg-ink/70 backdrop-blur-sm flex items-center justify-center p-4" onClick={(e) => { if (e.target === e.currentTarget) setShowHelpMenu(false); }}>
            <div className="bg-paper border border-ink p-8 w-full max-w-2xl max-h-[85vh] overflow-y-auto shadow-[16px_16px_0px_0px_rgba(26,26,26,1)] animate-fade-in relative">
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
                                 <h4 className={`font-mono text-xs uppercase tracking-widest font-bold ${isDone ? 'text-ink/60' : 'text-ink'}`}>{tourDef.title}</h4>
                                 <p className="font-mono text-[10px] text-subtle mt-1">{tourDef.steps.length} steps</p>
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
                             className="text-[10px] font-mono uppercase font-bold tracking-widest border border-ink px-3 py-1 hover:bg-ink hover:text-white transition-colors"
                           >
                             Run Tour
                           </button>
                        </div>
                     );
                  })}
               </div>

               <div className="space-y-6">
                  <h3 className="font-mono text-[10px] uppercase tracking-widest font-bold text-subtle border-b border-ink/20 pb-2 mb-4">What's New in Cirqle</h3>
                  <div className="border-l-2 border-ink pl-4 py-1">
                     <h4 className="font-serif text-lg font-bold">Interactive Guided Tours</h4>
                     <p className="font-mono text-xs mt-2 leading-relaxed text-ink/80">We've ripped out the static tutorial modals and replaced them with interactive spotlights that guide you through making an actual outreach or query. Available anytime dynamically under Help.</p>
                     <p className="font-mono text-[10px] uppercase text-subtle mt-2">Just Now</p>
                  </div>
                  <div className="border-l-2 border-ink/20 pl-4 py-1">
                     <h4 className="font-serif text-lg font-bold opacity-70">Enhanced Filtering in Tracker</h4>
                     <p className="font-mono text-xs mt-2 leading-relaxed text-ink/60">You can now stack firm filters, kanban modes, and natural language queue queries seamlessly.</p>
                     <p className="font-mono text-[10px] uppercase text-subtle mt-2 opacity-50">Last Week</p>
                  </div>
               </div>
            </div>
         </div>
      )}
    </div>
  );
};

export default AppLayout;
