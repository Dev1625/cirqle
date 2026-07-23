import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { doc, onSnapshot, updateDoc, collection, query, addDoc, serverTimestamp, getDoc, where, getDocs, limit, orderBy } from 'firebase/firestore';
import { db, handleFirestoreError } from '../config/firebase';
import { useAuth } from '../contexts/AuthContext';
import { Button } from '../components/ui/Button';
import { TierBadge } from '../components/ui/TierBadge';
import { Sparkles, ArrowLeft, Send, Calendar, MessageSquare, Tag } from 'lucide-react';
import { getGemini } from '../lib/gemini';
import { Input } from '../components/ui/Input';
import Markdown from 'react-markdown';
import { useToast } from '../contexts/ToastContext';

export default function ContactDetail() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [contact, setContact] = useState<any>(null);
  const [notes, setNotes] = useState<any[]>([]);
  const [outreaches, setOutreaches] = useState<any[]>([]);
  
  // Note/Action Tab State
  const [activeTab, setActiveTab] = useState<'note' | 'meeting' | 'reply' | 'parse'>('note');
  
  // Tab-specific form states
  const [newNote, setNewNote] = useState('');
  const [meetingData, setMeetingData] = useState({ date: new Date().toISOString().split('T')[0], discussed: '', promised: '', nextSteps: '', followupDate: '' });
  const [replyText, setReplyText] = useState('');
  const [conversationLog, setConversationLog] = useState('');
  
  const [isProcessing, setIsProcessing] = useState(false);
  
  // Drafting Outreach State
  const [isDrafting, setIsDrafting] = useState(false);
  const [draftQuestions, setDraftQuestions] = useState<string[]>([]);
  const [draftAnswers, setDraftAnswers] = useState<Record<string, string>>({});
  const [currentDraft, setCurrentDraft] = useState<{subject: string, body: string} | null>(null);

  useEffect(() => {
    if (!user || !id) return;
    const unsub = onSnapshot(doc(db, `users/${user.uid}/contacts/${id}`), (docSnap) => {
      if (docSnap.exists()) {
        setContact({ id: docSnap.id, ...docSnap.data() });
      } else {
        navigate('/app/directory');
      }
    }, (error) => handleFirestoreError(error, 'get', `users/${user.uid}/contacts/${id}`));

    const q = query(collection(db, `users/${user.uid}/notes`), where('userId', '==', user.uid));
    const unsubNotes = onSnapshot(q, (snapshot) => {
      const allNotes = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
      const myNotes = allNotes.filter((n: any) => n.contactId === id).sort((a: any, b: any) => b.createdAt?.toMillis() - a.createdAt?.toMillis());
      setNotes(myNotes);
    }, (error) => handleFirestoreError(error, 'list', `users/${user.uid}/notes`));

    const qOutreaches = query(collection(db, `users/${user.uid}/outreaches`), where('userId', '==', user.uid));
    const unsubOutreaches = onSnapshot(qOutreaches, (snapshot) => {
      const allOutreaches = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
      const myOutreaches = allOutreaches.filter((o: any) => o.contactId === id).sort((a: any, b: any) => (b.sentAt?.toMillis() || b.updatedAt?.toMillis() || 0) - (a.sentAt?.toMillis() || a.updatedAt?.toMillis() || 0));
      setOutreaches(myOutreaches);
    }, (error) => handleFirestoreError(error, 'list', `users/${user.uid}/outreaches`));

    return () => { unsub(); unsubNotes(); unsubOutreaches(); };
  }, [user, id, navigate]);

  useEffect(() => {
    if (!isDrafting) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setIsDrafting(false); setCurrentDraft(null); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isDrafting]);

  const handleAddNote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !id || !newNote.trim()) return;
    try {
      await addDoc(collection(db, `users/${user.uid}/notes`), {
        userId: user.uid,
        contactId: id,
        content: newNote.trim(),
        createdAt: serverTimestamp()
      });
      setNewNote('');
    } catch (err: any) {
       handleFirestoreError(err, 'create', `users/${user.uid}/notes`);
    }
  };

  const handleLogMeeting = async (e: React.FormEvent) => {
     e.preventDefault();
     if (!user || !id) return;
     try {
       const content = `**Meeting on ${meetingData.date}**\n- **Discussed:** ${meetingData.discussed}\n- **Promised:** ${meetingData.promised}\n- **Next Steps:** ${meetingData.nextSteps}`;
       await addDoc(collection(db, `users/${user.uid}/notes`), {
         userId: user.uid,
         contactId: id,
         content,
         createdAt: serverTimestamp()
       });

       if (meetingData.followupDate) {
         // Create a pending outreach to show up on the calendar
         await addDoc(collection(db, `users/${user.uid}/outreaches`), {
           userId: user.uid,
           contactId: id,
           type: 'Follow-up',
           subject: 'Scheduled Follow-up',
           status: 'Pending Follow-Up',
           nextFollowUpDate: new Date(meetingData.followupDate),
           sentAt: serverTimestamp(), // Requires timestamp
           updatedAt: serverTimestamp(),
           channel: null,
           responseReceived: null,
           dateOfResponse: null,
           meetingHeld: null,
           meetingDate: null,
           nextAction: null,
           referralGenerated: null,
           applicationLinked: null,
           notes: null,
           aiSummary: null
         });
       }

       setMeetingData({ date: new Date().toISOString().split('T')[0], discussed: '', promised: '', nextSteps: '', followupDate: '' });
       setActiveTab('note');
     } catch(err: any) {
       handleFirestoreError(err, 'create', `users/${user.uid}/notes`);
     }
  };

  const handleProcessReply = async (e: React.FormEvent) => {
     e.preventDefault();
     if (!user || !id || !replyText) return;
     setIsProcessing(true);
     try {
        const ai = getGemini();
        const prompt = `Analyze this email/message reply from ${contact.name}:\n\n"${replyText}"\n\nProvide a very short 1-2 sentence summary of what they said. Identify if a follow-up is needed and what we should do next. Return JSON EXACTLY like this: {"summary": "Brief summary", "suggestedAction": "Suggested next step"}`;
        
        const response = await ai.models.generateContent({
           model: "gemini-3-flash-preview",
           contents: prompt,
           config: { responseMimeType: "application/json" }
        });
        const parsed = JSON.parse(response.text || "{}");
        const content = `**Reply Received:** ${parsed.summary}\n**AI Suggestion:** ${parsed.suggestedAction}\n\n*Original:* "${replyText.substring(0, 150)}${replyText.length > 150 ? '...' : ''}"`;
        
        await addDoc(collection(db, `users/${user.uid}/notes`), {
          userId: user.uid,
          contactId: id,
          content,
          createdAt: serverTimestamp()
        });

        // Try to update latest outreach status
        const qOutreach = query(collection(db, `users/${user.uid}/outreaches`), where('userId', '==', user.uid));
        const outSnap = await getDocs(qOutreach);
        const myOutreaches = outSnap.docs.map(d => ({id: d.id, ...d.data() as any})).filter(o => o.contactId === id).sort((a,b) => b.sentAt?.toMillis() - a.sentAt?.toMillis());
        if (myOutreaches.length > 0 && myOutreaches[0].status === 'Sent') {
           await updateDoc(doc(db, `users/${user.uid}/outreaches/${myOutreaches[0].id}`), {
              status: 'Responded',
              updatedAt: serverTimestamp()
           });
        }

        setReplyText('');
        setActiveTab('note');
     } catch (err: any) {
        console.error(err);
        toast("Failed to process that reply. Please try again.", 'error');
     } finally {
        setIsProcessing(false);
     }
  };

  const handleParseConversation = async (e: React.FormEvent) => {
     e.preventDefault();
     if (!user || !id || !conversationLog) return;
     setIsProcessing(true);
     try {
        const ai = getGemini();
        const prompt = `Analyze the following conversation notes/log with ${contact.name}:\n\n"${conversationLog}"\n\nExtract key life events, facts, or things they mentioned (e.g., "Moving to NY", "Looking for hires", "Launching a podcast"). Return them as an array of short tag strings. Return JSON EXACTLY like this: {"tags": ["Mentioned: Moving cities", "Mentioned: Hiring engineers"]}`;
        
        const response = await ai.models.generateContent({
           model: "gemini-2.5-flash-lite",
           contents: prompt,
           config: { responseMimeType: "application/json" }
        });
        const parsed = JSON.parse(response.text || "{}");
        const newTags = parsed.tags || [];

        if (newTags.length > 0) {
           const existingTags = contact.tags || [];
           const mergedTags = Array.from(new Set([...existingTags, ...newTags])).slice(0, 50); // Keep max 50 according to rules
           
           await updateDoc(doc(db, `users/${user.uid}/contacts/${id}`), {
              tags: mergedTags,
              updatedAt: serverTimestamp()
           });

           await addDoc(collection(db, `users/${user.uid}/notes`), {
             userId: user.uid,
             contactId: id,
             content: `**AI extracted tags from conversation:** ${newTags.join(', ')}`,
             createdAt: serverTimestamp()
           });
        }
        
        setConversationLog('');
        setActiveTab('note');
     } catch (err) {
        console.error(err);
        toast("Failed to extract tags from that conversation. Please try again.", 'error');
     } finally {
        setIsProcessing(false);
     }
  };

  const startDrafting = async () => {
    setIsDrafting(true);
    setDraftQuestions([
      "What is the main goal of this message?",
      "Is there a specific 'ask'?",
      "Do you want to mention any recent news or context?",
      "What tone should it have? (e.g. warm, brief, professional)"
    ]);
  };

  const generateDraft = async () => {
    if (!user || !contact) return;
    setIsProcessing(true);
    try {
      // Get user profile for extra context
      const profSnap = await getDoc(doc(db, `users/${user.uid}`));
      const profile = profSnap.data() || {};
      
      const ai = getGemini();
      const prompt = `You are an expert executive assistant drafting an email.
Write a personalized email to ${contact.name}.
Their Role: ${contact.role} at ${contact.company}
Their Context: ${contact.summary}
Tags: ${contact.tags?.join(',')}

My Profile:
Name: ${profile.name || 'Your Name'}
Role: ${profile.role || ''}
Bio/Goals: ${profile.bio || ''}

Message Context (Answers to clarifying questions):
1. Goal: ${draftAnswers[0] || 'Informational interview'}
2. Specific Ask: ${draftAnswers[1] || 'None'}
3. Recent Context: ${draftAnswers[2] || 'None'}
4. Tone: ${draftAnswers[3] || 'Professional'}

Notes & Memory (Pay special attention to previous meeting summaries, 'They mentioned' tags, and past replies!):
${notes.slice(0,10).map(n => n.content).join('\n')}

Based on this, generate a highly personalized, compelling email.
Reference past discussions if relevant.
Return the result in JSON format EXACTLY like this:
{
  "subject": "The suggested subject line",
  "body": "The full email body"
}`;

      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: prompt,
        config: { responseMimeType: "application/json" }
      });
      
      const parsed = JSON.parse(response.text || "{}");
      setCurrentDraft(parsed);
    } catch (err) {
      console.error(err);
      toast("Failed to generate the draft. Please try again.", 'error');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleSendDraft = async () => {
    if (!currentDraft || !contact || !user) return;
    
    const mailto = `mailto:${contact.email || ''}?subject=${encodeURIComponent(currentDraft.subject)}&body=${encodeURIComponent(currentDraft.body)}`;
    window.location.href = mailto;
    
    // Log in tracker
    try {
       await addDoc(collection(db, `users/${user.uid}/outreaches`), {
         userId: user.uid,
         contactId: id,
         type: 'Email',
         channel: 'Email',
         subject: currentDraft.subject || '',
         status: 'Sent',
         nextFollowUpDate: null, 
         responseReceived: 'No',
         dateOfResponse: null,
         meetingHeld: false,
         meetingDate: null,
         nextAction: null,
         referralGenerated: false,
         applicationLinked: null,
         notes: null,
         aiSummary: "Sent initial outreach email",
         sentAt: serverTimestamp(),
         updatedAt: serverTimestamp()
       });
       // Close modal
       setIsDrafting(false);
       setCurrentDraft(null);
    } catch (err: any) {
       handleFirestoreError(err, 'create', `users/${user.uid}/outreaches`);
    }
  };

  if (!contact) return <div className="font-mono p-8">Loading...</div>;

  return (
    <div className="space-y-6 pb-12">
      <div className="flex items-center gap-4 mb-2">
         <button onClick={() => navigate('/app/directory')} className="p-2 hover:bg-ink/10 rounded-full transition-colors flex items-center justify-center">
            <ArrowLeft size={16} />
         </button>
         <h1 className="font-serif text-5xl italic font-black">{contact.name}</h1>
      </div>
      
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
         {/* Details Panel */}
         <div className="xl:col-span-1 space-y-6">
           <div className="bg-white border border-ink p-8">
             <div className="flex justify-between items-start mb-6">
               <div>
                 <p className="font-mono text-lg">{contact.role}</p>
                 <p className="font-mono text-subtle">{contact.company} • {contact.location}</p>
               </div>
             </div>
             
             <div className="flex flex-col gap-2 mb-6">
                <div className="flex items-center gap-2 w-fit">
                  <TierBadge tier={contact.relationshipTier} />
                  <span className="text-xs font-mono text-subtle uppercase tracking-widest">connection</span>
                </div>
                {contact.email && <span className="text-sm font-mono text-subtle">{contact.email}</span>}
             </div>
             
             {contact.summary && (
               <div className="mb-6">
                 <h4 className="text-xs uppercase font-mono tracking-widest text-subtle mb-2">Context</h4>
                 <p className="font-mono text-sm leading-relaxed">{contact.summary}</p>
               </div>
             )}
             
             <div className="flex flex-wrap gap-2 mb-6">
                {contact.tags?.map((t: string) => (
                  <span key={t} className="px-3 py-1 bg-accent/50 border border-ink/20 font-mono text-[10px] tracking-widest uppercase">{t}</span>
                ))}
             </div>
             
             <div className="pt-6 border-t border-ink/20 flex flex-col gap-3">
               <Button onClick={startDrafting} className="tour-draft-btn gap-2 w-full justify-center"><Sparkles size={16} /> Draft Outreach AI</Button>
               {contact.linkedinUrl && (
                  <Button variant="outline" className="w-full justify-center" asChild>
                    <a href={contact.linkedinUrl} target="_blank" rel="noreferrer">LinkedIn Profile</a>
                  </Button>
               )}
             </div>
           </div>
         </div>
         
         {/* Outreach Tracker & Notes */}
         <div className="xl:col-span-2">
            <div className="bg-white border border-ink">
               <div className="border-b border-ink/20 flex divide-x divide-ink/20 bg-paper/30 font-mono text-[10px] uppercase tracking-widest font-bold">
                 <button onClick={() => setActiveTab('note')} className={`flex-1 py-3 hover:bg-paper transition-colors ${activeTab === 'note' ? 'bg-white border-b-2 border-b-ink' : ''}`}>Quick Note</button>
                 <button onClick={() => setActiveTab('meeting')} className={`flex flex-1 items-center justify-center gap-1 py-3 hover:bg-paper transition-colors ${activeTab === 'meeting' ? 'bg-white border-b-2 border-b-ink' : ''}`}><Calendar size={12}/> Log Meeting</button>
                 <button onClick={() => setActiveTab('reply')} className={`tour-reply-tab flex flex-1 items-center justify-center gap-1 py-3 hover:bg-paper transition-colors ${activeTab === 'reply' ? 'bg-white border-b-2 border-b-ink' : ''}`}><MessageSquare size={12}/> Process Reply <Sparkles size={10}/></button>
                 <button onClick={() => setActiveTab('parse')} className={`flex flex-1 items-center justify-center gap-1 py-3 hover:bg-paper transition-colors ${activeTab === 'parse' ? 'bg-white border-b-2 border-b-ink' : ''}`}><Tag size={12}/> Add AI Tags <Sparkles size={10}/></button>
               </div>
               
               <div className="p-6 border-b border-ink/20 bg-white">
                 {/* Quick Note */}
                 {activeTab === 'note' && (
                   <form onSubmit={handleAddNote} className="flex gap-2">
                     <Input 
                       placeholder="Log a quick thought or action..." 
                       value={newNote}
                       onChange={e => setNewNote(e.target.value)}
                       className="flex-1"
                     />
                     <Button type="submit">Save</Button>
                   </form>
                 )}

                 {/* Log Meeting Component */}
                 {activeTab === 'meeting' && (
                   <form onSubmit={handleLogMeeting} className="space-y-4 font-mono text-sm">
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="block text-[10px] uppercase tracking-widest text-subtle mb-1">Date</label>
                          <Input type="date" required value={meetingData.date} onChange={e => setMeetingData({...meetingData, date: e.target.value})} />
                        </div>
                        <div>
                          <label className="block text-[10px] uppercase tracking-widest text-subtle mb-1">Schedule Follow-up (optional)</label>
                          <Input type="date" value={meetingData.followupDate} onChange={e => setMeetingData({...meetingData, followupDate: e.target.value})} />
                        </div>
                        <div className="col-span-2">
                          <label className="block text-[10px] uppercase tracking-widest text-subtle mb-1">What was discussed?</label>
                          <textarea required className="w-full h-20 border border-ink p-3 bg-paper/50 focus:outline-none focus:ring-1 focus:ring-ink" value={meetingData.discussed} onChange={e => setMeetingData({...meetingData, discussed: e.target.value})}></textarea>
                        </div>
                        <div className="col-span-2 md:col-span-1">
                          <label className="block text-[10px] uppercase tracking-widest text-subtle mb-1">What was promised / Action items?</label>
                          <textarea className="w-full h-16 border border-ink p-3 bg-paper/50 focus:outline-none focus:ring-1 focus:ring-ink" value={meetingData.promised} onChange={e => setMeetingData({...meetingData, promised: e.target.value})}></textarea>
                        </div>
                        <div className="col-span-2 md:col-span-1">
                          <label className="block text-[10px] uppercase tracking-widest text-subtle mb-1">Next Steps for AI</label>
                          <textarea className="w-full h-16 border border-ink p-3 bg-paper/50 focus:outline-none focus:ring-1 focus:ring-ink" value={meetingData.nextSteps} onChange={e => setMeetingData({...meetingData, nextSteps: e.target.value})}></textarea>
                        </div>
                      </div>
                      <div className="flex justify-end pt-2">
                        <Button type="submit">Log Meeting Memory</Button>
                      </div>
                   </form>
                 )}

                 {/* Process Reply Component */}
                 {activeTab === 'reply' && (
                   <form onSubmit={handleProcessReply} className="space-y-4">
                      <p className="font-mono text-xs text-subtle">Paste the unstructured email or message reply. The AI will summarize it, update context, and track the outreach as responded.</p>
                      <textarea required className="w-full h-32 border border-ink p-3 font-mono text-sm bg-paper/50 focus:outline-none focus:ring-1 focus:ring-ink" placeholder="Hi there, thanks for reaching out. Let's chat next week..." value={replyText} onChange={e => setReplyText(e.target.value)}></textarea>
                      <div className="flex justify-end pt-2">
                        <Button type="submit" disabled={isProcessing} className="gap-2">
                          {isProcessing ? 'Processing AI...' : 'Process Reply'} <Sparkles size={14}/>
                        </Button>
                      </div>
                   </form>
                 )}

                 {/* Parse AI Tags Component */}
                 {activeTab === 'parse' && (
                   <form onSubmit={handleParseConversation} className="space-y-4">
                      <p className="font-mono text-xs text-subtle">Paste conversation notes or a raw transcript. The AI will extract "They Mentioned" structured tags like events, hiring, or personal news and attach to their profile context.</p>
                      <textarea required className="w-full h-32 border border-ink p-3 font-mono text-sm bg-paper/50 focus:outline-none focus:ring-1 focus:ring-ink" placeholder="Spoke to them. They mentioned they are moving to NY next month and will be looking for full-stack hires in Q3..." value={conversationLog} onChange={e => setConversationLog(e.target.value)}></textarea>
                      <div className="flex justify-end pt-2">
                        <Button type="submit" disabled={isProcessing} className="gap-2">
                          {isProcessing ? 'Extracting...' : 'Extract Tags'} <Sparkles size={14}/>
                        </Button>
                      </div>
                   </form>
                 )}
               </div>
               
               <div className="divide-y divide-ink/10 bg-[#FAFAFA]">
                 <div className="p-4 bg-paper/50 flex gap-4 border-b border-ink/20">
                    <h3 className="font-serif font-bold italic text-xl">Timeline</h3>
                 </div>
                 
                 <div className="p-0">
                   {/* Combined timeline of outreaches and notes */}
                   {[...notes.map(n => ({...n, _type: 'note', _time: n.createdAt?.toMillis() || 0})), 
                     ...outreaches.map(o => ({...o, _type: 'outreach', _time: o.sentAt?.toMillis() || o.updatedAt?.toMillis() || 0}))]
                     .sort((a,b) => b._time - a._time)
                     .map((item: any) => (
                       <div key={item.id} className="p-6 font-mono text-sm border-b border-ink/10 last:border-0 relative">
                          <p className="text-[10px] uppercase tracking-widest text-subtle mb-3">
                             {new Date(item._time).toLocaleDateString()} {new Date(item._time).toLocaleTimeString()}
                          </p>
                          
                          {item._type === 'note' ? (
                             <div className="markdown-body prose-sm font-mono leading-relaxed whitespace-pre-wrap pl-4 border-l-2 border-ink/20">
                               <Markdown>{item.content}</Markdown>
                             </div>
                          ) : (
                             <div className="bg-white border border-ink/10 p-4 pl-4 border-l-4 border-l-ink">
                               <div className="flex justify-between items-start mb-2">
                                  <div className="font-bold flex items-center gap-2">
                                    <Send size={14} className="text-subtle" />
                                    {item.type} Outreach
                                    <span className="bg-accent/30 text-ink px-2 py-0.5 text-[10px] uppercase tracking-widest ml-2">
                                      {item.status}
                                    </span>
                                  </div>
                               </div>
                               {item.subject && <p className="text-subtle italic mb-2">"{item.subject}"</p>}
                               {item.aiSummary && (
                                  <div className="markdown-body prose-sm font-mono leading-relaxed mt-2 text-ink/80">
                                     <Markdown>{item.aiSummary}</Markdown>
                                  </div>
                               )}
                               {item.nextAction && (
                                  <div className="mt-3 bg-paper p-2 border border-ink/10 text-xs flex items-start gap-2">
                                     <span className="font-bold uppercase tracking-widest text-[9px] text-orange-600 mt-0.5">Action Item:</span>
                                     <span>{item.nextAction}</span>
                                  </div>
                               )}
                               {item.nextFollowUpDate && (
                                  <div className="mt-2 text-[10px] text-subtle flex items-center gap-1">
                                     <Calendar size={10} /> Follow up scheduled: {item.nextFollowUpDate.toDate().toLocaleDateString()}
                                  </div>
                               )}
                             </div>
                          )}
                       </div>
                   ))}
                   
                   {notes.length === 0 && outreaches.length === 0 && (
                     <div className="p-8 font-mono text-sm text-subtle text-center">No timeline events yet.</div>
                   )}
                 </div>
               </div>
            </div>
         </div>
      </div>

      {/* Drafting Modal overlay */}
      {isDrafting && (
         <div
           className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-ink/30 backdrop-blur-sm animate-fade-in"
           onClick={(e) => { if (e.target === e.currentTarget) { setIsDrafting(false); setCurrentDraft(null); } }}
         >
            <div className="animate-fade-scale-in bg-white border border-ink w-full max-w-2xl max-h-[90vh] flex flex-col shadow-[16px_16px_0px_0px_rgba(26,26,26,1)]">
               <div className="p-6 border-b border-ink/20 flex justify-between items-center bg-paper/50">
                  <h2 className="font-serif text-2xl flex items-center gap-2"><Sparkles size={24} /> AI Outreach Draft</h2>
                  <button onClick={() => { setIsDrafting(false); setCurrentDraft(null); }} className="text-xl font-bold font-mono hover:text-red-500 transition-colors">×</button>
               </div>
               
               <div className="p-6 overflow-y-auto flex-1 font-mono text-sm">
                  {!currentDraft ? (
                    <div className="space-y-6">
                       <p className="text-subtle mb-4">Let's craft the perfect context-aware outreach. AI will automatically reference past logged meetings and updates.</p>
                       {draftQuestions.map((q, i) => (
                         <div key={i}>
                           <label className="block mb-2 font-bold">{q}</label>
                           <Input 
                             value={draftAnswers[i] || ''}
                             onChange={(e) => setDraftAnswers({...draftAnswers, [i]: e.target.value})}
                             placeholder="Your answer..."
                           />
                         </div>
                       ))}
                       <div className="pt-4 text-right">
                         <Button onClick={generateDraft} disabled={isProcessing} className="gap-2 bg-ink text-paper">
                           {isProcessing ? 'Drafting...' : 'Generate Email'} <Sparkles size={16} />
                         </Button>
                       </div>
                    </div>
                  ) : (
                    <div className="space-y-4">
                       <div>
                         <label className="text-[10px] uppercase tracking-widest text-subtle block mb-1">Subject</label>
                         <Input 
                           value={currentDraft.subject} 
                           onChange={(e) => setCurrentDraft({...currentDraft, subject: e.target.value})} 
                         />
                       </div>
                       <div>
                         <label className="text-[10px] uppercase tracking-widest text-subtle block mb-1">Body</label>
                         <textarea 
                           className="w-full h-64 border border-ink p-3 font-mono text-sm bg-paper/50 focus:outline-none focus:ring-1 focus:ring-ink"
                           value={currentDraft.body}
                           onChange={(e) => setCurrentDraft({...currentDraft, body: e.target.value})}
                         />
                       </div>
                       <div className="flex justify-end gap-4 pt-4 border-t border-ink/20">
                          <Button variant="outline" onClick={() => setCurrentDraft(null)}>Back to Prompts</Button>
                          <Button onClick={handleSendDraft} className="gap-2"><Send size={16} /> Open in Mail Client</Button>
                       </div>
                    </div>
                  )}
               </div>
            </div>
         </div>
      )}
    </div>
  );
}
