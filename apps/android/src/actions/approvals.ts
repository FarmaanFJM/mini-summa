// Who may decide a pending action. The desktop enforces this too; the phone only avoids offering buttons that would be
// refused, and says why when it hides them.
import { scopeAllows } from '@minisumma/shared';
import type { PendingAction, Scope } from '@minisumma/shared';

export type Decision = { can: true } | { can: false; reason: string };

export function canDecide(action: PendingAction, ctx: { scopes: readonly Scope[]; deviceId: string | null }, now: Date = new Date()): Decision {
  if (action.status !== 'pending') return { can: false, reason: 'This request has already been decided.' };
  if (new Date(action.expiresAt).getTime() <= now.getTime()) return { can: false, reason: 'This request has expired.' };
  if (!scopeAllows(ctx.scopes, 'approve')) {
    return { can: false, reason: 'This phone can see requests but cannot approve or reject them. Pair it again with that permission in Mini-Summa on your PC.' };
  }
  if (action.approvableBy === 'desktop') return { can: false, reason: 'This request can only be approved on your PC.' };
  const mine = action.createdBy.kind === 'device' && ctx.deviceId !== null && action.createdBy.deviceId === ctx.deviceId;
  if (mine && action.approvableBy !== 'any_approver') {
    return { can: false, reason: 'You sent this from this phone. Approve it on your PC or on another paired phone.' };
  }
  return { can: true };
}
