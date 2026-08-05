import React, { useCallback, useRef, useState, useEffect } from 'react';
import { useSearchParams } from 'react-router';
import { doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore';
import { db } from '../config/firebase';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';

import { Upload } from 'lucide-react';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { AccentRule } from '../components/ui/AccentRule';
import { CardSetup } from '../components/card/CardSetup';
import { ConnectionRow, ConnectionsHeader } from '../components/settings/Connections';
import { AccountSecurityPanel } from '../components/settings/AccountSecurityPanel';
import { PersistedSourcePrivacyControls } from '../components/settings/SourcePrivacyControls';
import { EmailVerificationGate } from '../components/auth/EmailVerificationGate';
import { useCalendarEvents } from '../hooks/useCalendarEvents';
import { moveTabIndex } from '../lib/commandPalette';
import { ensureVerifiedUserProfile } from '../lib/userBootstrap';
import {
  extractResumePDF,
  ResumePDFError,
} from '../lib/pdfResume';

type Tab = 'profile' | 'connections' | 'privacy' | 'account';

export default function Settings() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [searchParams] = useSearchParams();
  const [profile, setProfile] = useState<any>(null);
  const [profileState, setProfileState] = useState<
    'loading' | 'error' | 'ready'
  >('loading');
  const [saveFeedback, setSaveFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [resumeFile, setResumeFile] = useState<File | null>(null);
  const [isParsingPdf, setIsParsingPdf] = useState(false);
  const [connectionRevision, setConnectionRevision] = useState(0);
  const [pdfProgress, setPdfProgress] = useState<string | null>(null);
  const pdfAbortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [tab, setTab] = useState<Tab>(() =>
    searchParams.has('verification') || searchParams.has('verified')
      ? 'account'
      : 'profile',
  );

  // Calendar drives the Event Mode suggestion inside CardSetup.
  const { events } = useCalendarEvents(user?.uid);

  useEffect(
    () => () => {
      pdfAbortRef.current?.abort();
    },
    [],
  );

  const fetchProfile = useCallback(async () => {
    if (!user) return;
    setProfileState('loading');
    try {
      const docSnap = await getDoc(doc(db, `users/${user.uid}`));
      setProfile(
        docSnap.exists()
          ? docSnap.data()
          : { name: '', role: '', company: '', bio: '', resumeText: '' },
      );
      setProfileState('ready');
    } catch {
      console.warn('[settings] profile temporarily unavailable');
      setProfileState('error');
    }
  }, [user]);

  useEffect(() => {
    void fetchProfile();
  }, [fetchProfile]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !profile) return;
    setIsSaving(true);
    setSaveFeedback(null);

    try {
       await ensureVerifiedUserProfile(user);
       await setDoc(doc(db, `users/${user.uid}`), {
          ...profile,
          userId: user.uid,
          updatedAt: serverTimestamp()
       }, { merge: true });
       toast('Settings saved.', 'success');
       setSaveFeedback({
         type: 'success',
         message: 'Profile changes saved.',
       });
    } catch {
       console.warn('[settings] profile save failed');
       const message =
         'Profile changes could not be saved. Your edits are still here; check your connection and try again.';
       setSaveFeedback({ type: 'error', message });
       toast(message, 'error');
    } finally {
       setIsSaving(false);
    }
  };

  const handlePdfUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setResumeFile(file);
    setIsParsingPdf(true);
    setPdfProgress('Checking PDF…');
    pdfAbortRef.current?.abort();
    const controller = new AbortController();
    pdfAbortRef.current = controller;

    try {
       const text = await extractResumePDF(file, {
         signal: controller.signal,
         onProgress(page, total) {
           setPdfProgress(`Reading page ${page} of ${total}…`);
         },
       });
       setProfile(prev => ({ ...prev, resumeText: text }));
       toast('Resume text extracted. Review it below, then save Settings.', 'success');
    } catch (error) {
       const message =
         error instanceof ResumePDFError
           ? error.message
           : 'That PDF could not be read. Your existing resume text is unchanged.';
       toast(
         `${message} Your existing resume text is unchanged.`,
         error instanceof ResumePDFError && error.code === 'cancelled'
           ? 'info'
           : 'error',
       );
       if (error instanceof ResumePDFError && error.code === 'not-pdf') {
         e.target.value = '';
         setResumeFile(null);
       }
    } finally {
       if (pdfAbortRef.current === controller) {
         pdfAbortRef.current = null;
         setIsParsingPdf(false);
         setPdfProgress(null);
       }
    }
  };

  if (profileState === 'loading') {
    return (
      <div
        className="font-mono text-xs uppercase tracking-widest text-muted"
        role="status"
        aria-live="polite"
        aria-busy="true"
      >
        Loading Settings…
      </div>
    );
  }

  if (profileState === 'error' || !profile) {
    return (
      <section
        className="max-w-xl rounded-card border border-ink/20 bg-white p-6"
        aria-labelledby="settings-load-error"
      >
        <h1 id="settings-load-error" className="font-serif text-2xl font-bold italic">
          Settings are temporarily unavailable.
        </h1>
        <p className="mt-2 font-mono text-xs leading-relaxed text-muted">
          Your saved profile was not changed. Check your connection, then retry this view.
        </p>
        <Button className="mt-5" variant="outline" onClick={fetchProfile}>
          Retry Settings
        </Button>
      </section>
    );
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: 'profile', label: 'Profile' },
    { id: 'connections', label: 'Connections' },
    { id: 'privacy', label: 'Privacy & AI' },
    { id: 'account', label: 'Account & Security' },
  ];

  const handleTabKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    const nextIndex = moveTabIndex(index, event.key, tabs.length);
    if (nextIndex === index) return;
    event.preventDefault();
    const nextTab = tabs[nextIndex];
    setTab(nextTab.id);
    tabRefs.current[nextIndex]?.focus();
  };

  return (
    <div className="space-y-8">
      <div className="pb-6 border-b border-ink/20">
        <AccentRule className="mb-4" />
        <h1 className="font-serif text-4xl italic font-black mb-2 sm:text-5xl">Settings & Profile.</h1>
        <p className="font-mono text-xs uppercase tracking-widest text-muted">Set your context to generate better AI outreach drafts.</p>
      </div>

      <div
        className="flex gap-1 overflow-x-auto border-b border-ink/15"
        role="tablist"
        aria-label="Settings sections"
      >
        {tabs.map((item, index) => (
          <button
            key={item.id}
            ref={(element) => {
              tabRefs.current[index] = element;
            }}
            type="button"
            id={`settings-tab-${item.id}`}
            role="tab"
            aria-selected={tab === item.id}
            aria-controls={`settings-panel-${item.id}`}
            tabIndex={tab === item.id ? 0 : -1}
            onClick={() => setTab(item.id)}
            onKeyDown={(event) => handleTabKeyDown(event, index)}
            className={`-mb-px min-h-11 shrink-0 border-b-2 px-4 py-2.5 font-mono text-[10px] font-bold uppercase tracking-widest transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-paper ${
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
        <div
          id="settings-panel-profile"
          role="tabpanel"
          aria-labelledby="settings-tab-profile"
          tabIndex={0}
          className="max-w-4xl flex-1 rounded-card border border-ink/15 bg-white p-5 animate-fade-in sm:p-8"
        >
          <form
            onSubmit={handleSave}
            className="space-y-6 font-mono text-sm"
            aria-busy={isSaving}
          >
             <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
               <div className="sm:col-span-2">
                   <label htmlFor="profile-name" className="text-xs uppercase tracking-widest text-subtle block mb-1">Your Name</label>
                   <Input id="profile-name" autoComplete="name" value={profile.name || ''} onChange={e => setProfile({...profile, name: e.target.value})} />
               </div>
               <div>
                   <label htmlFor="profile-role" className="text-xs uppercase tracking-widest text-subtle block mb-1">Current Role</label>
                   <Input id="profile-role" value={profile.role || ''} onChange={e => setProfile({...profile, role: e.target.value})} />
               </div>
               <div>
                   <label htmlFor="profile-company" className="text-xs uppercase tracking-widest text-subtle block mb-1">Company</label>
                   <Input id="profile-company" autoComplete="organization" value={profile.company || ''} onChange={e => setProfile({...profile, company: e.target.value})} />
               </div>
               <div className="sm:col-span-2">
                   <label htmlFor="profile-bio" className="text-xs uppercase tracking-widest text-subtle block mb-1">Bio / Career Goals</label>
                   {/* Focus treatment matches the Input primitive (brand ring)
                       rather than the ink ring this textarea used to carry —
                       two focus styles on one form read as an oversight. */}
                   <textarea
                      id="profile-bio"
                      className="h-32 w-full rounded-card border border-ink/20 bg-paper/50 p-3 font-mono text-base transition-colors focus-visible:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 sm:text-sm"
                      value={profile.bio || ''}
                      onChange={e => setProfile({...profile, bio: e.target.value})}
                   />
               </div>
             </div>

             <div className="border-t border-ink/20 pt-6">
                <h3 className="font-serif text-2xl italic font-bold mb-4">Resume Context</h3>
                <p id="resume-upload-help" className="text-subtle mb-4">Upload a PDF. Cirqle extracts editable text that can ground future drafts.</p>

                <div className="flex flex-wrap items-center gap-4">
                   <input
                      ref={fileInputRef}
                      id="resume-pdf"
                      type="file"
                      accept="application/pdf"
                      onChange={handlePdfUpload}
                      className="hidden"
                      disabled={isParsingPdf}
                      aria-describedby="resume-upload-help"
                   />
                   <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={isParsingPdf}
                      aria-controls="resume-pdf"
                      aria-describedby="resume-upload-help"
                      className="flex min-h-11 min-w-11 items-center gap-2 rounded-card border border-ink/20 px-3 py-2 font-mono text-[10px] font-bold uppercase tracking-widest transition-colors hover:bg-ink hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:cursor-not-allowed disabled:opacity-50"
                   >
                      <Upload size={14} aria-hidden="true" />
                      {isParsingPdf ? 'Parsing…' : resumeFile ? 'Replace PDF' : 'Choose PDF'}
                   </button>
                   {resumeFile && !isParsingPdf && (
                      <span className="max-w-xs truncate text-xs text-muted" role="status">{resumeFile.name} selected</span>
                   )}
                   {isParsingPdf && (
                     <Button
                       type="button"
                       size="sm"
                       variant="ghost"
                       onClick={() => pdfAbortRef.current?.abort()}
                     >
                       Cancel extraction
                     </Button>
                   )}
                   {isParsingPdf && pdfProgress && (
                     <span className="sr-only" role="status" aria-live="polite">
                       {pdfProgress}
                     </span>
                   )}
                   {isParsingPdf && (
                     <span className="font-mono text-xs text-muted" role="status" aria-live="polite">
                       Extracting text from {resumeFile?.name || 'PDF'}…
                     </span>
                   )}
                </div>

                {profile.resumeText && (
                   <div className="mt-4 animate-fade-slide-up">
                      <label htmlFor="profile-resume-text" className="text-xs uppercase tracking-widest text-subtle block mb-1">Parsed Resume Text (Editable)</label>
                      <textarea
                        id="profile-resume-text"
                        className="h-64 w-full rounded-card border border-ink/20 bg-paper/50 p-3 font-mono text-base text-subtle focus-visible:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 sm:text-sm"
                        value={profile.resumeText}
                        onChange={e => setProfile({...profile, resumeText: e.target.value})}
                      />
                   </div>
                )}
             </div>

             <div className="flex flex-col items-stretch gap-3 border-t border-ink/20 pt-6 sm:flex-row sm:items-center sm:justify-end">
               {saveFeedback && (
                 <p
                   role={saveFeedback.type === 'error' ? 'alert' : 'status'}
                   className={`mr-auto font-mono text-xs leading-relaxed ${
                     saveFeedback.type === 'error' ? 'text-red-700' : 'text-muted'
                   }`}
                 >
                   {saveFeedback.message}
                 </p>
               )}
               <Button type="submit" variant="brand" disabled={isSaving}>{isSaving ? 'Saving…' : 'Save Settings'}</Button>
             </div>
          </form>
        </div>
      )}

      {tab === 'connections' && user && (
        <div
          id="settings-panel-connections"
          role="tabpanel"
          aria-labelledby="settings-tab-connections"
          tabIndex={0}
          className="outline-none"
        >
          <EmailVerificationGate user={user}>
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
            <ConnectionRow
              key={`calendar-${connectionRevision}`}
              provider="calendar"
              uid={user.uid}
              email={user.email}
              onChanged={() =>
                setConnectionRevision((revision) => revision + 1)
              }
            />
            <ConnectionRow
              key={`gmail-${connectionRevision}`}
              provider="gmail"
              uid={user.uid}
              email={user.email}
              onChanged={() =>
                setConnectionRevision((revision) => revision + 1)
              }
            />
            <p className="font-mono text-[11px] leading-relaxed text-muted">
              In Preview, connection controls only change sample state: Cirqle does not read a live
              calendar or send through Gmail. A live connection opens Google consent and then shows
              the verified Google address and last sync here. Google treats
              Calendar and Gmail as one app grant, so Disconnect Google turns
              off and revokes both together.
            </p>
          </section>
          </div>
          </EmailVerificationGate>
        </div>
      )}

      {tab === 'account' && user && (
        <div
          id="settings-panel-account"
          role="tabpanel"
          aria-labelledby="settings-tab-account"
          tabIndex={0}
          className="outline-none"
        >
          <AccountSecurityPanel user={user} />
        </div>
      )}

      {tab === 'privacy' && user && (
        <div
          id="settings-panel-privacy"
          role="tabpanel"
          aria-labelledby="settings-tab-privacy"
          tabIndex={0}
          className="space-y-5 outline-none"
        >
          <PersistedSourcePrivacyControls uid={user.uid} />
          <section className="rounded-card border border-ink/15 bg-paper/50 p-5">
            <h2 className="font-serif text-xl font-bold italic">
              Sensitive-note vault
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-relaxed text-subtle">
              On a contact, mark any quick note as sensitive to encrypt it in
              your browser before storage. The vault passphrase is never
              stored, cannot be recovered by Cirqle, and sensitive note
              plaintext is structurally excluded from AI.
            </p>
          </section>
        </div>
      )}
    </div>
  );
}
