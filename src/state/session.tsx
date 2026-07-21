import AsyncStorage from '@react-native-async-storage/async-storage';
import React, {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
} from 'react';
import { Api, makeApi } from '../api';
import { Me } from '../types';

const KEY = 'ty:session:v1';
export const DEFAULT_SERVER = 'https://tomo-together.com';

type Session = {
  ready: boolean;
  authenticated: boolean;
  serverUrl: string;
  token: string | null;
  me: Me | null;
  api: Api;
  signIn: (token: string, me: Me) => void;
  signOut: () => void;
  setMe: (me: Me) => void;
  refreshMe: () => Promise<void>;
};

const Ctx = createContext<Session | null>(null);

// The server is fixed: everyone talks to the hosted instance. Persisted
// serverUrl overrides from older builds are deliberately ignored so stale
// installs migrate to the public server automatically.
const serverUrl = DEFAULT_SERVER;

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [me, setMeState] = useState<Me | null>(null);

  useEffect(() => {
    AsyncStorage.getItem(KEY)
      .then((raw) => {
        if (raw) {
          const s = JSON.parse(raw);
          if (s.token) setToken(s.token);
          if (s.me) setMeState(s.me);
        }
      })
      .catch(() => {})
      .finally(() => setReady(true));
  }, []);

  const persist = useCallback((s: { token: string | null; me: Me | null }) => {
    AsyncStorage.setItem(KEY, JSON.stringify(s)).catch(() => {});
  }, []);

  const signIn = useCallback((t: string, m: Me) => {
    setToken(t);
    setMeState(m);
    persist({ token: t, me: m });
  }, [persist]);

  const signOut = useCallback(() => {
    setToken(null);
    setMeState(null);
    persist({ token: null, me: null });
  }, [persist]);

  const setMe = useCallback((m: Me) => {
    setMeState(m);
    persist({ token, me: m });
  }, [persist, token]);

  const api = useMemo(() => makeApi(serverUrl, token), [token]);

  const refreshMe = useCallback(async () => {
    if (!token) return;
    try {
      const { me: m } = await api.me();
      setMe(m);
    } catch {
      // Offline or bad token: keep the cached profile for this session.
    }
  }, [api, token, setMe]);

  const value = useMemo<Session>(
    () => ({
      ready,
      authenticated: Boolean(token),
      serverUrl,
      token,
      me,
      api,
      signIn,
      signOut,
      setMe,
      refreshMe,
    }),
    [ready, token, me, api, signIn, signOut, setMe, refreshMe],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): Session {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession outside SessionProvider');
  return v;
}
