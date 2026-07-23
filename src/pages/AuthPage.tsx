import React, { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { auth, handleFirestoreError } from '../config/firebase';
import { signInWithEmailAndPassword, createUserWithEmailAndPassword, GoogleAuthProvider, signInWithPopup } from 'firebase/auth';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { db } from '../config/firebase';
import { doc, setDoc, serverTimestamp } from 'firebase/firestore';

export default function AuthPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const isLogin = location.pathname === '/login';
  
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleGoogleSignIn = async () => {
    setError('');
    setLoading(true);
    try {
      const provider = new GoogleAuthProvider();
      const result = await signInWithPopup(auth, provider);
      if (result.user) {
        navigate('/app', { replace: true });
      }
    } catch (err: any) {
      if (err.message?.includes('auth/')) {
        setError(err.message);
      } else {
        console.error(err);
        setError('An unexpected error occurred during Google Sign In.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      if (isLogin) {
        await signInWithEmailAndPassword(auth, email, password);
      } else {
        const { user } = await createUserWithEmailAndPassword(auth, email, password);
        // Create the user profile blueprint
        await setDoc(doc(db, 'users', user.uid), {
          userId: user.uid,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
          name: null,
          role: null,
          company: null,
          bio: null,
          resumeText: null,
          targetIndustries: []
        });
      }
      navigate('/app');
    } catch (err: any) {
      if (err.code === 'auth/operation-not-allowed') {
        setError('Email/password sign-in is turned off for this project — use "Continue with Google" above instead.');
      } else if (err.message?.includes('auth/')) {
        setError(err.message);
      } else {
        handleFirestoreError(err, isLogin ? 'get' : 'create', isLogin ? null : `users/${auth.currentUser?.uid}`);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex-1 flex items-center justify-center p-6 bg-paper">
      <div className="w-full max-w-sm bg-white border border-ink p-8">
        <h2 className="font-serif text-3xl font-black italic mb-6">{isLogin ? 'Welcome Back' : 'Create Account'}</h2>
        
        {error && (
           <div className="mb-4 bg-red-50 text-red-600 p-3 text-[10px] font-mono border border-red-200">
             {error}
           </div>
        )}

        <Button
          type="button"
          variant="default"
          className="w-full mb-6 font-mono text-xs uppercase"
          onClick={handleGoogleSignIn}
          disabled={loading}
        >
          {loading ? 'Processing...' : 'Continue with Google'}
        </Button>

        <div className="flex items-center gap-2 mb-6">
           <div className="flex-1 h-px bg-ink/20"></div>
           <span className="font-mono text-[10px] uppercase text-subtle tracking-widest">or email</span>
           <div className="flex-1 h-px bg-ink/20"></div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 font-mono">
          <div>
            <label className="block text-[10px] uppercase tracking-widest mb-1 text-subtle">Email</label>
            <Input 
              type="email" 
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required 
            />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-widest mb-1 text-subtle">Password</label>
            <Input 
              type="password" 
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required 
            />
          </div>
          <Button type="submit" variant="outline" className="w-full" disabled={loading}>
            {loading ? 'Processing...' : (isLogin ? 'Log In' : 'Sign Up')}
          </Button>
        </form>
      </div>
    </div>
  );
}
