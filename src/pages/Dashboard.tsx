import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { collection, query, onSnapshot, where } from 'firebase/firestore';
import { db, handleFirestoreError } from '../config/firebase';
import { useAuth } from '../contexts/AuthContext';
import { Link } from 'react-router';
import { Sparkles, ArrowRight, RefreshCw, Database, ListTodo, Clock, Send, Users, CheckCircle2 } from 'lucide-react';
import { AICancelledError, AIUnavailableError } from '../lib/ai';
import Markdown from 'react-markdown';
import { seedSampleData } from '../lib/seed';
import { getFollowUpQueueItems, getRecordTime } from '../lib/tracker';
import { TierBadge, TierDot, tierMarkerColor } from '../components/ui/TierBadge';
import { AccentRule } from '../components/ui/AccentRule';
import { TodaysMeetings } from '../components/dashboard/TodaysMeetings';
import { CommitmentsPanel } from '../components/dashboard/CommitmentsPanel';
import { DormantDigest } from '../components/dashboard/DormantDigest';
import { VoiceMemo } from '../components/voice/VoiceMemo';
import { useCalendarEvents } from '../hooks/useCalendarEvents';
import type { CalendarEvent } from '../lib/integrations/calendar';
import { AIProvenance } from '../components/ui/AIProvenance';
import {
  decodePriorityBrief,
  encodePriorityBrief,
  generateWeeklyPriorities,
  toPriorityBrief,
} from '../lib/priorityBrief';
import type { GroundingDisplay } from '../lib/grounding';
import {
  isContactAIEligible,
  managedContactFromRecord,
} from '../lib/contactManagementCore';
import { EmptyState } from '../components/ui/EmptyState';
import { AISurface } from '../components/ui/AISurface';
import {
  clearDashboardBriefCache,
  readDashboardBriefCache,
  writeDashboardBriefCache,
} from '../lib/dashboardBriefCache';

export default function Dashboard() {
  const { user } = useAuth();
  const [contacts, setContacts] = useState<any[]>([]);
  const [outreaches, setOutreaches] = useState<any[]>([]);
  const [contactsLoaded, setContactsLoaded] = useState(false);
  const [outreachesLoaded, setOutreachesLoaded] = useState(false);
  const [isHovered, setIsHovered] = useState<string | null>(null);
  const [contactsLoadIssue, setContactsLoadIssue] = useState<string | null>(null);
  const [outreachesLoadIssue, setOutreachesLoadIssue] = useState<string | null>(null);
  const [firestoreOperationIssue, setFirestoreOperationIssue] = useState<string | null>(null);
  const firestoreIssue =
    firestoreOperationIssue || contactsLoadIssue || outreachesLoadIssue;

  const [aiBrief, setAiBrief] = useState<string>('');
  const [briefGrounding, setBriefGrounding] = useState<GroundingDisplay | null>(null);
  const [isGeneratingBrief, setIsGeneratingBrief] = useState(false);
  const [briefError, setBriefError] = useState<string | null>(null);
  const briefControllerRef = useRef<AbortController | null>(null);
  const [isSeeding, setIsSeeding] = useState(false);
  const hasAttemptedBriefRef = useRef(false);
  const demoDataEnabled =
    import.meta.env.DEV || import.meta.env.VITE_ENABLE_DEMO_DATA === 'true';

  // Calendar (real or mock) drives the pre-meeting briefs and the
  // post-meeting voice-memo prompt.
  const calendar = useCalendarEvents(user?.uid);
  const [memoFor, setMemoFor] = useState<CalendarEvent | null>(null);

  useEffect(() => {
    if (!user) return;
    setContactsLoaded(false);
    setOutreachesLoaded(false);
    setContactsLoadIssue(null);
    setOutreachesLoadIssue(null);
    setFirestoreOperationIssue(null);
    const qC = query(collection(db, `users/${user.uid}/contacts`), where('userId', '==', user.uid));
    const unsubC = onSnapshot(qC, (snapshot) => {
      setContactsLoadIssue(null);
      const docs = snapshot.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter((contact: any) => {
          const managed = managedContactFromRecord(contact.id, contact);
          return managed.lifecycleStatus === 'active' && !managed.mergedIntoContactId;
        });
      setContacts(docs.sort((a: any, b: any) => b.createdAt?.toMillis() - a.createdAt?.toMillis()));
      setContactsLoaded(true);
    }, (error) => {
      setContactsLoaded(true);
      if (error instanceof Error && error.message.includes('Missing or insufficient permissions')) {
        setContactsLoadIssue('Firestore is rejecting contact reads. Publish the rules from firestore.rules to your Firebase project, then refresh the app.');
        return;
      }

      setContactsLoadIssue('Cirqle could not load your contacts. Check your connection, then refresh the page.');
      handleFirestoreError(error, 'list', `users/${user.uid}/contacts`);
    });

    const qO = query(collection(db, `users/${user.uid}/outreaches`), where('userId', '==', user.uid));
    const unsubO = onSnapshot(qO, (snapshot) => {
      const docs = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
      setOutreaches(docs.sort((a: any, b: any) => getRecordTime(b) - getRecordTime(a)));
      setOutreachesLoaded(true);
      setOutreachesLoadIssue(null);
    }, (error) => {
      setOutreachesLoaded(true);
      if (error instanceof Error && error.message.includes('Missing or insufficient permissions')) {
        setOutreachesLoadIssue('Firestore is rejecting outreach reads. Publish the rules from firestore.rules to your Firebase project, then refresh the app.');
        return;
      }

      setOutreachesLoadIssue('Cirqle could not load your outreach history. Check your connection, then refresh the page.');
      handleFirestoreError(error, 'list', `users/${user.uid}/outreaches`);
    });
    
    return () => { unsubC(); unsubO(); };
  }, [user]);

  const dashboardLoaded = contactsLoaded && outreachesLoaded;

  const queueItems = useMemo(() => {
    const joined = outreaches
      .map((outreach) => ({
        ...outreach,
        contact: contacts.find((contact: any) => contact.id === outreach.contactId),
      }))
      .filter((outreach) => Boolean(outreach.contact));

    return getFollowUpQueueItems(joined);
  }, [contacts, outreaches]);

  const fetchBrief = useCallback(async (force = false) => {
    if (!user || contacts.length === 0 || outreaches.length === 0) return;
    briefControllerRef.current?.abort();

    if (!force) {
      const cached = readDashboardBriefCache(user.uid);

      if (cached) {
        const decoded = decodePriorityBrief(cached);
        const eligibleContactIds = new Set(
          contacts
            .filter((contact) =>
              isContactAIEligible(
                managedContactFromRecord(contact.id, contact),
              ),
            )
            .map((contact) => contact.id),
        );
        const outreachContact = new Map(
          outreaches.map((outreach) => [
            String(outreach.id),
            String(outreach.contactId || ''),
          ]),
        );
        const cacheStillEligible = decoded?.grounding.usedSourceIds.every(
          (sourceId) => {
            if (sourceId.startsWith('contact-')) {
              return eligibleContactIds.has(sourceId.slice('contact-'.length));
            }
            if (sourceId.startsWith('outreach-')) {
              const contactId = outreachContact.get(
                sourceId.slice('outreach-'.length),
              );
              return Boolean(contactId && eligibleContactIds.has(contactId));
            }
            return true;
          },
        );
        if (decoded && cacheStillEligible) {
          setAiBrief(decoded.text);
          setBriefGrounding(decoded.grounding);
          setBriefError(null);
          return;
        }
        clearDashboardBriefCache(user.uid);
      }
    }

    const controller = new AbortController();
    briefControllerRef.current = controller;
    setIsGeneratingBrief(true);
    setBriefError(null);
    try {
      const { grounded, sources } = await generateWeeklyPriorities(
        contacts,
        outreaches,
        null,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      const brief = toPriorityBrief(grounded, sources);
      setAiBrief(brief.text);
      setBriefGrounding(brief.grounding);
      setBriefError(null);
      writeDashboardBriefCache(user.uid, encodePriorityBrief(brief));
    } catch (e) {
      if (e instanceof AICancelledError || controller.signal.aborted) return;
      console.warn('[priority-brief] temporarily unavailable');
      // The wrapper already produces user-facing text (timeout, rate limit,
      // rejected key, gateway down), so use it rather than flattening every
      // cause into one generic line.
      setBriefError(
        e instanceof AIUnavailableError
          ? e.message
          : "Couldn't generate your priorities brief right now."
      );
    } finally {
      if (briefControllerRef.current === controller) {
        briefControllerRef.current = null;
        setIsGeneratingBrief(false);
      }
    }
  }, [user, contacts, outreaches]);

  const cancelBrief = useCallback(() => {
    briefControllerRef.current?.abort();
  }, []);

  useEffect(
    () => () => briefControllerRef.current?.abort(),
    [],
  );

  useEffect(() => {
    // Attempt to load the brief once, the first time contacts are ready —
    // not on every Firestore snapshot change (seeding 15 contacts used to
    // fire 15 wasted AI calls here).
    if (contacts.length > 0 && outreaches.length > 0 && !hasAttemptedBriefRef.current) {
       hasAttemptedBriefRef.current = true;
       fetchBrief(false);
    }
  }, [contacts, outreaches, fetchBrief]);

  const handleSeed = async () => {
    setIsSeeding(true);
    try {
       await seedSampleData(user);
       // Clear brief cache so it regenerates
       if (user) clearDashboardBriefCache(user.uid);
       setAiBrief('');
       setBriefGrounding(null);
       setBriefError(null);
       setFirestoreOperationIssue(null);
       hasAttemptedBriefRef.current = true;
       setTimeout(() => fetchBrief(true), 1000);
    } catch(e) {
       console.warn('[demo-seeding] temporarily unavailable');
       if (e instanceof Error && e.message.includes('Missing or insufficient permissions')) {
         setFirestoreOperationIssue('Seeding is blocked by Firestore rules. Publish firestore.rules in your Firebase console or run `firebase deploy --only firestore`, then try seeding again.');
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
        {demoDataEnabled && (
          <button
            type="button"
            onClick={handleSeed}
            disabled={isSeeding}
            aria-busy={isSeeding}
            title="Demo utility: writes sample CRM records into this account"
            className="flex min-h-11 items-center gap-2 rounded-card border border-ink/15 bg-white px-4 py-2 font-mono text-[10px] font-bold uppercase tracking-widest transition-colors hover:bg-ink hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Database size={14} className={isSeeding ? "animate-pulse" : ""} />
            {isSeeding ? 'Seeding demo data...' : 'Demo: Seed Test Data'}
          </button>
        )}
      </div>

      {firestoreIssue && (
        <div role="alert" className="border border-red-300 bg-red-50 p-4 font-mono text-xs leading-relaxed text-red-800">
          {firestoreIssue}
        </div>
      )}

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
          <Link to="/app/tracker?mode=queue" className="inline-flex min-h-11 items-center gap-2 rounded-card border border-ink/15 px-3 py-2 font-mono text-[10px] font-bold uppercase tracking-widest transition-colors hover:bg-ink hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">
            Open Full Queue <ArrowRight size={14} />
          </Link>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 border-b border-ink/10">
          <DashboardQueueMetric icon={ListTodo} label="Items" value={dashboardLoaded ? queueItems.length : '—'} />
          <DashboardQueueMetric icon={Clock} label="Overdue" value={dashboardLoaded ? queueItems.filter((item) => item._actionDate && item._actionDate.getTime() < Date.now()).length : '—'} />
          <DashboardQueueMetric icon={Send} label="Replies" value={dashboardLoaded ? queueItems.filter((item) => item.status === 'Responded').length : '—'} />
          <DashboardQueueMetric icon={Users} label="Re-engage" value={dashboardLoaded ? queueItems.filter((item) => item.status === 'Re-engage').length : '—'} />
        </div>

        <div className="p-6">
          {!dashboardLoaded ? (
            <div role="status" className="border border-dashed border-ink/20 bg-paper/40 p-10 text-center font-mono text-sm text-subtle">
              Loading your follow-up queue…
            </div>
          ) : firestoreIssue ? (
            <div role="status" className="border border-dashed border-ink/20 bg-paper/40 p-10 text-center font-mono text-sm text-subtle">
              The queue will return after the data connection is restored.
            </div>
          ) : contacts.length === 0 ? (
            <EmptyState
              icon={Users}
              eyebrow="First step"
              title="Build the network your queue will protect."
              description="Add a contact first. Once you log an outreach or next step, Cirqle will surface what needs your attention here."
              primaryAction={(
                <Link
                  to="/app/directory?add=paste"
                  className="inline-flex min-h-11 items-center justify-center rounded-card bg-ink px-4 py-2 font-mono text-[10px] font-bold uppercase tracking-widest text-white transition-colors hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                >
                  Paste a bio
                </Link>
              )}
              secondaryAction={(
                <Link
                  to="/app/directory?import=csv"
                  className="inline-flex min-h-11 items-center justify-center rounded-card border border-ink/15 bg-white px-4 py-2 font-mono text-[10px] font-bold uppercase tracking-widest transition-colors hover:bg-ink hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                >
                  Import CSV
                </Link>
              )}
              tertiaryAction={demoDataEnabled ? (
                <button
                  type="button"
                  onClick={handleSeed}
                  disabled={isSeeding}
                  aria-busy={isSeeding}
                  className="inline-flex min-h-11 items-center justify-center rounded-card border border-ink/15 bg-white px-4 py-2 font-mono text-[10px] font-bold uppercase tracking-widest transition-colors hover:bg-ink hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isSeeding ? 'Adding demo data…' : 'Try with demo data'}
                </button>
              ) : undefined}
            />
          ) : outreaches.length === 0 ? (
            <EmptyState
              icon={Send}
              eyebrow="Queue setup"
              title="Your contacts are in. Add the first next step."
              description="Open a contact to log outreach, a reply, or a follow-up date. That evidence becomes the queue."
              primaryAction={(
                <Link
                  to={`/app/directory/${contacts[0].id}`}
                  className="inline-flex min-h-11 items-center justify-center rounded-card bg-ink px-4 py-2 font-mono text-[10px] font-bold uppercase tracking-widest text-white transition-colors hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                >
                  Open {contacts[0].name || 'first contact'}
                </Link>
              )}
              secondaryAction={(
                <Link
                  to="/app/directory"
                  className="inline-flex min-h-11 items-center justify-center rounded-card border border-ink/15 bg-white px-4 py-2 font-mono text-[10px] font-bold uppercase tracking-widest transition-colors hover:bg-ink hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                >
                  Browse directory
                </Link>
              )}
            />
          ) : queueItems.length === 0 ? (
            <EmptyState
              icon={CheckCircle2}
              eyebrow="Queue clear"
              title="You’re caught up."
              description="There are no overdue follow-ups, unanswered replies, or relationships due for re-engagement right now."
              primaryAction={(
                <Link
                  to="/app/tracker"
                  className="inline-flex min-h-11 items-center justify-center rounded-card border border-ink/15 bg-white px-4 py-2 font-mono text-[10px] font-bold uppercase tracking-widest transition-colors hover:bg-ink hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                >
                  Review activity
                </Link>
              )}
              status
            />
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
                    <Link to={`/app/directory/${item.contactId}`} className="inline-flex min-h-11 items-center rounded-card border border-ink/15 bg-white px-4 py-2 font-mono text-xs uppercase tracking-widest transition-colors hover:bg-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">
                      Open
                    </Link>
                    <Link to={`/app/directory/${item.contactId}`} className="inline-flex min-h-11 items-center rounded-card bg-ink px-4 py-2 font-mono text-xs uppercase tracking-widest text-white transition-colors hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">
                      Take Action
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {user && (
        <TodaysMeetings
          uid={user.uid}
          events={calendar.events}
          contacts={contacts}
          syncedAt={calendar.syncedAt}
          state={calendar.state}
          error={calendar.error}
          onRefresh={calendar.refresh}
          onRecordMemo={setMemoFor}
        />
      )}

      {user && <CommitmentsPanel uid={user.uid} />}

      {user && <DormantDigest uid={user.uid} senderName={calendar.profile?.name || 'me'} />}

      {/* AI Briefing Card */}
      <div className="bg-ink text-paper rounded-card p-6">
         <div className="flex justify-between items-center mb-4 flex-wrap gap-4">
            <h2 className="font-serif text-2xl italic font-bold flex items-center gap-2">
               {/* On the inverted ink card the oxblood would go muddy, so the
                   AI sparkle keeps paper here. */}
               <Sparkles size={20} /> This Week's AI Priorities
            </h2>
            <button 
               type="button"
               onClick={() => fetchBrief(true)}
               disabled={isGeneratingBrief || !dashboardLoaded || Boolean(firestoreIssue) || contacts.length === 0 || outreaches.length === 0}
               aria-busy={isGeneratingBrief}
               className="flex min-h-11 items-center gap-2 bg-white/10 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest transition-colors hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:cursor-not-allowed disabled:opacity-50"
            >
               <RefreshCw size={12} className={isGeneratingBrief ? "animate-spin" : ""} />
               Refresh Brief
            </button>
         </div>
         
          {!dashboardLoaded ? (
             <p role="status" className="font-mono text-sm text-paper/75">Loading the activity needed for your brief…</p>
          ) : firestoreIssue ? (
             <p role="status" className="font-mono text-sm text-paper/75">The brief will return after the data connection is restored.</p>
          ) : isGeneratingBrief ? (
             <AISurface
               state="loading"
               emptyLine="No brief yet."
               loadingStages={[
                 'Reviewing relationship activity…',
                 'Grounding recommendations in saved records…',
                 'Drafting this week’s priorities…',
               ]}
               onCancel={cancelBrief}
               usageLabel="Reasoning tier"
               tone="inverted"
             />
          ) : briefError ? (
             <AISurface
               state="error"
               error={`${briefError} Your data is safe — this only affects the AI summary.`}
               onRetry={() => fetchBrief(true)}
               emptyLine="No brief yet."
               tone="inverted"
             />
         ) : aiBrief ? (
            <div className="font-mono text-sm leading-relaxed max-w-3xl animate-fade-in">
               <div className="markdown-body prose-invert prose-sm">
                 <Markdown>{aiBrief}</Markdown>
               </div>
               {briefGrounding && (
                 <div className="mt-4 rounded-card bg-white px-3 py-3 text-ink">
                   <AIProvenance
                     sourceIds={briefGrounding.usedSourceIds}
                     sourceLabels={briefGrounding.sourceLabels}
                     unsupportedAssumptions={briefGrounding.unsupportedAssumptions}
                     privacyExclusions={briefGrounding.privacyExclusions}
                     generatedAt={briefGrounding.generatedAt}
                     sourceObservedAt={briefGrounding.sourceObservedAt}
                     consideredSourceCount={briefGrounding.consideredSourceCount}
                     dataFreshThrough={briefGrounding.dataFreshThrough}
                     generation={briefGrounding.generation}
                   />
                 </div>
               )}
               <div className="mt-4 pt-4 border-t border-paper/20">
                  <Link to="/app/tracker" className="inline-flex items-center gap-2 text-xs uppercase tracking-widest font-bold text-paper/80 transition-colors hover:text-paper">
                     Open Tracker <ArrowRight size={14} />
                  </Link>
               </div>
            </div>
         ) : contacts.length === 0 ? (
            <div>
              <p className="font-mono text-sm text-paper/75">Your brief needs contact and activity evidence before it can make grounded recommendations.</p>
              <Link
                to="/app/directory"
                className="mt-4 inline-flex min-h-11 items-center gap-2 border border-paper/30 px-4 py-2 font-mono text-[10px] font-bold uppercase tracking-widest transition-colors hover:bg-white hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
              >
                Add your first contact <ArrowRight size={14} aria-hidden="true" />
              </Link>
            </div>
          ) : outreaches.length === 0 ? (
             <div>
               <p className="font-mono text-sm text-paper/75">Log outreach or a next action so the brief can point to real relationship evidence.</p>
               <Link
                 to={`/app/directory/${contacts[0].id}`}
                 className="mt-4 inline-flex min-h-11 items-center gap-2 border border-paper/30 px-4 py-2 font-mono text-[10px] font-bold uppercase tracking-widest transition-colors hover:bg-white hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
               >
                 Open {contacts[0].name || 'first contact'} <ArrowRight size={14} aria-hidden="true" />
               </Link>
             </div>
         ) : (
            <p role="status" className="font-mono text-sm text-paper/75">Preparing your brief…</p>
         )}
      </div>

      {/* Skimmable network rolodex */}
      <section aria-labelledby="network-rolodex-title">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="font-mono text-[9px] font-bold uppercase tracking-widest text-subtle">Relationship memory</p>
            <h2 id="network-rolodex-title" className="font-serif text-3xl font-bold italic">Network rolodex</h2>
          </div>
          <span className="font-mono text-[10px] uppercase tracking-widest text-subtle">
            {firestoreIssue
              ? 'Contacts unavailable'
              : dashboardLoaded
                ? `${contacts.length} active contact${contacts.length === 1 ? '' : 's'}`
                : 'Loading contacts'}
          </span>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {!dashboardLoaded ? (
           <div role="status" className="col-span-2 border border-dashed border-ink/20 bg-[#F8F5EF] p-10 text-center font-mono text-sm text-subtle">
             Loading your network…
           </div>
        ) : firestoreIssue ? null : contacts.length === 0 ? (
           <EmptyState
             icon={Users}
             eyebrow="Directory setup"
             title="Your relationship memory starts with one person."
             description="Add a contact, then capture context as the relationship develops. Their latest evidence will remain skimmable here."
             primaryAction={(
               <Link
                 to="/app/directory"
                 className="inline-flex min-h-11 items-center justify-center rounded-card bg-ink px-4 py-2 font-mono text-[10px] font-bold uppercase tracking-widest text-white transition-colors hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
               >
                 Add a contact
               </Link>
             )}
             className="col-span-2"
           />
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
      </section>

      {memoFor && user && memoFor.contactId && (
        <VoiceMemo
          uid={user.uid}
          contactId={memoFor.contactId}
          contactName={memoFor.contactName || 'this contact'}
          meetingTitle={memoFor.title}
          aiAllowed={contacts.some(
            (contact) =>
              contact.id === memoFor.contactId &&
              isContactAIEligible(
                managedContactFromRecord(contact.id, contact),
              ),
          )}
          onClose={() => setMemoFor(null)}
        />
      )}
    </div>
  );
}

function DashboardQueueMetric({ icon: Icon, label, value }: { icon: any, label: string, value: number | string }) {
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
