import { route } from '@/server/http';
import { gateView } from '@/server/services/strategyGate';

type P = { kind: string; id: string };
/**
 * `kind` ∈ concept | script | copy | storyboard | edit_plan (else 404) → FitCheck questions and answers, blockers,
 * lint findings and overrides (with their locally stored reasons, for this local UI).
 */
export const GET = route<P>((_req, { kind, id }) => gateView(kind, id));
