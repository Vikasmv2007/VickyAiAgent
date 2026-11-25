import { initializeApp, getApps } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  User,
} from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';
import type { ConnectedAccount } from '../types';

const app = getApps().length > 0 ? getApps()[0] : initializeApp(firebaseConfig);
const auth = getAuth(app);

export const WORKSPACE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/gmail.readonly',
];

// Strictly in-memory token store (never written to localStorage or sessionStorage)
const accountsMemoryStore = new Map<string, ConnectedAccount>();
let isSigningIn = false;

function buildProvider(forceAccountSelect = false): GoogleAuthProvider {
  const provider = new GoogleAuthProvider();
  for (const scope of WORKSPACE_SCOPES) {
    provider.addScope(scope);
  }
  if (forceAccountSelect) {
    provider.setCustomParameters({ prompt: 'select_account' });
  }
  return provider;
}

export function initAuthListener(onCleared?: () => void) {
  return onAuthStateChanged(auth, (user: User | null) => {
    if (!user && !isSigningIn) {
      accountsMemoryStore.clear();
      onCleared?.();
    }
  });
}

export function getStoredAccounts(): ConnectedAccount[] {
  return Array.from(accountsMemoryStore.values());
}

export function getPrimaryAccount(): ConnectedAccount | null {
  for (const acct of accountsMemoryStore.values()) {
    if (acct.isPrimary) return acct;
  }
  const first = accountsMemoryStore.values().next();
  return first.done ? null : first.value;
}

export async function connectGoogleAccount(
  options: { makePrimary?: boolean; forceSelect?: boolean } = {}
): Promise<ConnectedAccount[]> {
  try {
    isSigningIn = true;
    const provider = buildProvider(Boolean(options.forceSelect));
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error('Could not obtain Google access permission. Please try again.');
    }

    const email = result.user.email || 'google-account';
    const shouldBePrimary =
      options.makePrimary !== undefined
        ? options.makePrimary
        : accountsMemoryStore.size === 0;

    if (shouldBePrimary) {
      for (const [key, existing] of accountsMemoryStore.entries()) {
        accountsMemoryStore.set(key, { ...existing, isPrimary: false });
      }
    }

    accountsMemoryStore.set(email, {
      email,
      displayName: result.user.displayName || email.split('@')[0],
      photoURL: result.user.photoURL || undefined,
      accessToken: credential.accessToken,
      isPrimary: shouldBePrimary,
      connectedAt: new Date().toLocaleTimeString('en-IN', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Kolkata',
      }),
    });

    return getStoredAccounts();
  } finally {
    isSigningIn = false;
  }
}

export function setPrimaryGoogleAccount(email: string): ConnectedAccount[] {
  for (const [key, acct] of accountsMemoryStore.entries()) {
    accountsMemoryStore.set(key, { ...acct, isPrimary: key === email });
  }
  return getStoredAccounts();
}

export async function disconnectGoogleAccount(email: string): Promise<ConnectedAccount[]> {
  accountsMemoryStore.delete(email);
  if (accountsMemoryStore.size === 0) {
    await auth.signOut();
  } else if (!getPrimaryAccount()) {
    const first = accountsMemoryStore.values().next().value;
    if (first) {
      accountsMemoryStore.set(first.email, { ...first, isPrimary: true });
    }
  }
  return getStoredAccounts();
}

export async function signOutAllGoogleAccounts(): Promise<void> {
  accountsMemoryStore.clear();
  await auth.signOut();
}
