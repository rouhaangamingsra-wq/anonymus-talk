import { initializeApp } from 'firebase/app';
import { getAnalytics, isSupported, logEvent } from 'firebase/analytics';

const firebaseConfig = {
  apiKey: 'AIzaSyA56KTS1juiFA4RVk81Oh4UfHSFcxSq28A',
  authDomain: 'privet-chat-1311f.firebaseapp.com',
  projectId: 'privet-chat-1311f',
  storageBucket: 'privet-chat-1311f.firebasestorage.app',
  messagingSenderId: '12133151162',
  appId: '1:12133151162:web:980c9b06dce488ea1bed83',
  measurementId: 'G-7HBE2PQTKR',
};

const app = initializeApp(firebaseConfig);

// Analytics needs a real browser context — guard so SSR/tests never crash.
let analytics = null;
isSupported().then((ok) => {
  if (ok) analytics = getAnalytics(app);
});

export const track = (name, params) => {
  if (analytics) logEvent(analytics, name, params);
};

export default app;
