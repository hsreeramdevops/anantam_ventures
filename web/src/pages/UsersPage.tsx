import { useAuth } from '../auth';
import { useProject } from '../project';
import EntityPage from './EntityPage';

/** Users list: Owner badge, each user's projects, and a warning for non-admins without a project. */
export default function UsersPage() {
  const { user: me } = useAuth();
  const { projects } = useProject();
  const name = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
  const isAdmin = me?.role === 'admin';

  return (
    <EntityPage
      type="user"
      order={['name', 'username', 'email', 'role', 'active']}
      badge={(d) => (
        <>
          {d.owner === true && <span className="tag" style={{ marginLeft: 8 }} title="Only the owner can change roles">Owner</span>}
          {isAdmin && d.role !== 'admin' && Array.isArray(d.projects) && (
            <span className="muted small" style={{ display: 'block' }}>
              {(d.projects as string[]).length ? (d.projects as string[]).map(name).join(', ') : 'No project'}
            </span>
          )}
        </>
      )}
      hero={(items) => {
        const none = isAdmin ? items.filter((u) => u.role !== 'admin' && Array.isArray(u.projects) && !(u.projects as string[]).length) : [];
        return none.length > 0 && (
          <div className="notice warn" role="status"><span>
            <b>{none.length} user{none.length > 1 ? 's have' : ' has'} no project:</b> {none.map((u) => u.name ?? u.username).join(', ')}.{' '}
            They can't see anything until you edit them and tick at least one project.</span>
          </div>
        );
      }}
    />
  );
}
