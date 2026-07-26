import React, { useRef, useState, useEffect } from 'react';
import { doc, getDoc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { db, handleFirestoreError } from '../config/firebase';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { getDocument } from 'pdfjs-dist';
// Set up PDF worker manually to avoid module issues in some Vite setups
import { GlobalWorkerOptions } from 'pdfjs-dist';
// @ts-ignore
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker?url';
GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

import { Upload } from 'lucide-react';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { AccentRule } from '../components/ui/AccentRule';
import { CardSetup } from '../components/card/CardSetup';
import { ConnectionRow, ConnectionsHeader } from '../components/settings/Connections';
import { useCalendarEvents } from '../hooks/useCalendarEvents';

type Tab = 'profile' | 'connections';

export default function Settings() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [profile, setProfile] = useState<any>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [resumeFile, setResumeFile] = useState<File | null>(null);
  const [isParsingPdf, setIsParsingPdf] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [tab, setTab] = useState<Tab>('profile');

  // Calendar drives the Event Mode suggestion inside CardSetup.
  const { events } = useCalendarEvents(user?.uid);

  useEffect(() => {
    if (!user) return;
    const fetchProfile = async () => {
      try {
        const docSnap = await getDoc(doc(db, `users/${user.uid}`));
        if (docSnap.exists()) {
           setProfile(docSnap.data());
        } else {
           setProfile({ name: '', role: '', company: '', bio: '', resumeText: '' });
        }
      } catch (err: any) {
        handleFirestoreError(err, 'get', `users/${user.uid}`);
      }
    };
    fetchProfile();
  }, [user]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !profile) return;
    setIsSaving(true);

    try {
       await updateDoc(doc(db, `users/${user.uid}`), {
          ...profile,
          updatedAt: serverTimestamp()
       });
       toast('Settings saved.', 'success');
    } catch (err: any) {
       handleFirestoreError(err, 'update', `users/${user.uid}`);
    } finally {
       setIsSaving(false);
    }
  };

  const handlePdfUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.type !== 'application/pdf') {
       toast('That needs to be a PDF.', 'error');
       return;
    }

    setResumeFile(file);
    setIsParsingPdf(true);

    try {
       const arrayBuffer = await file.arrayBuffer();
       const pdf = await getDocument(arrayBuffer).promise;
       let text = '';
       for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const content = await page.getTextContent();
          const strings = content.items.map((item: any) => item.str);
          text += strings.join(' ') + '\\n';
       }
       setProfile(prev => ({ ...prev, resumeText: text }));
       toast('Resume parsed. The AI has your history now.', 'success');
    } catch (err) {
       console.error("PDF parse error", err);
       toast('Could not read that PDF. Try another file.', 'error');
    } finally {
       setIsParsingPdf(false);
    }
  };

  if (!profile) return <div className="font-mono text-xs uppercase tracking-widest text-muted">Loading…</div>;

  const tabs: { id: Tab; label: string }[] = [
    { id: 'profile', label: 'Profile' },
    { id: 'connections', label: 'Connections' },
  ];

  return (
    <div className="space-y-8">
      <div className="pb-6 border-b border-ink/20">
        <AccentRule className="mb-4" />
        <h1 className="font-serif text-5xl italic font-black mb-2">Settings & Profile.</h1>
        <p className="font-mono text-xs uppercase tracking-widest text-muted">Set your context to generate better AI outreach drafts.</p>
      </div>

      <div className="flex gap-1 border-b border-ink/15" role="tablist">
        {tabs.map((item) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={tab === item.id}
            onClick={() => setTab(item.id)}
            className={`-mb-px border-b-2 px-4 py-2.5 font-mono text-[10px] font-bold uppercase tracking-widest transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-paper ${
              tab === item.id
                ? 'border-brand text-ink'
                : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === 'profile' && (
        <div className="animate-fade-in bg-white border border-ink/15 rounded-card p-8 flex-1 max-w-4xl">
          <form onSubmit={handleSave} className="space-y-6 font-mono text-sm">
             <div className="grid grid-cols-2 gap-4">
               <div className="col-span-2">
                   <label className="text-xs uppercase tracking-widest text-subtle block mb-1">Your Name</label>
                   <Input value={profile.name || ''} onChange={e => setProfile({...profile, name: e.target.value})} />
               </div>
               <div>
                   <label className="text-xs uppercase tracking-widest text-subtle block mb-1">Current Role</label>
                   <Input value={profile.role || ''} onChange={e => setProfile({...profile, role: e.target.value})} />
               </div>
               <div>
                   <label className="text-xs uppercase tracking-widest text-subtle block mb-1">Company</label>
                   <Input value={profile.company || ''} onChange={e => setProfile({...profile, company: e.target.value})} />
               </div>
               <div className="col-span-2">
                   <label className="text-xs uppercase tracking-widest text-subtle block mb-1">Bio / Career Goals</label>
                   {/* Focus treatment matches the Input primitive (brand ring)
                       rather than the ink ring this textarea used to carry —
                       two focus styles on one form read as an oversight. */}
                   <textarea
                      className="w-full h-32 border border-ink/15 rounded-card p-3 font-mono text-sm bg-paper/50 transition-colors focus-visible:outline-none focus-visible:border-brand/40 focus-visible:ring-2 focus-visible:ring-brand/30"
                      value={profile.bio || ''}
                      onChange={e => setProfile({...profile, bio: e.target.value})}
                   />
               </div>
             </div>

             <div className="border-t border-ink/20 pt-6">
                <h3 className="font-serif text-2xl italic font-bold mb-4">Resume Context</h3>
                <p className="text-subtle mb-4">Upload your resume. We extract the text so the AI knows your history when drafting emails.</p>

                <div className="flex items-center gap-4">
                   <input
                      ref={fileInputRef}
                      type="file"
                      accept="application/pdf"
                      onChange={handlePdfUpload}
                      className="hidden"
                      disabled={isParsingPdf}
                   />
                   <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={isParsingPdf}
                      className="flex items-center gap-2 border border-ink/15 rounded-card px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest font-bold hover:bg-ink hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-white"
                   >
                      <Upload size={14} />
                      {isParsingPdf ? 'Parsing…' : resumeFile ? 'Replace PDF' : 'Choose PDF'}
                   </button>
                   {resumeFile && !isParsingPdf && (
                      <span className="text-xs text-muted truncate max-w-xs">{resumeFile.name}</span>
                   )}
                </div>

                {profile.resumeText && (
                   <div className="mt-4 animate-fade-slide-up">
                      <label className="text-xs uppercase tracking-widest text-subtle block mb-1">Parsed Resume Text (Editable)</label>
                      <textarea
                        className="w-full h-64 border border-ink/15 rounded-card p-3 font-mono text-sm bg-paper/50 text-subtle"
                        value={profile.resumeText}
                        onChange={e => setProfile({...profile, resumeText: e.target.value})}
                      />
                   </div>
                )}
             </div>

             <div className="border-t border-ink/20 pt-6 flex justify-end">
               <Button type="submit" variant="brand" disabled={isSaving}>{isSaving ? 'Saving…' : 'Save Settings'}</Button>
             </div>
          </form>
        </div>
      )}

      {tab === 'connections' && user && (
        <div className="animate-fade-in max-w-4xl space-y-6">
          <ConnectionsHeader />

          <section className="rounded-card border border-ink/15 bg-white p-8">
            <h3 className="font-serif text-2xl italic font-bold">Your card.</h3>
            <p className="mt-1.5 mb-6 font-mono text-[11px] uppercase tracking-widest text-muted">
              Tap, scan or send — same page either way
            </p>
            <CardSetup
              uid={user.uid}
              profile={profile}
              events={events}
              onPublished={(cardId, config) =>
                setProfile((prev: any) => ({ ...prev, cardId, card: config }))
              }
            />
          </section>

          <section className="space-y-3">
            <h3 className="font-serif text-2xl italic font-bold">External accounts.</h3>
            <ConnectionRow provider="calendar" uid={user.uid} email={user.email} />
            <ConnectionRow provider="gmail" uid={user.uid} email={user.email} />
            <p className="font-mono text-[11px] leading-relaxed text-muted">
              Preview mode runs on sample data so every screen is demoable without a Google Cloud
              project. MANUAL_SETUP.md at the repo root has the steps to go live.
            </p>
          </section>
        </div>
      )}
    </div>
  );
}
