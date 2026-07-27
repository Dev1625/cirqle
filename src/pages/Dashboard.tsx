import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { collection, query, onSnapshot, where } from 'firebase/firestore';
import { db, handleFirestoreError } from '../config/firebase';
import { useAuth } from '../contexts/AuthContext';
import { Link } from 'react-router-dom';
import { Sparkles, ArrowRight, RefreshCw, Database, ListTodo, Clock, Send, Users, AlertTriangle } from 'lucide-react';
import { getGemini } from '../lib/gemini';
import { AI_FEATURES } from '../lib/aiDebug';
import Markdown from 'react-markdown';
import { seedSampleData } from '../lib/seed';
import { getFollowUpQueueItems, getRecordTime } from '../lib/tracker';
import { TierBadge, TierDot, tierMarkerColor } from '../components/ui/TierBadge';
import { AccentRule } from '../components/ui/AccentRule';

const BRIEF_TIMEOUT_MS = 20000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => window.setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

export default function Dashboard() {
  const { user } = useAuth();
  const [contacts, setContacts] = useState<any[]>([]);
  const [outreaches, setOutreaches] = useState<any[]>([]);
  const [isHovered, setIsHovered] = useState<string | null>(null);
  const [firestoreIssue, setFirestoreIssue] = useState<string | null>(null);

  const [aiBrief, setAiBrief] = useState<string>('');
  const [isGeneratingBrief, setIsGeneratingBrief] = useState(false);
  const [briefError, setBriefError] = useState<string | null>(null);
  const [isSeeding, setIsSeeding] = useState(false);
  const hasAttemptedBriefRef = useRef(false);

  useEffect(() => {
    if (!user) return;
    const qC = query(collection(db, `users/${user.uid}/contacts`), where('userId', '==', user.uid));
    const unsubC = onSnapshot(qC, (snapshot) => {
      setFirestoreIssue(null);
      const docs = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
      setContacts(docs.sort((a: any, b: any) => b.createdAt?.toMillis() - a.createdAt?.toMillis()));
    }, (error) => {
      if (error instanceof Error && error.message.includes('Missing or insufficient permissions')) {
        setFirestoreIssue('Firestore is rejecting reads. Publish the rules from firestore.rules to your Firebase project, then refresh the app.');
        return;
      }

      handleFirestoreError(error, 'list', `users/${user.uid}/contacts`);
    });

    const qO = query(collection(db, `users/${user.uid}/outreaches`), where('userId', '==', user.uid));
    const unsubO = onSnapshot(qO, (snapshot) => {
      const docs = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
      setOutreaches(docs.sort((a: any, b: any) => getRecordTime(b) - getRecordTime(a)));
    }, (error) => {
      if (error instanceof Error && error.message.includes('Missing or insufficient permissions')) {
        setFirestoreIssue('Firestore is rejecting reads. Publish the rules from firestore.rules to your Firebase project, then refresh the app.');
        return;
      }

      handleFirestoreError(error, 'list', `users/${user.uid}/outreaches`);
    });
    
    return () => { unsubC(); unsubO(); };
  }, [user]);

  const queueItems = useMemo(() => {
    const joined = outreaches.map((outreach) => ({
      ...outreach,
      contact: contacts.find((contact: any) => contact.id === outreach.contactId) || {}
    }));

    return getFollowUpQueueItems(joined);
  }, [contacts, outreaches]);

  const fetchBrief = useCallback(async (force = false) => {
    if (!user || contacts.length === 0) return;

    const cacheKey = `ai_brief_${user.uid}`;
    const timeKey = `ai_brief_time_${user.uid}`;

    if (!force) {
      const cached = localStorage.getItem(cacheKey);
      const cachedTime = localStorage.getItem(timeKey);

      if (cached && cachedTime) {
         const diffHours = (Date.now() - Number(cachedTime)) / (1000 * 60 * 60);
         // Refresh automatically every 24 hours
         if (diffHours < 24) {
            setAiBrief(cached);
            setBriefError(null);
            return;
         }
      }
    }

    setIsGeneratingBrief(true);
    setBriefError(null);
    try {
      // Pick the top 15 most recent/relevant ones to avoid token limits
      const miniTracker = [...outreaches].sort((a:any, b:any) => (b.sentAt?.toMillis() || 0) - (a.sentAt?.toMillis() || 0)).slice(0, 15).map((o: any) => {
        const c = contacts.find(con => con.id === o.contactId);
        return {
           contactName: c?.name,
           company: c?.company,
           status: o.status,
           date: o.sentAt?.toDate()?.toISOString(),
           nextAction: o.nextAction,
           responseReceived: o.responseReceived
        };
      });

      const ai = getGemini('dashboardBrief');
      const response = await withTimeout(
        ai.models.generateContent({
          model: AI_FEATURES.dashboardBrief.model,
          contents: `You are an AI Executive Assistant managing my CRM pipeline.
          Here is a slice of my tracker data: ${JSON.stringify(miniTracker)}
          Analyze this and write a very short "This Week's Priorities" brief.
          Be direct, professional, and slightly conversational. Maximum 3 bullet points.
          Focus on who to follow up with, who to thank, and what's overdue.`
        }),
        BRIEF_TIMEOUT_MS
      );
      const text = response.text || '';
      setAiBrief(text);
      setBriefError(null);
      localStorage.setItem(cacheKey, text);
      localStorage.setItem(timeKey, Date.now().toString());
    } catch (e) {
      console.error(e);
      setBriefError(
        e instanceof Error && e.message === 'timeout'
          ? "This is taking longer than expected — the AI service may be unreachable right now."
          : "Couldn't generate your priorities brief right now."
      );
    } finally {
      setIsGeneratingBrief(false);
    }
  }, [user, contacts, outreaches]);

  useEffect(() => {
    // Attempt to load the brief once, the first time contacts are ready —
    // not on every Firestore snapshot change (seeding 15 contacts used to
    // fire 15 wasted AI calls here).
    if (contacts.length > 0 && !hasAttemptedBriefRef.current) {
       hasAttemptedBriefRef.current = true;
       fetchBrief(false);
    }
  }, [contacts, fetchBrief]);

  const handleSeed = async () => {
    setIsSeeding(true);
    try {
       await seedSampleData(user);
       // Clear brief cache so it regenerates
       localStorage.removeItem(`ai_brief_${user?.uid}`);
       localStorage.removeItem(`ai_brief_time_${user?.uid}`);
       setAiBrief('');
       setBriefError(null);
       setFirestoreIssue(null);
       hasAttemptedBriefRef.current = true;
       setTimeout(() => fetchBrief(true), 1000);
    } catch(e) {
       console.error("Seeding failed", e);
       if (e instanceof Error && e.message.includes('Missing or insufficient permissions')) {
         setFirestoreIssue('Seeding is blocked by Firestore rules. Publish firestore.rules in your Firebase console or run `firebase deploy --only firestore`, then try seeding again.');
       }
    } finally {
       setIsSeeding(false);
    }
  };

  return (
    <div className="space-y-8">
      <div className="flex justify-between items-start flex-wrap gap-4">
        <div>
          <AccentRule className="mb-4" />
          <h1 className="font-serif text-5xl italic font-black mb-2">Dashboard.</h1>
          <p className="font-mono text-xs uppercase tracking-widest text-muted">Pulse of your network. Skim your relationships.</p>
        </div>
        <button 
           onClick={handleSeed}
           disabled={isSeeding}
           className="flex items-center gap-2 px-4 py-2 border border-ink/15 rounded-card bg-white hover:bg-ink hover:text-white transition-colors font-mono text-[10px] uppercase tracking-widest font-bold disabled:opacity-50"
        >
           <Database size={14} className={isSeeding ? "animate-pulse" : ""} />
           {isSeeding ? 'Seeding...' : 'Seed Test Data'}
        </button>
      </div>

      {firestoreIssue && (
        <div className="border border-red-300 bg-red-50 p-4 font-mono text-xs leading-relaxed text-red-800">
          {firestoreIssue}
        </div>
      )}

      {/* AI Briefing Card.
          This is the first thing on the dashboard by design: it is the one
          block that tells you what to *do* today, so it should be read before
          the queue it summarises rather than after it. */}
      <div className="bg-ink text-paper rounded-card p-6">
         <div className="flex justify-between items-center mb-4 flex-wrap gap-4">
            <h2 className="font-serif text-2xl italic font-bold flex items-center gap-2">
               {/* On the inverted ink card the oxblood would go muddy, so the
                   AI sparkle keeps paper here. */}
               <Sparkles size={20} /> This Week's AI Priorities
            </h2>
            <button
               onClick={() => fetchBrief(true)}
               disabled={isGeneratingBrief}
               className="flex items-center gap-2 px-3 py-1.5 bg-white/10 hover:bg-white/20 transition-colors font-mono text-[10px] uppercase tracking-widest disabled:opacity-50"
            >
               <RefreshCw size={12} className={isGeneratingBrief ? "animate-spin" : ""} />
               Refresh Brief
            </button>
         </div>

         {isGeneratingBrief ? (
            <p className="font-mono text-sm opacity-50 animate-pulse">Reading tracker data and generating your brief...</p>
         ) : briefError ? (
            <div className="flex flex-col gap-3 items-start">
               <p className="font-mono text-sm leading-relaxed flex items-start gap-2 max-w-2xl">
                  <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-400" />
                  <span>{briefError} Your data is safe — this only affects the AI summary.</span>
               </p>
               <button
                  onClick={() => fetchBrief(true)}
                  className="flex items-center gap-2 px-3 py-1.5 bg-white/10 hover:bg-white/20 transition-colors font-mono text-[10px] uppercase tracking-widest"
               >
                  <RefreshCw size={12} /> Try Again
               </button>
            </div>
         ) : aiBrief ? (
            <div className="font-mono text-sm leading-relaxed max-w-3xl animate-fade-in">
               <div className="markdown-body prose-invert prose-sm">
                 <Markdown>{aiBrief}</Markdown>
               </div>
               <div className="mt-4 pt-4 border-t border-paper/20">
                  <Link to="/app/tracker" className="inline-flex items-center gap-2 text-xs uppercase tracking-widest font-bold hover:opacity-70 transition-opacity">
                     Open Tracker <ArrowRight size={14} />
                  </Link>
               </div>
            </div>
         ) : contacts.length === 0 ? (
            <p className="font-mono text-sm opacity-50">Add a few contacts and log some outreach to get a personalized priorities brief.</p>
         ) : (
            <p className="font-mono text-sm opacity-50 animate-pulse">Preparing your brief...</p>
         )}
      </div>

      {/* The dashboard's hero block. Outer boundary steps up to /25 and takes
          the one soft card lift so it reads as a surface distinct from the
          cream page; every divider *inside* it stays at /15 or lighter. */}
      <div className="border border-ink/25 rounded-card bg-white shadow-card overflow-hidden">
        <div className="flex items-center justify-between gap-4 border-b border-ink/15 bg-[#F8F5EF] px-6 py-5 flex-wrap">
          <div>
            <h2 className="font-serif text-3xl italic font-bold flex items-center gap-2">
              <ListTodo size={22} className="text-brand" /> Follow-Up Queue
            </h2>
            <p className="mt-1 font-mono text-[10px] uppercase tracking-widest text-subtle">Action-first view of the people who need you next.</p>
          </div>
          <Link to="/app/tracker?mode=queue" className="inline-flex items-center gap-2 border border-ink/15 rounded-card px-3 py-2 font-mono text-[10px] uppercase tracking-widest font-bold hover:bg-ink hover:text-white transition-colors">
            Open Full Queue <ArrowRight size={14} />
          </Link>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 border-b border-ink/10">
          <DashboardQueueMetric icon={ListTodo} label="Items" value={queueItems.length} />
          <DashboardQueueMetric icon={Clock} label="Overdue" value={queueItems.filter((item) => item._actionDate && item._actionDate.getTime() < Date.now()).length} />
          <DashboardQueueMetric icon={Send} label="Replies" value={queueItems.filter((item) => item.status === 'Responded').length} />
          <DashboardQueueMetric icon={Users} label="Re-engage" value={queueItems.filter((item) => item.status === 'Re-engage').length} />
        </div>

        <div className="p-6">
          {queueItems.length === 0 ? (
            <div className="border border-dashed border-ink/20 bg-paper/40 p-10 text-center font-mono text-sm text-subtle">
              Nothing is waiting on you right now.
            </div>
          ) : (
            <div className="space-y-3">
              {queueItems.slice(0, 4).map((item, index) => (
                <div
                  key={item.id}
                  style={{
                    animationDelay: `${index * 40}ms`,
                    borderLeftColor: tierMarkerColor(item.contact?.relationshipTier),
                  }}
                  className="animate-fade-slide-up rounded-card border border-l-[3px] border-ink/15 bg-white p-4 hover:bg-paper transition-colors flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <Link to={`/app/directory/${item.contactId}`} className="font-serif text-xl font-bold hover:underline">
                        {item.contact?.name || 'Unknown'}
                      </Link>
                      {/* Relationship strength is Cirqle's whole pitch — the
                          queue is the first surface a user sees, so it carries
                          the same tier signal as Directory/Tracker. */}
                      <TierBadge tier={item.contact?.relationshipTier} />
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-subtle">
                      <span>{item.contact?.company || 'No firm'}</span>
                      <span>{item.status}</span>
                      <span>{item._actionDate ? new Date(item._actionDate).toLocaleDateString() : 'No due date'}</span>
                    </div>
                    {item.nextAction && <p className="mt-3 font-mono text-sm leading-relaxed">{item.nextAction}</p>}
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <Link to={`/app/directory/${item.contactId}`} className="px-4 py-2 border border-ink/15 rounded-card bg-white font-mono text-xs uppercase tracking-widest hover:bg-paper transition-colors">
                      Open
                    </Link>
                    <Link to={`/app/directory/${item.contactId}`} className="px-4 py-2 bg-ink text-white font-mono text-xs uppercase tracking-widest hover:bg-zinc-800 transition-colors">
                      Take Action
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Skimmable AI Rolodex */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {contacts.length === 0 ? (
           <div className="col-span-2 p-12 text-center border border-ink/15 rounded-card bg-white font-mono text-sm">
             Your network is empty. Drop some contacts in the Directory.
           </div>
        ) : (
           contacts.map((c, index) => (
             <Link
               to={`/app/directory/${c.id}`}
               key={c.id}
               style={{ animationDelay: `${Math.min(index, 10) * 30}ms` }}
               className="animate-fade-slide-up group bg-white border border-ink/15 rounded-card p-6 hover:bg-ink transition-colors relative overflow-hidden flex flex-col justify-between min-h-[160px]"
               onMouseEnter={() => setIsHovered(c.id)}
               onMouseLeave={() => setIsHovered(null)}
             >
               <div>
                  <div className="flex items-start justify-between mb-2">
                     <h3 className="font-serif text-2xl font-bold group-hover:text-white transition-colors leading-none tracking-tight">{c.name}</h3>
                  </div>
                  <p className="font-mono text-[10px] uppercase tracking-widest text-subtle mb-4 group-hover:text-white/70 transition-colors">
                     {c.role} {c.company && `@ ${c.company}`}
                  </p>
                  
                  <div className="font-mono text-sm leading-relaxed group-hover:text-white/90 line-clamp-3">
                     {c.summary || <span className="text-muted group-hover:text-white/70 italic transition-colors">No AI summary generated for this contact.</span>}
                  </div>
               </div>
               
               <div className={`mt-4 pt-4 border-t ${isHovered === c.id ? 'border-white/20' : 'border-ink/10'} font-mono text-[10px] uppercase flex justify-between group-hover:text-white/50 transition-colors`}>
                  <span>Explore Connection</span>
                  {/* A dot rather than a TierBadge chip: these cards invert to
                      ink on hover, which a pale chip background fights. */}
                  <span className="flex items-center gap-1.5">
                    <TierDot tier={c.relationshipTier} />
                    {c.relationshipTier}
                  </span>
               </div>
             </Link>
           ))
        )}
      </div>
    </div>
  );
}

function DashboardQueueMetric({ icon: Icon, label, value }: { icon: any, label: string, value: number }) {
  return (
    <div className="border-r border-ink/10 p-4 last:border-r-0">
      <div className="mb-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-subtle">
        <Icon size={14} />
        {label}
      </div>
      <div className="font-serif text-3xl font-black">{value}</div>
    </div>
  );
}
