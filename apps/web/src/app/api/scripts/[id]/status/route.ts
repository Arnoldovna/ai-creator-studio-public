import { z } from 'zod';
import { jsonBody, route } from '@/server/http';
import { setScriptStatus } from '@/server/services/content';

export const POST = route<{ id: string }>(async (req, { id }) => {
  const { status, claimsReviewed } = z
    .object({ status: z.enum(['approved', 'rejected', 'draft']), claimsReviewed: z.boolean().optional() })
    .parse(await jsonBody(req));
  return setScriptStatus(id, status, { claimsReviewed });
});
