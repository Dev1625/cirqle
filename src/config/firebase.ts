import { initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth } from "firebase/auth";
import { connectFirestoreEmulator, getFirestore } from "firebase/firestore";
import firebaseConfig from "../../firebase-applet-config.json";

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);

// Opt-in local emulator wiring for development/testing only — never active
// unless VITE_USE_FIREBASE_EMULATOR is explicitly set, so production and
// normal local dev against the live project are unaffected.
//
// Ports are overridable because the defaults are not always available: with
// more than one worktree checked out, the second emulator cannot bind 9099 /
// 8085, and pointing the app at the first one silently runs it against
// another branch's firestore.rules — which fails in confusing ways rather
// than obvious ones. Set VITE_EMULATOR_AUTH_PORT / VITE_EMULATOR_FIRESTORE_PORT
// (and the matching ports in firebase.json) to run a second instance.
if (import.meta.env.VITE_USE_FIREBASE_EMULATOR === 'true' && typeof window !== 'undefined') {
  const globalAny = window as any;
  if (!globalAny.__CIRQLE_EMULATOR_CONNECTED__) {
    globalAny.__CIRQLE_EMULATOR_CONNECTED__ = true;
    const host = import.meta.env.VITE_EMULATOR_HOST || '127.0.0.1';
    const authPort = Number(import.meta.env.VITE_EMULATOR_AUTH_PORT) || 9099;
    const firestorePort = Number(import.meta.env.VITE_EMULATOR_FIRESTORE_PORT) || 8085;
    connectAuthEmulator(auth, `http://${host}:${authPort}`, { disableWarnings: true });
    connectFirestoreEmulator(db, host, firestorePort);
  }
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: "create" | "update" | "delete" | "list" | "get" | "write";
  path: string | null;
  authInfo: {
    userId: string;
    email: string;
    emailVerified: boolean;
    isAnonymous: boolean;
    providerInfo: { providerId: string; displayName: string; email: string }[];
  };
}

export function handleFirestoreError(
  error: any,
  operationType: FirestoreErrorInfo["operationType"],
  path: string | null
): never {
  const currentUser = auth.currentUser;
  
  const authInfo = currentUser ? {
    userId: currentUser.uid,
    email: currentUser.email || "",
    emailVerified: currentUser.emailVerified,
    isAnonymous: currentUser.isAnonymous,
    providerInfo: currentUser.providerData.map(p => ({
      providerId: p.providerId,
      displayName: p.displayName || "",
      email: p.email || ""
    }))
  } : {
    userId: "",
    email: "",
    emailVerified: false,
    isAnonymous: false,
    providerInfo: []
  };

  const errorInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    operationType,
    path,
    authInfo
  };
  
  throw new Error(JSON.stringify(errorInfo));
}
