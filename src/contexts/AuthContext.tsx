import React, { createContext, useContext, useEffect, useState } from 'react';
import { User, onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { auth, db } from '../config/firebase';

interface AuthContextType {
  user: User | null;
  loading: boolean;
}

const AuthContext = createContext<AuthContextType>({ user: null, loading: true });

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (user) {
         try {
           const docRef = doc(db, 'users', user.uid);
           const docSnap = await getDoc(docRef);
           if (!docSnap.exists()) {
             await setDoc(docRef, {
               userId: user.uid,
               createdAt: serverTimestamp(),
               updatedAt: serverTimestamp(),
               name: user.displayName || 'Anonymous User',
               role: null,
               company: null,
               bio: null,
               resumeText: null,
               targetIndustries: []
             });
           }
         } catch (e) {
           console.error("Failed to bootstrap user document:", e);
         }
      }
      setUser(user);
      setLoading(false);
    });

    return unsubscribe;
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading }}>
      {!loading && children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
