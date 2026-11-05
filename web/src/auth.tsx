import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { api } from './api';
import { EntityDef, User } from './types';

interface AuthState {
  user: User | null;
  entities: EntityDef[];
  loading: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthState>(null as unknown as AuthState);
export const useAuth = () => useContext(Ctx);
export const useEntity = (type: string) => useAuth().entities.find((e) => e.type === type);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [entities, setEntities] = useState<EntityDef[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const me = await api.get<{ user: User }>('/api/auth/me');
      const schema = await api.get<{ entities: EntityDef[] }>('/api/schema');
      setUser(me.user);
      setEntities(schema.entities);
    } catch {
      setUser(null);
      setEntities([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    await api.post('/api/auth/logout').catch(() => undefined);
    setUser(null);
    setEntities([]);
  }, []);

  useEffect(() => {
    refresh();
    const onUnauth = () => { setUser(null); setEntities([]); };
    window.addEventListener('av:unauthorized', onUnauth);
    return () => window.removeEventListener('av:unauthorized', onUnauth);
  }, [refresh]);

  return <Ctx.Provider value={{ user, entities, loading, refresh, logout }}>{children}</Ctx.Provider>;
}
