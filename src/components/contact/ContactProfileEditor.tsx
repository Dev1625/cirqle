import React, { useEffect, useId, useMemo, useState } from 'react';

import {
  ContactProfileConflictError,
  saveContactProfile,
  type SaveContactProfileResult,
} from '../../lib/contactManagement';
import {
  ContactProfileValidationError,
  contactProfileFromRecord,
  validateContactProfile,
  type ContactProfile,
  type ContactProfileField,
} from '../../lib/contactManagementCore';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';

export interface ContactProfileEditorProps {
  uid: string;
  contactId: string;
  initialContact: Partial<Record<ContactProfileField, unknown>> & {
    profileRevision?: unknown;
  };
  onSaved?: (result: SaveContactProfileResult) => void;
  onCancel?: () => void;
  className?: string;
}

const FIELD_LABELS: Partial<Record<ContactProfileField, string>> = {
  name: 'Full name',
  email: 'Email',
  phone: 'Phone',
  company: 'Current company',
  role: 'Current role',
  location: 'Location',
  linkedinUrl: 'LinkedIn URL',
  industry: 'Industry',
  subIndustry: 'Sub-industry',
  school: 'School',
  seniority: 'Seniority',
  connectionSource: 'How you connected',
  summary: 'Relationship summary',
  whyTheyMatter: 'Why this person matters',
  tags: 'Tags',
};

function profileFingerprint(profile: ContactProfile): string {
  return JSON.stringify(profile);
}

export function ContactProfileEditor({
  uid,
  contactId,
  initialContact,
  onSaved,
  onCancel,
  className = '',
}: ContactProfileEditorProps) {
  const formId = useId();
  const initial = useMemo(
    () => contactProfileFromRecord(initialContact),
    [initialContact],
  );
  const [profile, setProfile] = useState<ContactProfile>(initial);
  const [savedFingerprint, setSavedFingerprint] = useState(
    profileFingerprint(initial),
  );
  const [profileRevision, setProfileRevision] = useState(
    Number.isSafeInteger(initialContact.profileRevision) &&
    Number(initialContact.profileRevision) >= 0
      ? Number(initialContact.profileRevision)
      : 0,
  );
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{
    tone: 'error' | 'success' | 'warning';
    text: string;
  } | null>(null);

  useEffect(() => {
    setProfile(initial);
    setSavedFingerprint(profileFingerprint(initial));
    setProfileRevision(
      Number.isSafeInteger(initialContact.profileRevision) &&
      Number(initialContact.profileRevision) >= 0
        ? Number(initialContact.profileRevision)
        : 0,
    );
    setMessage(null);
  }, [contactId, initial, initialContact.profileRevision]);

  const validation = validateContactProfile(profile);
  const dirty = profileFingerprint(profile) !== savedFingerprint;
  const fieldId = (field: ContactProfileField) => `${formId}-${field}`;

  const updateField = <Field extends ContactProfileField>(
    field: Field,
    value: ContactProfile[Field],
  ) => {
    setProfile((current) => ({ ...current, [field]: value }));
    setMessage(null);
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!validation.valid || !dirty || saving) return;
    setSaving(true);
    setMessage(null);
    try {
      const result = await saveContactProfile({
        uid,
        contactId,
        profile,
        expectedProfileRevision: profileRevision,
      });
      setProfile(result.contact);
      setSavedFingerprint(profileFingerprint(result.contact));
      setProfileRevision(result.contact.profileRevision);
      setMessage({
        tone: 'success',
        text: result.jobHistoryChanged
          ? 'Profile saved. The previous role remains in job history.'
          : 'Profile saved.',
      });
      onSaved?.(result);
    } catch (error) {
      if (error instanceof ContactProfileConflictError) {
        setMessage({ tone: 'warning', text: error.message });
      } else if (error instanceof ContactProfileValidationError) {
        setMessage({
          tone: 'error',
          text: 'Review the highlighted profile fields.',
        });
      } else {
        setMessage({
          tone: 'error',
          text:
            error instanceof Error
              ? error.message
              : 'The profile could not be saved.',
        });
      }
    } finally {
      setSaving(false);
    }
  };

  const inputField = (
    field: Exclude<
      ContactProfileField,
      'relationshipTier' | 'summary' | 'whyTheyMatter' | 'tags'
    >,
    options: { type?: React.HTMLInputTypeAttribute; placeholder?: string } = {},
  ) => (
    <div>
      <label
        htmlFor={fieldId(field)}
        className="mb-1 block font-mono text-[10px] font-bold uppercase tracking-widest text-subtle"
      >
        {FIELD_LABELS[field]}
      </label>
      <Input
        id={fieldId(field)}
        type={options.type}
        value={profile[field]}
        placeholder={options.placeholder}
        aria-invalid={Boolean(validation.errors[field])}
        aria-describedby={
          validation.errors[field] ? `${fieldId(field)}-error` : undefined
        }
        onChange={(event) => updateField(field, event.target.value)}
      />
      {validation.errors[field] && (
        <p
          id={`${fieldId(field)}-error`}
          className="mt-1 text-xs text-red-700"
        >
          {validation.errors[field]}
        </p>
      )}
    </div>
  );

  return (
    <form
      className={`space-y-6 ${className}`}
      aria-label="Edit contact profile"
      onSubmit={save}
    >
      <div>
        <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-brand">
          Contact record
        </p>
        <h2 className="mt-1 font-serif text-2xl">Edit profile</h2>
        <p className="mt-2 max-w-2xl text-sm text-subtle">
          Role or company changes create a dated job-history entry. They do not
          overwrite the person&apos;s earlier work history.
        </p>
      </div>

      <fieldset className="space-y-4">
        <legend className="mb-3 font-mono text-xs font-bold uppercase tracking-widest">
          Identity
        </legend>
        <div className="grid gap-4 md:grid-cols-2">
          {inputField('name', { placeholder: 'Full name' })}
          {inputField('email', {
            type: 'email',
            placeholder: 'name@company.com',
          })}
          {inputField('phone', {
            type: 'tel',
            placeholder: '+1 212 555 0123',
          })}
          {inputField('linkedinUrl', {
            type: 'url',
            placeholder: 'https://www.linkedin.com/in/…',
          })}
          {inputField('location')}
          {inputField('school')}
        </div>
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="mb-3 font-mono text-xs font-bold uppercase tracking-widest">
          Current work
        </legend>
        <div className="grid gap-4 md:grid-cols-2">
          {inputField('company')}
          {inputField('role')}
          {inputField('industry')}
          {inputField('subIndustry')}
          {inputField('seniority')}
          {inputField('connectionSource')}
        </div>
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="mb-3 font-mono text-xs font-bold uppercase tracking-widest">
          Relationship memory
        </legend>
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label
              htmlFor={fieldId('relationshipTier')}
              className="mb-1 block font-mono text-[10px] font-bold uppercase tracking-widest text-subtle"
            >
              Relationship tier
            </label>
            <select
              id={fieldId('relationshipTier')}
              value={profile.relationshipTier}
              onChange={(event) =>
                updateField(
                  'relationshipTier',
                  event.target.value as ContactProfile['relationshipTier'],
                )
              }
              className="h-11 w-full rounded-card border border-ink/20 bg-white px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
            >
              <option value="Cold">Cold</option>
              <option value="Warm">Warm</option>
              <option value="Strong">Strong</option>
            </select>
          </div>
          <div>
            <label
              htmlFor={fieldId('tags')}
              className="mb-1 block font-mono text-[10px] font-bold uppercase tracking-widest text-subtle"
            >
              {FIELD_LABELS.tags}
            </label>
            <Input
              id={fieldId('tags')}
              value={profile.tags.join(', ')}
              placeholder="Investor, Healthcare, New York"
              onChange={(event) =>
                updateField(
                  'tags',
                  event.target.value
                    .split(',')
                    .map((tag) => tag.trim())
                    .filter(Boolean),
                )
              }
            />
            <p className="mt-1 text-xs text-muted">
              Separate tags with commas. Duplicates are removed on save.
            </p>
          </div>
        </div>

        {(['summary', 'whyTheyMatter'] as const).map((field) => (
          <div key={field}>
            <label
              htmlFor={fieldId(field)}
              className="mb-1 block font-mono text-[10px] font-bold uppercase tracking-widest text-subtle"
            >
              {FIELD_LABELS[field]}
            </label>
            <textarea
              id={fieldId(field)}
              rows={field === 'summary' ? 4 : 3}
              value={profile[field]}
              aria-invalid={Boolean(validation.errors[field])}
              aria-describedby={
                validation.errors[field] ? `${fieldId(field)}-error` : undefined
              }
              onChange={(event) => updateField(field, event.target.value)}
              className="w-full rounded-card border border-ink/20 bg-transparent px-3 py-2 text-sm placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 aria-invalid:border-red-600"
            />
            {validation.errors[field] && (
              <p
                id={`${fieldId(field)}-error`}
                className="mt-1 text-xs text-red-700"
              >
                {validation.errors[field]}
              </p>
            )}
          </div>
        ))}
      </fieldset>

      {message && (
        <p
          role={message.tone === 'error' ? 'alert' : 'status'}
          className={
            message.tone === 'error'
              ? 'border border-red-300 bg-red-50 p-3 text-sm text-red-950'
              : message.tone === 'warning'
                ? 'border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950'
                : 'border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-950'
          }
        >
          {message.text}
        </p>
      )}

      <div className="flex flex-wrap justify-end gap-3 border-t border-ink/10 pt-4">
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button
          type="submit"
          variant="brand"
          disabled={!dirty || !validation.valid || saving}
        >
          {saving ? 'Saving…' : 'Save profile'}
        </Button>
      </div>
    </form>
  );
}
