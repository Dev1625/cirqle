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
if (import.meta.env.VITE_USE_FIREBASE_EMULATOR === 'true' && typeof window !== 'undefined') {
  const globalAny = window as any;
  if (!globalAny.__CIRQLE_EMULATOR_CONNECTED__) {
    globalAny.__CIRQLE_EMULATOR_CONNECTED__ = true;
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFirestoreEmulator(db, '127.0.0.1', 8085);
    // Emulator-only handle so local tooling (and manual console work) can sign
    // a throwaway fixture user in without driving the login form. Guarded by
    // the same flag as the emulator wiring itself, so it cannot exist in any
    // build that talks to the real project.
    globalAny.__CIRQLE_DEV__ = { auth, db };
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
