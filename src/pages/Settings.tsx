import React, { useRef, useState, useEffect } from 'react';
import { doc, getDoc, setDoc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { db, handleFirestoreError } from '../config/firebase';
import { useAuth } from '../contexts/AuthContext';
import { getDocument } from 'pdfjs-dist';
// Set up PDF worker manually to avoid module issues in some Vite setups
import { GlobalWorkerOptions } from 'pdfjs-dist';
// @ts-ignore
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker?url';
GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Upload } from 'lucide-react';
import { useToast } from '../contexts/ToastContext';

export default function Settings() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [profile, setProfile] = useState<any>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [resumeFile, setResumeFile] = useState<File | null>(null);
  const [isParsingPdf, setIsParsingPdf] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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
       toast("Please upload a PDF file.", 'error');
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
       toast('Resume parsed successfully.', 'success');
    } catch (err) {
       console.error("PDF parse error", err);
       toast("Failed to parse that PDF. Please try another file.", 'error');
    } finally {
       setIsParsingPdf(false);
    }
  };

  if (!profile) return <div className="font-mono">Loading...</div>;

  return (
    <div className="space-y-8">
      <div className="pb-6 border-b border-ink/20">
        <h1 className="font-serif text-5xl italic font-black mb-2">Settings & Profile.</h1>
        <p className="font-mono text-xs uppercase tracking-widest text-muted">Set your context to generate better AI outreach drafts.</p>
      </div>

      <div className="bg-white border border-ink p-8 flex-1 max-w-4xl">
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
                 <textarea 
                    className="w-full h-32 border border-ink p-3 font-mono text-sm bg-paper/50 focus:outline-none focus:ring-1 focus:ring-ink"
                    value={profile.bio || ''} 
                    onChange={e => setProfile({...profile, bio: e.target.value})} 
                 />
             </div>
           </div>

           <div className="border-t border-ink/20 pt-6">
              <h3 className="font-serif text-2xl mb-4">Resume Context</h3>
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
                    className="flex items-center gap-2 border border-ink px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest font-bold hover:bg-ink hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                 >
                    <Upload size={14} />
                    {isParsingPdf ? 'Parsing...' : resumeFile ? 'Replace PDF' : 'Choose PDF'}
                 </button>
                 {resumeFile && !isParsingPdf && (
                    <span className="text-xs text-muted truncate max-w-xs">{resumeFile.name}</span>
                 )}
              </div>

              {profile.resumeText && (
                 <div className="mt-4 animate-fade-slide-up">
                    <label className="text-xs uppercase tracking-widest text-subtle block mb-1">Parsed Resume Text (Editable)</label>
                    <textarea
                      className="w-full h-64 border border-ink p-3 font-mono text-sm bg-paper/50 text-subtle"
                      value={profile.resumeText}
                      onChange={e => setProfile({...profile, resumeText: e.target.value})}
                    />
                 </div>
              )}
           </div>

           <div className="border-t border-ink/20 pt-6 flex justify-end">
             <Button type="submit" disabled={isSaving}>{isSaving ? 'Saving...' : 'Save Settings'}</Button>
           </div>
        </form>
      </div>
    </div>
  );
}
