import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { api, setApiProject } from './api';
import { useAuth } from './auth';
import { EntityDef, Project } from './types';

interface ProjectState {
  projects: Project[];
  current: Project | null;
  canManage: boolean;
  def: EntityDef | null;
  loading: boolean;
  select: (id: string | null) => void;
  reload: () => Promise<void>;
}

const KEY = 'av_project';
const Ctx = createContext<ProjectState>(null as unknown as ProjectState);
export const useProject = () => useContext(Ctx);

export function ProjectProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [def, setDef] = useState<EntityDef | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(() => localStorage.getItem(KEY));
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!user) { setProjects([]); setLoading(false); return; }
    try {
      const r = await api.get<{ items: Project[]; canManage: boolean; def: EntityDef }>('/api/projects');
      setProjects(r.items);
      setCanManage(r.canManage);
      setDef({ ...r.def, canWrite: r.canManage });
    } catch { setProjects([]); } finally { setLoading(false); }
  }, [user]);
  useEffect(() => { setLoading(true); reload(); }, [reload]);

  const select = useCallback((id: string | null) => {
    setCurrentId(id);
    if (id) localStorage.setItem(KEY, id); else localStorage.removeItem(KEY);
  }, []);

  const current = projects.find((p) => p.id === currentId) ?? (projects.length === 1 ? projects[0] : null);
  // Set synchronously so children's first API calls already carry the project.
  setApiProject(current?.id ?? null);

  return <Ctx.Provider value={{ projects, current, canManage, def, loading, select, reload }}>{children}</Ctx.Provider>;
}
