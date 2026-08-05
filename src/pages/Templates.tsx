import React, { useState, useEffect, useMemo } from 'react';
import { collection, query, onSnapshot, addDoc, serverTimestamp, doc, updateDoc, where } from 'firebase/firestore';
import { db, handleFirestoreError } from '../config/firebase';
import { useAuth } from '../contexts/AuthContext';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { ArchiveRestore, FileText, Plus } from 'lucide-react';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../contexts/ConfirmContext';
import { AccentRule } from '../components/ui/AccentRule';
import {
  TEMPLATE_VARIABLES,
  renderTemplate,
  unresolvedTemplateVariables,
} from '../lib/outreachWorkflow';

export default function Templates() {
  const { user } = useAuth();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [templates, setTemplates] = useState<any[]>([]);
  const [deletedTemplates, setDeletedTemplates] = useState<any[]>([]);
  const [isAdding, setIsAdding] = useState(false);
  const [formData, setFormData] = useState({ id: '', name: '', subject: '', body: '' });
  const templatePreview = useMemo(
    () => renderTemplate(formData, {
      contactName: 'Maya Chen',
      company: 'Northstar Ventures',
      role: 'Partner',
      userName: 'Alex Rivera',
      userRole: 'Founder',
      goal: 'compare notes on the market',
      ask: 'a 20-minute conversation next week',
    }),
    [formData.subject, formData.body],
  );

  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, `users/${user.uid}/templates`), where('userId', '==', user.uid));
    const unsub = onSnapshot(q, (snapshot) => {
      const docs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      const sorted = docs.sort(
          (a: any, b: any) =>
            (b.updatedAt?.toMillis?.() || b.createdAt?.toMillis?.() || 0) -
            (a.updatedAt?.toMillis?.() || a.createdAt?.toMillis?.() || 0),
        );
      setTemplates(
        sorted.filter(
          (template: any) => template.lifecycleStatus !== 'deleted',
        ),
      );
      setDeletedTemplates(
        sorted.filter(
          (template: any) => template.lifecycleStatus === 'deleted',
        ),
      );
    }, error => handleFirestoreError(error, 'list', `users/${user.uid}/templates`));
    return () => unsub();
  }, [user]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    const unsupportedVariables = unresolvedTemplateVariables(
      formData.subject,
      formData.body,
    ).filter(
      (variable) =>
        !(TEMPLATE_VARIABLES as readonly string[]).includes(variable),
    );
    if (unsupportedVariables.length > 0) {
      toast(
        `Unsupported variable${unsupportedVariables.length === 1 ? '' : 's'}: ${unsupportedVariables.map((variable) => `{{${variable}}}`).join(', ')}`,
        'error',
      );
      return;
    }
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
           lifecycleStatus: 'active',
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
      title: 'Move template to recovery?',
      message: `"${name}" will leave your active library, but you can restore it from Recently deleted.`,
      confirmLabel: 'Move to Recovery',
      tone: 'danger',
    });
    if (!confirmed) return;
    try {
       await updateDoc(doc(db, `users/${user.uid}/templates/${id}`), {
         lifecycleStatus: 'deleted',
         deletedAt: serverTimestamp(),
         purgeAfter: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
         updatedAt: serverTimestamp(),
       });
       toast(
         'Template moved to recovery.',
         'success',
         8000,
         {
           label: 'Undo',
           onClick: () => restoreTemplate(id),
         },
       );
    } catch (err: any) {
       handleFirestoreError(err, 'delete', `users/${user.uid}/templates/${id}`);
    }
  };

  const restoreTemplate = async (id: string) => {
    if (!user) return;
    try {
      await updateDoc(doc(db, `users/${user.uid}/templates/${id}`), {
        lifecycleStatus: 'active',
        deletedAt: null,
        purgeAfter: null,
        updatedAt: serverTimestamp(),
      });
      toast('Template restored.', 'success');
    } catch (error) {
      handleFirestoreError(
        error,
        'update',
        `users/${user.uid}/templates/${id}`,
      );
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center pb-6 border-b border-ink/20">
        <div>
          <AccentRule className="mb-4" />
          <h1 className="font-serif text-5xl italic font-black">Templates.</h1>
        </div>
        <Button onClick={() => { setIsAdding(true); setFormData({ id: '', name: '', subject: '', body: '' }); }} className="gap-2">
          <Plus size={16} /> New Template
        </Button>
      </div>

      {isAdding && (
        <div className="bg-white border border-ink/15 rounded-card p-6 mb-8 group overflow-hidden animate-fade-slide-up">
           <form onSubmit={handleSave} className="space-y-4 font-mono text-sm">
              <div>
                <label htmlFor="template-name" className="text-xs uppercase tracking-widest text-subtle block mb-1">Template Name</label>
                <Input id="template-name" required value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} placeholder="e.g. Cold Coffee Chat" />
              </div>
              <div>
                <label htmlFor="template-subject" className="text-xs uppercase tracking-widest text-subtle block mb-1">Subject</label>
                <Input id="template-subject" value={formData.subject} onChange={e => setFormData({...formData, subject: e.target.value})} />
              </div>
              <div>
                <label htmlFor="template-body" className="text-xs uppercase tracking-widest text-subtle block mb-1">Body</label>
                <textarea 
                  id="template-body"
                  aria-describedby="template-variable-help"
                  className="w-full h-48 border border-ink/15 rounded-card p-3 font-mono text-sm bg-paper/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
                  value={formData.body}
                  required
                  onChange={e => setFormData({...formData, body: e.target.value})}
                />
                <p id="template-variable-help" className="mt-2 text-[10px] text-subtle">
                  Supported variables: {TEMPLATE_VARIABLES.map((variable) => `{{${variable}}}`).join(', ')}
                </p>
              </div>
              <section className="border border-ink/15 bg-paper/40 p-4" aria-labelledby="template-preview-title">
                <h3 id="template-preview-title" className="text-xs font-bold uppercase tracking-widest text-subtle">Example preview</h3>
                <p className="mt-3 font-bold">{templatePreview.subject || '(No subject)'}</p>
                <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed">{templatePreview.body || 'Start typing to preview the body.'}</p>
                {templatePreview.unresolvedVariables.length > 0 && (
                  <p className="mt-3 text-xs text-amber-800" role="status">
                    Missing or unsupported: {templatePreview.unresolvedVariables.map((variable) => `{{${variable}}}`).join(', ')}
                  </p>
                )}
              </section>
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
              className="animate-fade-slide-up bg-white border border-ink/15 rounded-card p-6 flex flex-col justify-between"
            >
               <div className="mb-4">
                 <h3 className="font-serif text-2xl font-bold mb-2">{t.name}</h3>
                 {t.subject && <p className="font-mono text-xs text-subtle mb-2">Subject: {t.subject}</p>}
                 <p className="font-mono text-xs line-clamp-4 whitespace-pre-wrap">{t.body}</p>
               </div>
               <div className="flex gap-2 border-t border-ink/20 pt-4 mt-auto">
                 <Button
                   variant="outline"
                   size="sm"
                   aria-label={`Edit ${t.name}`}
                   onClick={() => {
                     setFormData({
                       id: t.id,
                       name: t.name || '',
                       subject: t.subject || '',
                       body: t.body || '',
                     });
                     setIsAdding(true);
                   }}
                 >
                   Edit
                 </Button>
                 <Button variant="danger" size="sm" aria-label={`Delete ${t.name}`} onClick={() => handleDelete(t.id, t.name)}>Delete</Button>
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

      {deletedTemplates.length > 0 && (
        <section
          className="rounded-card border border-dashed border-ink/25 bg-paper/40 p-5"
          aria-labelledby="deleted-templates-title"
        >
          <h2
            id="deleted-templates-title"
            className="font-serif text-xl font-bold italic"
          >
            Recently deleted.
          </h2>
          <p className="mt-1 font-mono text-[10px] uppercase tracking-widest text-muted">
            Recover a template before the retention worker clears it.
          </p>
          <div className="mt-4 space-y-2">
            {deletedTemplates.map((template) => (
              <div
                key={template.id}
                className="flex flex-col gap-3 border border-ink/15 bg-white p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <p className="font-serif font-bold">
                    {template.name || 'Untitled template'}
                  </p>
                  <p className="font-mono text-[10px] text-muted">
                    Deleted{' '}
                    {template.deletedAt?.toDate
                      ? template.deletedAt.toDate().toLocaleDateString()
                      : 'recently'}
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void restoreTemplate(template.id)}
                >
                  <ArchiveRestore
                    size={13}
                    className="mr-1.5"
                    aria-hidden="true"
                  />
                  Restore
                </Button>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
