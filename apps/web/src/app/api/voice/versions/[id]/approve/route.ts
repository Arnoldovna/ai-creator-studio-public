import { route } from '@/server/http';
import { approveVersion } from '@/server/services/style';

export const POST = route<{ id: string }>((_req, { id }) => approveVersion('voice', id));
