import type { AnalysisRecord, Keyframe, Observation, Reference } from '@/server/store';
import type { getEvalOverview } from '@/server/services/eval';
import type { listFootage } from '@/server/services/footage';
import type { outputsWithGates } from '@/server/services/scriptAgents';
import type { getStyleState } from '@/server/services/style';

export type * from '@/server/store';
export type { ProjectView } from '@/server/services/projects';

export type ReferenceWithAnalysis = Reference & { analysis: AnalysisRecord | null; observations: Observation[]; keyframes: Keyframe[] };

/** Derived from the service so client and server cannot drift. */
export type StyleState = Awaited<ReturnType<typeof getStyleState>>;
/** Script output plus the server's approval view (blockers, required confirmations). */
export type ScriptOutputView = ReturnType<typeof outputsWithGates>[number];
export type EvalOverview = Awaited<ReturnType<typeof getEvalOverview>>;
export type FootageList = Awaited<ReturnType<typeof listFootage>>;
export type VideoJobList = Awaited<ReturnType<typeof import('@/server/worker').listJobs>>;
export type VideoJob = VideoJobList['jobs'][number];
/** `GET/PUT /api/projects/[id]/edit-draft` (Etappe 12). */
export type EditDraftView = import('@/server/services/editDraft').EditDraftView;
export type EditorMedia = EditDraftView['media'][number];
export type EditState = Awaited<ReturnType<typeof import('@/server/services/edit').getEditState>>;
export type TranscriptView = NonNullable<Awaited<ReturnType<typeof import('@/server/services/transcripts').getTranscript>>>;
export type TakeSuggestions = Awaited<ReturnType<typeof import('@/server/services/transcripts').suggestTakes>>;
export type AiBrollState = Awaited<ReturnType<typeof import('@/server/services/generations').getAiBrollState>>;
export type CutSuggestionsView = import('@/server/services/cuts').CutSuggestionsView;
/** `GET /api/context` (Etappe 11). */
export type ContextOverview = Awaited<ReturnType<typeof import('@/server/services/strategy').getContext>>;
export type ContextVersionView = Awaited<ReturnType<typeof import('@/server/services/strategy').getVersion>>;
export type ContextImportPreview = Awaited<ReturnType<typeof import('@/server/services/strategy').previewImport>>;
export type StrategyGateView = Awaited<ReturnType<typeof import('@/server/services/strategyGate').gateView>>;
export type SelfAssessmentList = Awaited<ReturnType<typeof import('@/server/services/selfAssessment').listSelfAssessments>> & {
  reviewHints: Awaited<ReturnType<typeof import('@/server/services/selfAssessment').reviewHints>>;
};
export type PillarMixView = Awaited<ReturnType<typeof import('@/server/services/selfAssessment').selfAssessmentMix>>;
/** Standard folder status (Etappe 10). */
export type DefaultsStatus = import('@/server/defaults').DefaultsStatus;
export type DesignState = Awaited<ReturnType<typeof import('@/server/services/designSystem').getDesignState>>;
/** Studio-Chat (Etappe 15). */
export type ChatThreadList = Awaited<ReturnType<typeof import('@/server/services/chat').listThreads>>;
export type ChatThreadView = Awaited<ReturnType<typeof import('@/server/services/chat').getThread>>;
export type ChatMessageView = ChatThreadView['messages'][number];
export type ChatProposalView = ChatMessageView['proposals'][number];
export type ChatApplyResult = Awaited<ReturnType<typeof import('@/server/services/chat').applyProposal>>;
/** KI-Dramaturgie (Etappe 16). */
export type StoryList = Awaited<ReturnType<typeof import('@/server/services/editDirection').listStories>>;
export type StoryPlanView = StoryList['plans'][number];
export type StoryApplyResult = Awaited<ReturnType<typeof import('@/server/services/editDirection').applyStory>>;
export type FinishState = import('@/server/services/finish').FinishState;
/** Karussell-Generator (Etappe 18). */
export type CarouselList = Awaited<ReturnType<typeof import('@/server/services/carousels').listCarousels>>;
export type CarouselView = Awaited<ReturnType<typeof import('@/server/services/carousels').getCarousel>>;
export type CarouselRenderResult = Awaited<ReturnType<typeof import('@/server/services/carouselRender').renderCarousel>>;
/** Etappe 19: stories. */
export type IgStoryList = Awaited<ReturnType<typeof import('@/server/services/stories').listStories>>;
export type IgStoryView = Awaited<ReturnType<typeof import('@/server/services/stories').getStory>>;
export type IgStoryRenderResult = Awaited<ReturnType<typeof import('@/server/services/storyRender').renderStory>>;
export type IgStoryCreateResult = Awaited<ReturnType<typeof import('@/server/services/stories').createStories>>;
/** Etappe 20: the week board. */
export type BoardView = Awaited<ReturnType<typeof import('@/server/services/board').getBoard>>;
export type BoardItemView = import('@/server/services/board').BoardItemView;
