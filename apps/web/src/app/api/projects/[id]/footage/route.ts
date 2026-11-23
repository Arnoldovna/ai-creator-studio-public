import { route } from '@/server/http';
import { listFootage, uploadFootage } from '@/server/services/footage';

type P = { id: string };
export const GET = route<P>((_req, { id }) => listFootage(id));

/** Raw file body (streamed, not multipart); `?name=&origin=&rightsConfirmed=1&rightsNote=` (`rightsConfirmed` only for licensed/client footage, own footage is implicit). */
export const POST = route<P>(async (req, { id }) => {
  const q = req.nextUrl.searchParams;
  const len = req.headers.get('content-length');
  return uploadFootage(id, req.body, {
    name: q.get('name') ?? '', origin: q.get('origin') ?? '', rightsConfirmed: q.get('rightsConfirmed') === '1', rightsNote: q.get('rightsNote') ?? '',
  }, len ? Number(len) : null);
});
