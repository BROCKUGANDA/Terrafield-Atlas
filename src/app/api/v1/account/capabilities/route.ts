import { db } from '@/lib/db';
import { apiHandler, jsonResponse } from '@/lib/api/helpers';
import { accountUserId } from '@/lib/auth';

/** Non-erroring capability discovery for shell navigation. It returns no data. */
export const GET = apiHandler(async (req, { correlationId }) => {
  const userId = await accountUserId(req);
  const user = userId ? await db.accountUser.findUnique({ where: { id: userId }, select: { isAdmin: true } }) : null;
  return jsonResponse({ isAdmin: user?.isAdmin === true }, { correlationId });
});
