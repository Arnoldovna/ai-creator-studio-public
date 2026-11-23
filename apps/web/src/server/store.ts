import 'server-only';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  BriefInput, ChatChange, ChatPatch, ClientBrief, PatchKind, SlopHint, ObservationDecision, ObservationKind, ReferenceKind, ReferenceStatus, StyleForm, VoiceForm, ConceptDraft, Metrics, MetricWindow, ProjectKind, ReferenceAnalysis, StyleBibleRules, EvalCriterion, EvalUseCase, RejectCode, UseCase,
  EditDraftBody, ImageUsage, StoryPlanBody, CarouselBody, CarouselSourceKind, IgStoryBody, IgStorySourceKind, BoardKind, BoardSlot, BoardStatus, BoardRefKind, StorySelection, FailureKind, FitAnswerValue, SpritePlan, FootageOrigin, NoGoCategory, ProfileDocument, SourceDocument, StrategyDocument, GenerationParams, MediaProbe, EditPlanBody, LookTokens, LoudnessPreset, MeasuredLoudness, GrowthReport, InstagramCopy, DesignSuggestion, QaReport, ResearchReport, ResearchSource, Storyboard, StyleSuggestion, UgcScript, VersionStatus, VoiceGuideRules, VoiceSuggestion,
} from '@studio/core';
import { dataDir } from './env';
import { HttpError } from './errors';

/**
 * Local-first persistence. Mirrors supabase/migrations (same entities & lineage columns)
 * so a Supabase repository can replace it without changing services.
 * Single-process, single-user: the parsed DB is cached in memory, writes are serialized
 * through an in-process queue, applied to a copy and written atomically (tmp file + rename)
 * before the cache is swapped. External edits to db.json need an app restart.
 */

export interface Profile { id: string; name: string; kind: 'personal' | 'client'; createdAt: string }
export interface Project {
  id: string; title: string; kind: ProjectKind; description: string; client: ClientBrief | null;
  profileId: string; status: 'active' | 'archived'; createdAt: string; updatedAt: string;
  /** Generated B-roll (Etappe 7): explicit opt-in per project with its own credit budget (absent = off). */
  aiBroll?: { optInAt: string; creditBudget: number } | null;
}
export interface Reference {
  id: string; profileId: string; name: string; kind: ReferenceKind; mime: string; size: number; sha256: string;
  storagePath: string; palette: string[]; notes: string; source: string; likes: string[]; dislikes: string[];
  tags: string[]; ratings: Partial<Record<string, number>>;
  status: ReferenceStatus; createdAt: string; updatedAt: string;
  /**
   * Etappe 16: whether (and how) the image may appear IN her videos: her own photo, licensed with a source, or generated
   * (then always labelled). Absent = only inspiration, never placed into a video.
   */
  usage?: (ImageUsage & { setAt: string }) | null;
}
export interface Keyframe { id: string; referenceId: string; storagePath: string; timestampSec: number }
export interface AnalysisRecord {
  id: string; referenceId: string; agentRunId: string; provider: string; model: string; promptVersion: string;
  analysis: ReferenceAnalysis; keyframeIds: string[]; createdAt: string;
}
export interface Observation {
  id: string; referenceId: string; analysisId: string; dimension: string; kind: ObservationKind;
  statement: string; evidence: string; confidence: number; colors: string[];
  decision: ObservationDecision; feedback: string; decidedAt: string | null; mock: boolean; createdAt: string;
  /** Etappe 10: the AI's original wording, kept on the first manual edit of statement/dimension/colors. */
  original?: { statement: string; dimension: string; colors: string[] };
  editedAt?: string | null;
}
export type { StyleForm, VoiceForm } from '@studio/core';
export interface StyleBibleVersion {
  id: string; profileId: string; version: number; status: VersionStatus; rules: StyleBibleRules;
  createdAt: string; approvedAt: string | null;
  /** Director suggestion the user loaded into the form before creating this version (lineage only). */
  suggestionId?: string | null;
  /** `defaults` = imported from the standard folder (defaults.ts); absent = created in the studio. */
  source?: 'defaults';
}
export interface VoiceGuideVersion {
  id: string; profileId: string; version: number; status: VersionStatus; rules: VoiceGuideRules; createdAt: string; approvedAt: string | null;
  suggestionId?: string | null;
  source?: 'defaults';
}
/** Style/Voice Director output. A suggestion only – it never becomes a version without the user. */
export type DirectorSuggestion = {
  id: string; profileId: string; agentRunId: string; promptVersion: string; warnings: string[]; mock: boolean; createdAt: string;
} & (
  | { kind: 'style'; output: StyleSuggestion; observationIds: string[] }
  | { kind: 'voice'; output: VoiceSuggestion; sampleCount: number }
  /** Design Director (Etappe 14): a proposed design system; `baseVersionId` = the active Style Bible it was made on. */
  | { kind: 'design'; output: DesignSuggestion; observationIds: string[]; baseVersionId: string | null }
);
export interface Brief { id: string; projectId: string; input: BriefInput; createdAt: string }
export interface Concept {
  id: string; projectId: string; briefId: string; agentRunId: string; index: number; body: ConceptDraft;
  status: 'draft' | 'approved' | 'rejected'; styleBibleVersionId: string | null; voiceGuideVersionId: string | null;
  mock: boolean; createdAt: string;
  /** Etappe 9 lineage (absent = created before Etappe 9). */
  strategyVersionId?: string | null; profileVersionId?: string | null; pillarId?: string | null;
}
export interface ScriptVersion {
  id: string; projectId: string; conceptId: string; version: number; parentId: string | null;
  source: 'agent' | 'user_edit'; agentRunId: string | null; promptVersion: string | null; body: UgcScript;
  status: 'draft' | 'approved' | 'rejected'; styleBibleVersionId: string | null; voiceGuideVersionId: string | null;
  mock: boolean; createdAt: string; approvedAt: string | null;
  /** Etappe 9 lineage (absent = created before Etappe 9). */
  strategyVersionId?: string | null; profileVersionId?: string | null; pillarId?: string | null;
}
/** Output of an agent that works on one script version (QA report, Instagram copy, storyboard). */
export type ScriptOutput = {
  id: string; scriptId: string; projectId: string; agentRunId: string; promptVersion: string; warnings: string[]; mock: boolean; createdAt: string;
  /** Human gate: copy = approved for publishing (pasted manually), storyboard = AI asset briefs approved. QA stays 'draft' (advisory). */
  status: 'draft' | 'approved'; approvedAt: string | null;
  /** Client projects with AI media: how the client's consent is documented (set on approval). */
  clientConsentNote?: string | null;
} & ({ kind: 'qa'; output: QaReport } | { kind: 'copy'; output: InstagramCopy } | { kind: 'storyboard'; output: Storyboard });
/** Growth Analyst report. Approved = the user chose it as the test idea for ideation; it never changes style rules. */
export interface GrowthReportRecord {
  id: string; agentRunId: string; promptVersion: string; output: GrowthReport; warnings: string[]; mock: boolean;
  /** Projects whose publications were analysed (client projects only when explicitly included). */
  projectIds: string[]; includesClientData: boolean;
  /** Publications in the analysed table: deleting one removes the report, deleting a snapshot withdraws its approval. */
  publicationIds: string[];
  status: 'draft' | 'approved'; approvedAt: string | null; createdAt: string;
}
/** Research Analyst report from user-pasted sources (kept for provenance of every fact). */
export interface ResearchReportRecord {
  id: string; projectId: string; agentRunId: string; promptVersion: string; topic: string; sources: ResearchSource[];
  /** Optional on reports created before the Model Lab re-ran research. */
  audience?: string;
  output: ResearchReport; warnings: string[]; mock: boolean; createdAt: string;
}
/** Project footage (Release 3). Streamed to disk; rights confirmed by the user at upload; probe = ffprobe metadata. */
export interface MediaAsset {
  id: string; projectId: string; name: string; mime: string; size: number; sha256: string; storagePath: string;
  origin: FootageOrigin | 'generated'; rightsNote: string; rightsConfirmedAt: string;
  probe: MediaProbe | null; status: 'probed' | 'probe_failed' | 'probe_unavailable'; createdAt: string;
  /** Generated clips only: where they come from; they enter an EDL only after the asset review (`approved`). */
  generation?: { generationId: string; briefId: string; model: string; prompt: string; higgsfieldJobId: string; credits: number; mock: boolean; review: 'pending' | 'approved' | 'rejected' };
  /**
   * Etappe 12: editing proxy, thumbnail sprite and waveform peaks (job `prepare`), under `derived/<projectId>/<id>/`.
   * Working copies for the browser editor only; the render always reads `storagePath`. Absent = not prepared yet.
   */
  derived?: AssetDerived | null;
}
export interface AssetDerived {
  /** `PREPARE_VERSION` they were made with (an older version is prepared again on request). */
  version: number;
  proxy: { storagePath: string; width: number; height: number; fps: number; size: number };
  thumbs: SpritePlan & { storagePath: string };
  /** null = the footage has no sound. */
  peaks: { storagePath: string; perSec: number; count: number } | null;
  preparedAt: string;
}
/**
 * Working draft of a cut (Etappe 12, E7): ONE mutable draft per project and script (`scriptId` null = Freier Schnitt),
 * autosaved by the editor and checked leniently (problems shown, never refused for content). `revision` counts saves
 * (conflict check). Rendering takes an immutable EditPlan snapshot (`lastSnapshot`), the draft stays.
 */
export interface EditDraft {
  id: string; projectId: string; scriptId: string | null; revision: number;
  body: EditDraftBody; clientConsentNote: string;
  /** The plan version the draft continues (parent of the next snapshot). */
  basePlanId: string | null;
  lastSnapshot: { revision: number; planId: string } | null;
  createdAt: string; updatedAt: string;
}
/**
 * One generated B-roll clip (Etappe 7, ADR-010): quote → explicit credit approval → one create without
 * retry → download → asset review. `creditsCharged` is null while the job runs (then `approvedMaxCredits`
 * counts against the budget); a failure after the job was submitted counts as charged (refunds are not documented).
 */
export interface Generation {
  id: string; projectId: string; scriptId: string; storyboardId: string; briefIndex: number; briefId: string; sceneIndex: number;
  params: GenerationParams; mock: boolean;
  status: 'quoted' | 'queued' | 'running' | 'review' | 'approved' | 'rejected' | 'failed' | 'cancelled';
  quotedCredits: number; quotedAt: string; approvedMaxCredits: number | null; approvedAt: string | null;
  submittedAt: string | null; higgsfieldJobId: string | null; jobId: string | null; assetId: string | null;
  creditsCharged: number | null; failure: FailureKind | null; error: string | null;
  reviewNote: string; reviewedAt: string | null; createdAt: string;
}
export interface Publication {
  id: string; projectId: string; title: string; platform: 'instagram'; format: string; publishedAt: string; permalink: string;
  conceptId: string | null; scriptVersionId: string | null; hook: string;
  styleBibleVersionId: string | null; voiceGuideVersionId: string | null; createdAt: string;
  /** Etappe 9 lineage (absent on older records). */
  strategyVersionId?: string | null; pillarId?: string | null; editPlanId?: string | null;
}
export interface MetricSnapshot {
  id: string; publicationId: string; window: MetricWindow; observedAt: string; source: 'manual' | 'file_import'; metrics: Metrics; createdAt: string;
}
/** Why a model was chosen – stored with every agent run (learning loop + traceability). */
export interface RoutingLog {
  /** routed = OpenRouter router; direct = fixed paid provider; mock = offline (decision only previewed). */
  mode: 'routed' | 'direct' | 'mock';
  /** Position in the plan (0 = first choice, >0 = fallback). */
  attempt: number;
  confidential: boolean;
  reasons: string[];
  fallbacks: string[];
  rejected: { id: string; code: RejectCode }[];
}
export interface AgentRun {
  id: string; agent: string; promptVersion: string; provider: string; model: string; projectId: string | null;
  inputHash: string; status: 'succeeded' | 'failed'; error: string | null; costEstimateUsd: number | null;
  usage: { inputTokens: number; outputTokens: number } | null; createdAt: string;
  /** Learning-loop fields (absent on runs recorded before the router existed). */
  useCase?: UseCase | null; routing?: RoutingLog | null; latencyMs?: number | null;
  costSource?: 'reported' | 'tokens' | 'worst_case' | 'none'; styleVersionId?: string | null; voiceVersionId?: string | null;
  /** Etappe 9 lineage: context versions used and sha256 of their rendered AI text (lineage only, not enforced). */
  strategyVersionId?: string | null; profileVersionId?: string | null; aiContextHash?: string | null;
}
/** Evaluation Lab: the same task run with 2–3 explicitly chosen models (paid runs need cost approval). */
export interface EvalRun {
  id: string; useCase: EvalUseCase;
  /** What was compared: a reference, a brief (stored inline), a concept, a script version, a research report's sources or the current studio state. */
  input:
    | { kind: 'reference'; referenceId: string; label: string } | { kind: 'brief'; brief: BriefInput; label: string } | { kind: 'concept'; conceptId: string; label: string }
    | { kind: 'script'; scriptId: string; label: string } | { kind: 'research'; reportId: string; label: string } | { kind: 'style' | 'voice' | 'growth' | 'design' | 'chat' | 'story' | 'carousel' | 'ig_story' | 'week'; label: string };
  /** Studio data the compared input came from: deleting it deletes the run (absent on older runs). */
  projectIds?: string[]; publicationIds?: string[];
  modelIds: string[];
  /** Cost limit the user approved for this run (0 in mock mode). */
  approvedMaxUsd: number;
  mock: boolean;
  results: { modelId: string; agentRunId: string | null; output: unknown; error: string | null; costUsd: number | null; latencyMs: number | null }[];
  createdAt: string;
}
export interface EvalRating {
  id: string; evalRunId: string; useCase: UseCase; modelId: string; ratings: Partial<Record<EvalCriterion, number>>;
  /** Policy-weighted rating mapped to 0..1. */
  score: number; correction: string;
  /** Ratings of mock outputs are kept for testing but never influence routing. */
  mock: boolean; createdAt: string;
}
export interface WorkflowJob {
  id: string; workflow: string; idempotencyKey: string; status: 'running' | 'succeeded' | 'failed'; attempts: number;
  payload: unknown; result: unknown; error: string | null; createdAt: string; updatedAt: string;
}
/**
 * Versioned EDL of a project's script (Release 3, Etappe 4). Approved versions are immutable; edits create a new version.
 * `scriptId` null = „Freier Schnitt“ without a script (personal content only, Etappe 8); versions then count per project.
 * `body` may come from before Etappe 8: always read it through `EditPlanBody.parse` (services/edit.ts `planBody`).
 */
export interface EditPlan {
  id: string; projectId: string; scriptId: string | null; version: number; parentId: string | null;
  status: 'draft' | 'approved'; body: EditPlanBody; durationSec: number;
  /** Labels every publication of this cut must carry (ad label for client work, AI label for generated clips). */
  disclosures: string[]; warnings: string[]; clientConsentNote: string | null;
  /** Lineage, copied from the script version; scriptless plans pin the profile's versions approved at save time (or null). */
  styleBibleVersionId: string | null; voiceGuideVersionId: string | null;
  createdAt: string; approvedAt: string | null;
  /** Etappe 9 lineage (absent = created before Etappe 9). */
  strategyVersionId?: string | null; profileVersionId?: string | null; pillarId?: string | null;
}
/** One render of an approved EDL. Mirrors `public.renders`; the file is kept locally under renders/<projectId>/. */
export interface Render {
  id: string; projectId: string; editPlanId: string; jobId: string;
  status: 'rendering' | 'pending_review' | 'approved' | 'rejected' | 'failed' | 'cancelled';
  storagePath: string | null; size: number | null; sha256: string | null; durationSec: number | null;
  loudness: { preset: LoudnessPreset; measured: MeasuredLoudness | null } | null;
  disclosures: string[]; error: string | null; reviewNote: string;
  createdAt: string; finishedAt: string | null; reviewedAt: string | null;
  /**
   * Look of hook and overlays at render time (Etappe 8; null/absent = none): the resolved tokens of the plan's
   * pinned Style Bible or the labelled placeholder, plus font warnings from the render log. Approval compares it.
   */
  look?: RenderLook | null;
  /** Etappe 17: files of the CapCut/finish package and the „fehlende Wörter“ check (absent = none made yet). */
  finish?: RenderFinish | null;
  /** Etappe 17: the AI-label spans the render burned in (JSON), so a package refuses a render whose labels are stale. */
  labelKey?: string;
}
export type RenderLook = LookTokens & { warnings: string[] };
/** One file of the finish package, kept under renders/<projectId>/finish/<renderId>/. */
export interface FinishFile {
  storagePath: string; size: number; sha256: string; createdAt: string;
  /** The AI-label spans burned into this file (JSON; '[]' = none). A file whose spans no longer match the cut is made again. */
  labels?: string;
}
/** `clean` = without burned text (images as in the plan), `clean_noimg` = also without image overlays, `alpha` = text layer only, `cover` = still with hook. */
export type FinishFileKind = 'clean' | 'clean_noimg' | 'alpha' | 'cover';
export interface RenderQaFinding { text: string; startSec: number; endSec: number; words: number; atCut: boolean }
export interface RenderQa {
  createdAt: string; model: string | null; expected: number; recognized: number; matched: number;
  findings: RenderQaFinding[];
  /** Clips without a transcript are not compared (1-based). */
  skippedClips: number[];
}
export interface RenderFinish {
  files: Partial<Record<FinishFileKind, FinishFile>>;
  qa?: RenderQa | null;
}
/**
 * Transcript of one footage clip (Release 3, Etappe 5). The text lives in a JSON file under
 * transcripts/<projectId>/ (untrusted spoken words); the store keeps only this reference.
 * Every correction by the user is a new version.
 */
export interface Transcript {
  id: string; projectId: string; assetId: string; version: number; parentId: string | null;
  source: 'whisper' | 'mock' | 'user_edit'; model: string | null; language: string;
  storagePath: string; segmentCount: number; createdAt: string;
  /** whisper ran with the filler prompt (Etappe 8; absent = false). Corrections inherit it from their base. */
  fillerPrompt?: boolean;
}
/**
 * Silence ranges of one footage clip (Etappe 8), from FFmpeg volumedetect + silencedetect with a threshold
 * relative to the clip's mean volume. Source of the pause and filler suggestions. One per asset (a new scan replaces the old one, as `silence_scans_one_per_asset` in 0008).
 */
export interface SilenceScan {
  id: string; projectId: string; assetId: string;
  params: { noiseDb: number; minSilenceSec: number; meanDb: number };
  ranges: { startSec: number; endSec: number }[];
  durationSec: number | null; createdAt: string;
}
/** Long-running media work (render, transcription) executed by the in-process video worker (Release 3, Etappe 3). */
export type MediaJobKind = 'selftest' | 'render' | 'transcribe' | 'generate' | 'silence_scan' | 'prepare' | 'preview' | 'finish' | 'render_qa';
export type MediaJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export interface MediaJob {
  id: string; kind: MediaJobKind; projectId: string | null; idempotencyKey: string | null;
  status: MediaJobStatus; attempts: number;
  /** 0..1, null while unknown. */
  progress: number | null; progressNote: string;
  input: unknown; result: unknown; error: string | null; cancelRequested: boolean;
  createdAt: string; startedAt: string | null; finishedAt: string | null; updatedAt: string;
}
/**
 * Worst-case cost of a paid call in flight. Persisted so a crash cannot silently free budget:
 * reservations of an earlier process (orphaned) stay counted until the user releases them.
 */
export interface BudgetReservation { id: string; amountUsd: number; purpose: string; processId: string; createdAt: string }

/**
 * Strategy, profile or source document version (Etappe 9, ADR-012; Etappe 11, E1: one whole document per version).
 * One active version (status `approved`) per (profile, kind) and, for sources, per `sourceKey`.
 * `aiTextHash` = sha256 of `renderAiContextText` of this version alone (lineage only; null when not computed).
 */
export type ContextVersion = {
  id: string; profileId: string; version: number; status: VersionStatus;
  aiTextHash: string | null;
  /** How it came in: `import_bundle` = drop zone/paste (Etappe 11), `migration` = converted from schema 1, `chat` = a chat proposal she took over (Etappe 15). */
  source: 'import' | 'manual' | 'copy' | 'defaults' | 'import_bundle' | 'migration' | 'chat';
  createdAt: string; approvedAt: string | null;
} & (
  | { kind: 'strategy'; sourceKey: null; document: StrategyDocument }
  | { kind: 'profile'; sourceKey: null; document: ProfileDocument }
  | { kind: 'source'; sourceKey: string; document: SourceDocument }
);

/**
 * Deliberate release of a boundary-lint finding in a client project. Since Etappe 11 the reason lives here
 * (null on overrides whose reason was missing in the old private file). `key`: the lint fingerprint.
 */
export interface Override { id: string; key: string; at: string; reason: string | null }
/**
 * Strategy gate of one piece (Etappe 9, ADR-012). Since Etappe 10 personal projects have no gate; client projects
 * keep the boundary-lint overrides here. FitCheck answers of old gates stay as stored data (read only).
 * `strategyVersionId` null = no FitCheck (e.g. a gate that only holds lint overrides).
 */
export interface StrategyGate {
  id: string; projectId: string;
  subject: { kind: 'concept'; conceptId: string } | { kind: 'free_cut'; rootPlanId: string };
  strategyVersionId: string | null; pillarId: string | null;
  answers: { criterionId: string; answer: FitAnswerValue }[];
  joyExpected: FitAnswerValue | null; withinBoundaries: 'ja' | 'nein' | null; confirmedAt: string | null;
  fitOverrides: Override[];
  lintOverrides: (Override & { fingerprint: string; category: NoGoCategory })[];
  history: {
    at: string; strategyVersionId: string | null; pillarId: string | null; answers: { criterionId: string; answer: FitAnswerValue }[];
    joyExpected: FitAnswerValue | null; withinBoundaries: 'ja' | 'nein' | null; confirmedAt: string | null;
  }[];
  createdAt: string; updatedAt: string;
}

/**
 * Self-assessment (Etappe 9, ADR-012): joy, comfort on camera and „fertig“, also for sessions without a video.
 * Display only: nothing in the studio changes because of these values. `pillarId`/`strategyVersionId` are copied
 * from the subject's pins. Since Etappe 11 the note is stored on the record.
 */
export interface SelfAssessment {
  id: string; projectId: string | null;
  subject: { kind: 'session' } | { kind: 'publication' | 'edit_plan' | 'render'; id: string };
  pillarId: string | null; strategyVersionId: string | null;
  joy: number; cameraComfort: number | null; finished: boolean | null; note: string;
  assessedAt: string; createdAt: string;
}

/**
 * Her own font file (Etappe 14), stored under `fonts/<id>.<ext>` in the data folder. Family, PostScript name, weight and
 * italic come from the file's name/OS2 tables (core `parseFontFile`); `license` is her note on the licence (required).
 */
export interface FontRecord {
  id: string; profileId: string; name: string; format: 'ttf' | 'otf'; family: string; postscriptName: string; assName: string; weight: number; italic: boolean;
  size: number; sha256: string; storagePath: string; license: string; createdAt: string;
  /**
   * Etappe 16b: where the file comes from. Absent = she uploaded it (Etappe 14). `google`: added from Google Fonts – family,
   * weight, the versioned file URL it was downloaded from (SHA-256 above), the recognised licence and its URL.
   */
  origin?: { kind: 'google'; family: string; weight: number; url: string; licenseId: string; licenseUrl: string; lastModified: string };
}

/**
 * Studio chat (Etappe 15, E5): one history per page (`scope`: `brand`, `strategy`, `general`, `editor:<projectId>`,
 * Etappe 18 `carousel:<carouselId>`). A thread belongs to a project in the editor and in a carousel (deleted with it).
 */
export interface ChatThread { id: string; scope: string; projectId: string | null; title: string; createdAt: string; updatedAt: string }
/** What a proposal was made on: applying it checks that this is still the active version / draft revision (else 409). */
export type ChatProposalBase =
  | { kind: 'design' | 'voice'; versionId: string | null }
  | { kind: 'strategy' | 'profile'; versionId: string | null }
  | { kind: 'edit_draft'; projectId: string; scriptId: string | null; draftId: string; revision: number }
  /** Etappe 16: a change to the latest dramaturgy proposal, applied to the draft (same revision check plus the story). */
  | { kind: 'story'; projectId: string; scriptId: string | null; draftId: string; revision: number; storyId: string }
  /** Etappe 18: a change to the open carousel; applied as a new version while `versionId` is still its active version. */
  | { kind: 'carousel'; carouselId: string; versionId: string }
  /** Etappe 20: a change to one week of the board; applied while the week's items are still as the model saw them (`key`). */
  | { kind: 'week'; weekStart: string; key: string };
export interface ChatProposal {
  id: string; kind: PatchKind; title: string; patch: ChatPatch; changes: ChatChange[]; warnings: string[]; lint: SlopHint[];
  base: ChatProposalBase;
  status: 'open' | 'applied' | 'dismissed';
  decidedAt: string | null;
  /** After „Übernehmen“: the version (or draft revision) it created. */
  result: { versionId?: string; version?: number; revision?: number } | null;
}
/**
 * One chat message. `user`: her text (+ attached reference images). `assistant`: the reply of one `runAgent` call with
 * its proposals, model, cost and the anti-slop hints of the reply. Mock replies are marked `mock`.
 */
export interface ChatMessage {
  id: string; threadId: string; role: 'user' | 'assistant'; text: string; createdAt: string;
  imageIds: string[];
  agentRunId: string | null; mock: boolean; provider: string | null; model: string | null;
  costUsd: number | null; costSource: AgentRun['costSource'] | null;
  proposals: ChatProposal[]; warnings: string[]; lint: SlopHint[];
}

/**
 * KI-Dramaturgie (Etappe 16, E8): one proposal of the Edit Director for a draft. Kept in its own collection (not in the
 * draft body): a proposal is not draft content, the autosave would overwrite it, and the immutable render snapshot must
 * not carry suggestions. `sources` pins the transcript versions its sentences come from (a newer transcript = stale).
 */
export interface StoryPlanRecord {
  id: string; projectId: string; scriptId: string | null; draftId: string; draftRevision: number;
  sources: { assetId: string; transcriptId: string }[];
  agentRunId: string; promptVersion: string; mock: boolean; provider: string; model: string;
  costUsd: number | null; costSource: AgentRun['costSource'] | null;
  body: StoryPlanBody;
  /** Her last applied selection (chat changes like „Beat 2 raus“ start from it). */
  lastSelection: StorySelection | null;
  applied: { at: string; revision: number; selection: StorySelection }[];
  createdAt: string;
}

/**
 * Karussell (Etappe 18): one carousel per idea with its versions. `source` is where the idea came from (concept, script,
 * a finished reel's transcript, her note); every edit, variant (other layout/look) or chat change is a NEW version that
 * becomes active (the previous one stays, archived). Rendered PNGs live under `carousels/<projectId>/<carouselId>/`
 * (content-addressed by what FFmpeg gets), the version only remembers which files belong to it.
 */
export interface CarouselRecord {
  id: string; projectId: string; title: string;
  source: { kind: CarouselSourceKind; id: string | null; label: string; text: string };
  activeVersionId: string;
  createdAt: string; updatedAt: string;
}
export interface CarouselVersion {
  id: string; carouselId: string; projectId: string; version: number; parentId: string | null;
  status: 'active' | 'archived';
  /** How it came about: the writer agent, her edit, a variant (same texts, other layout), a chat proposal. */
  origin: 'agent' | 'user_edit' | 'variant' | 'chat';
  body: CarouselBody;
  agentRunId: string | null; promptVersion: string | null; mock: boolean; provider: string | null; model: string | null;
  costUsd: number | null; costSource: AgentRun['costSource'] | null;
  warnings: string[];
  /** Lineage: the style/voice/strategy/profile versions the text was written with (copied to edits). */
  styleBibleVersionId: string | null; voiceGuideVersionId: string | null; strategyVersionId: string | null; profileVersionId: string | null;
  /** The last PNG render of this version (files content-addressed; a changed design gives other keys = re-render). */
  render: { at: string; files: { n: number; key: string; storagePath: string; sha256: string }[]; warnings: string[] } | null;
  createdAt: string;
}

/**
 * Instagram story (Etappe 19): one 9:16 story from material she has (a finished reel, a carousel, a concept, a photo, a
 * note). Stories made by one Story Writer run share a `batchId`. Every save bumps `revision` (a save on an older revision
 * is refused). The rendered PNG/MP4 lives under `stories/<projectId>/<id>/` (content-addressed), `render` remembers it.
 */
export interface IgStoryRecord {
  id: string; projectId: string; batchId: string; title: string;
  source: { kind: IgStorySourceKind; id: string | null; label: string; text: string };
  revision: number;
  body: IgStoryBody;
  origin: 'agent' | 'manual';
  agentRunId: string | null; promptVersion: string | null; mock: boolean; provider: string | null; model: string | null;
  costUsd: number | null; costSource: AgentRun['costSource'] | null;
  warnings: string[];
  styleBibleVersionId: string | null; voiceGuideVersionId: string | null; strategyVersionId: string | null; profileVersionId: string | null;
  render: { at: string; revision: number; key: string; storagePath: string; sha256: string; mime: 'image/png' | 'video/mp4'; warnings: string[] } | null;
  createdAt: string; updatedAt: string;
}

/**
 * One planned post on the week board (Etappe 20): a main post (reel, carousel, idea) or a story on a day (`date` null =
 * „ohne Tag“), optionally linked to its material (`ref`). The status is hers; „posted“ is set only by her (with an optional
 * link/date) – the studio never posts, schedules or reminds. `publicationId`: the Rückblick record she made from it.
 */
export interface BoardItem {
  id: string; projectId: string | null; date: string | null; slot: BoardSlot; kind: BoardKind; order: number;
  title: string; note: string; pillarId: string | null; status: BoardStatus;
  ref: { kind: BoardRefKind; id: string } | null;
  posted: { at: string; permalink: string; publicationId: string | null } | null;
  origin: 'manual' | 'planner'; planId: string | null;
  createdAt: string; updatedAt: string;
}
/** One „Woche füllen“ run (Etappe 20): suggestions for the empty days, each taken over (or not) by her click. */
export interface WeekPlanRecord {
  id: string; weekStart: string;
  suggestions: { id: string; date: string; slot: BoardSlot; kind: BoardKind; title: string; ref: string | null; pillarId: string | null; reason: string; status: 'open' | 'accepted' | 'dismissed'; itemId: string | null }[];
  agentRunId: string; promptVersion: string; mock: boolean; provider: string; model: string; costUsd: number | null; costSource: AgentRun['costSource'] | null;
  warnings: string[]; notes: string; createdAt: string;
}

/** Current db.json schema (2 since Etappe 11; schema 1 is migrated on load, see migrateData.ts). */
export const SCHEMA_VERSION = 2;

export interface Db {
  schemaVersion: 2;
  profiles: Profile[];
  projects: Project[];
  references: Reference[];
  keyframes: Keyframe[];
  analyses: AnalysisRecord[];
  observations: Observation[];
  styleForms: Record<string, { style: StyleForm; voice: VoiceForm }>;
  styleBibles: StyleBibleVersion[];
  voiceGuides: VoiceGuideVersion[];
  directorSuggestions: DirectorSuggestion[];
  briefs: Brief[];
  concepts: Concept[];
  scripts: ScriptVersion[];
  scriptOutputs: ScriptOutput[];
  growthReports: GrowthReportRecord[];
  researchReports: ResearchReportRecord[];
  mediaAssets: MediaAsset[];
  publications: Publication[];
  metricSnapshots: MetricSnapshot[];
  agentRuns: AgentRun[];
  workflowJobs: WorkflowJob[];
  mediaJobs: MediaJob[];
  editPlans: EditPlan[];
  /** Working drafts of the editor (Etappe 12). */
  editDrafts: EditDraft[];
  renders: Render[];
  transcripts: Transcript[];
  silenceScans: SilenceScan[];
  budgetReservations: BudgetReservation[];
  generations: Generation[];
  /** Evaluation Lab: user-pinned model per use case (null = automatic routing). */
  routerPreferences: Partial<Record<UseCase, string | null>>;
  evalRuns: EvalRun[];
  evalRatings: EvalRating[];
  /** Strategy, profile and source document versions (Etappe 11: whole documents). */
  contextVersions: ContextVersion[];
  /** Lint overrides of client pieces (and old FitCheck answers, read only). */
  strategyGates: StrategyGate[];
  /** Self-check entries, with their notes. */
  selfAssessments: SelfAssessment[];
  /** Her own font files (Etappe 14). */
  fonts: FontRecord[];
  /** Studio chat (Etappe 15). */
  chatThreads: ChatThread[];
  chatMessages: ChatMessage[];
  /** Dramaturgy proposals of the editor (Etappe 16). */
  storyPlans: StoryPlanRecord[];
  /** Carousels and their versions (Etappe 18). */
  carousels: CarouselRecord[];
  carouselVersions: CarouselVersion[];
  /** Instagram stories (Etappe 19). */
  stories: IgStoryRecord[];
  /** Week board (Etappe 20): planned posts and the „Woche füllen“ runs. */
  boardItems: BoardItem[];
  weekPlans: WeekPlanRecord[];
}

export const PERSONAL_PROFILE_ID = 'profile-personal';
/** Identifies this server process; reservations of other processes are orphaned. */
export const PROCESS_ID = randomUUID();
export const isOrphaned = (r: BudgetReservation) => r.processId !== PROCESS_ID;

export function emptyDb(): Db {
  const now = new Date().toISOString();
  return {
    schemaVersion: 2,
    profiles: [{ id: PERSONAL_PROFILE_ID, name: 'Meine Creator-DNA', kind: 'personal', createdAt: now }],
    projects: [],
    references: [],
    keyframes: [],
    analyses: [],
    observations: [],
    styleForms: {},
    styleBibles: [],
    voiceGuides: [],
    directorSuggestions: [],
    briefs: [],
    concepts: [],
    scripts: [],
    scriptOutputs: [],
    growthReports: [],
    researchReports: [],
    mediaAssets: [],
    publications: [],
    metricSnapshots: [],
    agentRuns: [],
    workflowJobs: [],
    mediaJobs: [],
    editPlans: [],
    editDrafts: [],
    renders: [],
    transcripts: [],
    silenceScans: [],
    budgetReservations: [],
    generations: [],
    routerPreferences: {},
    evalRuns: [],
    evalRatings: [],
    contextVersions: [],
    strategyGates: [],
    selfAssessments: [],
    fonts: [],
    chatThreads: [],
    chatMessages: [],
    storyPlans: [],
    carousels: [],
    carouselVersions: [],
    stories: [],
    boardItems: [],
    weekPlans: [],
  };
}

const dbFile = () => path.join(dataDir(), 'db.json');
/**
 * Queue and cache live on `globalThis`, not in this module: the Next.js server can evaluate this module more than once
 * (separate route bundles), and two copies with their own queue loaded and migrated the same db.json at the same time
 * (Etappe 11: two schema-1 backups 4 ms apart). One shared queue serialises every load, migration, read and write of
 * the process, so a data folder is migrated (and backed up) exactly once.
 */
interface StoreState { queue: Promise<unknown>; cache: { file: string; db: Db } | null }
const STATE_KEY = Symbol.for('ai-creator-studio.store');
const state: StoreState = ((globalThis as unknown as Record<symbol, StoreState | undefined>)[STATE_KEY] ??= { queue: Promise.resolve(), cache: null });

/** Reads db.json; schema 1 is migrated in memory (with a backup of both old files first, see migrateData.ts). */
async function loadDbFile(): Promise<{ db: Db; migrated: boolean }> {
  let text: string;
  try {
    text = await readFile(dbFile(), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { db: emptyDb(), migrated: false };
    throw new Error(`Datenbankdatei ${dbFile()} kann nicht gelesen werden: ${(e as Error).message}`);
  }
  let parsed: Partial<Db>;
  try {
    parsed = JSON.parse(text) as Partial<Db>;
  } catch (e) {
    throw new Error(`Datenbankdatei ${dbFile()} ist beschädigt: ${(e as Error).message}`);
  }
  const { migrateOnLoad } = await import('./migrateData');
  const m = await migrateOnLoad(parsed, dataDir());
  return { db: fixInterrupted({ ...emptyDb(), ...m.db } as Db), migrated: m.migrated };
}

/** Single process: work that was running when the previous process ended can never finish. */
function fixInterrupted(db: Db): Db {
  // Single process: a job still `running` from a previous process can never finish.
  for (const j of db.workflowJobs)
    if (j.status === 'running') Object.assign(j, { status: 'failed', error: 'Abgebrochen: App wurde neu gestartet', updatedAt: new Date().toISOString() });
  // Same for media jobs; their half-written work directories are removed when the worker starts. Queued jobs stay queued.
  for (const j of db.mediaJobs)
    if (j.status === 'running') {
      const at = new Date().toISOString();
      Object.assign(j, { status: j.cancelRequested ? 'cancelled' : 'failed', error: 'Abgebrochen: App wurde neu gestartet', finishedAt: at, updatedAt: at });
    }
  // Renders follow their job (queued jobs resume, so their render stays `rendering`).
  for (const r of db.renders) {
    const j = db.mediaJobs.find((x) => x.id === r.jobId);
    if (r.status === 'rendering' && (!j || j.status === 'failed' || j.status === 'cancelled'))
      Object.assign(r, { status: j?.status === 'cancelled' ? 'cancelled' : 'failed', error: j?.error ?? 'Job nicht gefunden', finishedAt: new Date().toISOString() });
  }
  // Generations too; once submitted, the credits count as spent (the Higgsfield job may have finished anyway).
  for (const g of db.generations) {
    const j = db.mediaJobs.find((x) => x.id === g.jobId);
    if ((g.status === 'queued' || g.status === 'running') && (!j || j.status === 'failed' || j.status === 'cancelled'))
      Object.assign(g, { status: j?.status === 'cancelled' ? 'cancelled' : 'failed', error: j?.error ?? 'Job nicht gefunden', creditsCharged: g.creditsCharged ?? (g.submittedAt ? g.quotedCredits : 0) });
  }
  return db;
}

/** Standard folder hooks (defaults.ts), imported lazily: defaults.ts itself imports this module. */
const defaultsHooks = () => import('./defaults');

/** Loads db.json (migrating schema 1); a data folder without any strategy/profile/style/voice version is seeded from the standard folder. */
async function loadFromDisk(): Promise<Db> {
  const { db, migrated } = await loadDbFile();
  const hooks = await defaultsHooks();
  const seeded = await hooks.seedIfEmpty(db);
  if (migrated || seeded) await save(db);
  hooks.onDbLoaded(dbFile(), db);
  return db;
}

async function load(): Promise<Db> {
  const file = dbFile();
  if (state.cache?.file !== file) state.cache = { file, db: await loadFromDisk() };
  return state.cache.db;
}

async function save(db: Db) {
  await mkdir(dataDir(), { recursive: true });
  const file = dbFile();
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(db), 'utf8');
  await rename(tmp, file);
  state.cache = { file, db };
}

/** Read-only snapshot. */
export function read<T>(fn: (db: Db) => T): Promise<T> {
  const p = state.queue.then(async () => fn(await load()));
  state.queue = p.catch(() => undefined);
  return p;
}

/** Serialized read-modify-write. The mutation is only persisted if fn doesn't throw. */
export function write<T>(fn: (db: Db) => T): Promise<T> {
  const p = state.queue.then(async () => {
    const db = structuredClone(await load()); // a throwing fn must not leave the cache half-mutated
    const result = fn(db);
    await save(db);
    // write-through when the active versions changed (debounced); the write itself has already succeeded
    await defaultsHooks().then((h) => h.onDbWritten(dbFile(), db)).catch((e: unknown) => console.error('[defaults]', (e as Error).message));
    return result;
  });
  state.queue = p.catch(() => undefined);
  return p;
}

/** Tests that simulate a new process (`vi.resetModules()`) also drop the process-wide cache. */
export const forgetCacheForTests = () => { state.cache = null; };

export const newId = () => randomUUID();
export const now = () => new Date().toISOString();


export function must<T>(x: T | undefined | null, what: string): T {
  if (x == null) throw new HttpError(404, `${what} nicht gefunden`);
  return x;
}
