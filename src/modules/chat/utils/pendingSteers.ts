import type { PendingSteer } from '@/shared/types';

const STORAGE_KEY = 'chat.codex.pendingSteers';

/** Used by the chat composer to restore this tab's unresolved Codex messages after refresh. */
export function readPendingCodexSteers(): PendingSteer[] {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.flatMap((steer) => {
      if (!steer || typeof steer.messageId !== 'string' || typeof steer.sessionKey !== 'string'
        || typeof steer.expectedTurnId !== 'string' || typeof steer.content !== 'string'
        || !Array.isArray(steer.uploadedAttachments)) {
        return [];
      }
      let status: PendingSteer['status'] = 'unknown';
      if (steer.status === 'unread' || steer.status === 'unsent') {
        status = steer.status;
      } else if (steer.status === 'queueing' || steer.status === 'queue-unknown') {
        status = 'queue-unknown';
      }
      return [{
        messageId: steer.messageId,
        sessionKey: steer.sessionKey,
        expectedTurnId: steer.expectedTurnId,
        content: steer.content,
        uploadedAttachments: steer.uploadedAttachments,
        attachments: [],
        status,
      }];
    });
  } catch {
    return [];
  }
}

/** Used by the chat composer to persist only Codex steers and their uploaded file descriptors. */
export function writePendingCodexSteers(steers: PendingSteer[]): void {
  try {
    const saved = steers.flatMap(({ attachments: _files, ...steer }) => steer.expectedTurnId ? [steer] : []);
    if (saved.length > 0) {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
    } else {
      sessionStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // The composer still tracks the sends for as long as this page is open.
  }
}
