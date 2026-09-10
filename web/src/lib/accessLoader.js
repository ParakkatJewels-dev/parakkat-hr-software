// Supabase requests can finish after sign-out, an account switch, or a newer refresh.
// Only the newest request for the current identity may publish permissions.
export function createAccessLoader(fetchAccess, publish) {
  let userId = null;
  let revision = 0;
  return {
    setUser(next) {
      if (next === userId) return;
      userId = next;
      revision += 1;
      publish({ userId, data: null, error: null, loading: Boolean(userId) });
    },
    async load() {
      if (!userId) return;
      const owner = userId;
      const request = ++revision;
      publish((state) => ({ ...state, loading: true }));
      let data = null;
      let error = null;
      try {
        const result = await fetchAccess();
        if (result.error) throw result.error;
        if (!result.data) throw new Error('Access details are unavailable. Please try again.');
        data = result.data;
      } catch (err) {
        error = err instanceof Error ? err : new Error(err?.message || 'Could not load your access.');
      }
      if (request !== revision || owner !== userId) return;
      publish({ userId: owner, data, error, loading: false });
      return { data, error };
    },
  };
}
