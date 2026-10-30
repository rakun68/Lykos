// The request in flight, as the credential store sees it.
//
// Pi's `CredentialStore.read(providerId)` carries no session id, but the
// session id Pi passes to `streamSimple` in `options.sessionId` is the one
// selection must use. The rotation wrapper runs Pi's original `streamSimple`
// inside `credentialContext.run(...)`; Pi's auth resolution (`read`, and
// `modify` for a refresh) runs in that call's async chain, so the store reads
// the session id, and the row the wrapper chose for this attempt, from here.

import { AsyncLocalStorage } from "node:async_hooks";

export interface CredentialRequestContext {
  provider: string;
  sessionId?: string;
  /** The pool row this attempt must use. Absent when the provider has no pool rows. */
  credentialId?: number;
}

export const credentialContext = new AsyncLocalStorage<CredentialRequestContext>();
