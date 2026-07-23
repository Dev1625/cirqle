import React, { useState, useEffect } from 'react';
import { collection, query, onSnapshot, addDoc, serverTimestamp, doc, updateDoc, deleteDoc, where } from 'firebase/firestore';
import { db, handleFirestoreError } from '../config/firebase';
import { useAuth } from '../contexts/AuthContext';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { FileText, Plus } from 'lucide-react';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../contexts/ConfirmContext';

export default function Templates() {
  const { user } = useAuth();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [templates, setTemplates] = useState<any[]>([]);
  const [isAdding, setIsAdding] = useState(false);
  const [formData, setFormData] = useState({ id: '', name: '', subject: '', body: '' });

  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, `users/${user.uid}/templates`), where('userId', '==', user.uid));
    const unsub = onSnapshot(q, (snapshot) => {
      const docs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      setTemplates(docs.sort((a: any, b: any) => b.createdAt?.toMillis() - a.createdAt?.toMillis()));
    }, error => handleFirestoreError(error, 'list', `users/${user.uid}/templates`));
    return () => unsub();
  }, [user]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    try {
      if (formData.id) {
         await updateDoc(doc(db, `users/${user.uid}/templates/${formData.id}`), {
           name: formData.name,
           subject: formData.subject,
           body: formData.body,
           updatedAt: serverTimestamp()
         });
      } else {
         await addDoc(collection(db, `users/${user.uid}/templates`), {
           userId: user.uid,
           name: formData.name,
           subject: formData.subject || null,
           body: formData.body,
           createdAt: serverTimestamp(),
           updatedAt: serverTimestamp()
         });
      }
      setIsAdding(false);
      setFormData({ id: '', name: '', subject: '', body: '' });
      toast(formData.id ? 'Template updated.' : 'Template saved.', 'success');
    } catch (err: any) {
       handleFirestoreError(err, 'create', `users/${user.uid}/templates`);
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!user) return;
    const confirmed = await confirm({
      title: 'Delete template?',
      message: `"${name}" will be permanently deleted. This cannot be undone.`,
      confirmLabel: 'Delete Template',
      tone: 'danger',
    });
    if (!confirmed) return;
    try {
       await deleteDoc(doc(db, `users/${user.uid}/templates/${id}`));
       toast('Template deleted.', 'success');
    } catch (err: any) {
       handleFirestoreError(err, 'delete', `users/${user.uid}/templates/${id}`);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center pb-6 border-b border-ink/20">
        <h1 className="font-serif text-5xl italic font-black">Templates.</h1>
        <Button onClick={() => { setIsAdding(true); setFormData({ id: '', name: '', subject: '', body: '' }); }} className="gap-2">
          <Plus size={16} /> New Template
        </Button>
      </div>

      {isAdding && (
        <div className="bg-white border border-ink p-6 mb-8 group overflow-hidden animate-fade-slide-up">
           <form onSubmit={handleSave} className="space-y-4 font-mono text-sm">
              <div>
                <label className="text-xs uppercase tracking-widest text-subtle block mb-1">Template Name</label>
                <Input required value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} placeholder="e.g. Cold Coffee Chat" />
              </div>
              <div>
                <label className="text-xs uppercase tracking-widest text-subtle block mb-1">Subject</label>
                <Input value={formData.subject} onChange={e => setFormData({...formData, subject: e.target.value})} />
              </div>
              <div>
                <label className="text-xs uppercase tracking-widest text-subtle block mb-1">Body (Supports variables like {"{{contact_name}}"})</label>
                <textarea 
                  className="w-full h-48 border border-ink p-3 font-mono text-sm bg-paper/50 focus:outline-none focus:ring-1 focus:ring-ink"
                  value={formData.body}
                  required
                  onChange={e => setFormData({...formData, body: e.target.value})}
                />
              </div>
              <div className="flex justify-end gap-2 pt-4">
                <Button type="button" variant="ghost" onClick={() => setIsAdding(false)}>Cancel</Button>
                <Button type="submit">Save Template</Button>
              </div>
           </form>
        </div>
      )}

      {templates.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {templates.map((t, index) => (
            <div
              key={t.id}
              style={{ animationDelay: `${Math.min(index, 8) * 30}ms` }}
              className="animate-fade-slide-up bg-white border border-ink p-6 flex flex-col justify-between"
            >
               <div className="mb-4">
                 <h3 className="font-serif text-2xl font-bold mb-2">{t.name}</h3>
                 {t.subject && <p className="font-mono text-xs text-subtle mb-2">Subject: {t.subject}</p>}
                 <p className="font-mono text-xs line-clamp-4 whitespace-pre-wrap">{t.body}</p>
               </div>
               <div className="flex gap-2 border-t border-ink/20 pt-4 mt-auto">
                 <Button variant="outline" size="sm" onClick={() => { setFormData(t); setIsAdding(true); }}>Edit</Button>
                 <Button variant="danger" size="sm" onClick={() => handleDelete(t.id, t.name)}>Delete</Button>
               </div>
            </div>
          ))}
        </div>
      )}

      {templates.length === 0 && !isAdding && (
         <div className="flex flex-col items-center gap-4 p-16 text-center border border-dashed border-ink/40">
            <FileText size={28} className="text-muted" />
            <p className="font-mono text-sm text-muted max-w-sm">No templates saved yet. Save your best outreach as a template to reuse it in seconds.</p>
            <Button onClick={() => { setIsAdding(true); setFormData({ id: '', name: '', subject: '', body: '' }); }} className="gap-2">
              <Plus size={16} /> New Template
            </Button>
         </div>
      )}
    </div>
  );
}
