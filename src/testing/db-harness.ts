import { AppDatabase, openAppDb } from '../app/data/db';
import { createId } from '../app/core/id';

/** A uniquely named IndexedDB that can be "restarted" (closed and reopened). */
export function dbHarness(name = `test-${createId()}`) {
  let conn: Promise<AppDatabase> | null = null;
  const provider = () => (conn ??= openAppDb(name));
  return {
    name,
    provider,
    async restart(): Promise<void> {
      if (conn) (await conn).close();
      conn = null;
    },
  };
}
