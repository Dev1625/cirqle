import { differenceInDays } from 'date-fns';

export function getRecordDate(row: any): Date | null {
  const value = row.nextActionDueDate || row.nextFollowUpDate || row.sentAt || row.updatedAt;
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value.toDate === 'function') return value.toDate();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function getRecordTime(row: any) {
  return getRecordDate(row)?.getTime() || 0;
}

function getQueuePriority(row: any) {
  const now = new Date();
  const dueDate = getRecordDate({
    nextActionDueDate: row.nextActionDueDate,
    nextFollowUpDate: row.nextFollowUpDate,
  });
  const lastTouched = getRecordDate(row);
  const isOverdue = dueDate ? dueDate.getTime() < now.getTime() : false;
  const staleDays = lastTouched ? differenceInDays(now, lastTouched) : 0;

  if (isOverdue) return 120 + Math.min(staleDays, 30);
  if (row.status === 'Pending Follow-Up') return 105;
  if (row.status === 'Responded' && !row.meetingHeld) return 95;
  if (row.status === 'Re-engage') return 90;
  if (row.nextAction) return 80;
  if (row.status === 'Awaiting Response' && staleDays >= 7) return 70;
  return 0;
}

export function getFollowUpQueueItems(data: any[]) {
  const actionable = data
    .map((row) => {
      const priority = getQueuePriority(row);
      const actionDate = getRecordDate({
        nextActionDueDate: row.nextActionDueDate,
        nextFollowUpDate: row.nextFollowUpDate,
        sentAt: row.sentAt,
        updatedAt: row.updatedAt,
      });

      return {
        ...row,
        _queuePriority: priority,
        _actionDate: actionDate,
      };
    })
    .filter((row) => row._queuePriority > 0)
    .sort((a, b) => {
      if (b._queuePriority !== a._queuePriority) return b._queuePriority - a._queuePriority;
      return getRecordTime(a) - getRecordTime(b);
    });

  const deduped = new Map<string, any>();
  actionable.forEach((row) => {
    const key = row.contactId || row.id;
    if (!deduped.has(key)) deduped.set(key, row);
  });

  return Array.from(deduped.values()).sort((a, b) => {
    if (b._queuePriority !== a._queuePriority) return b._queuePriority - a._queuePriority;
    return getRecordTime(a) - getRecordTime(b);
  });
}
