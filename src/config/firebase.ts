import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import firebaseConfig from "../../firebase-applet-config.json";

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);

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
