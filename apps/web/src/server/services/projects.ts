import 'server-only';
import { ClientBrief, ProjectInput, ProjectUpdate } from '@studio/core';
import { rm } from 'node:fs/promises';
import { HttpError } from '../http';
import { absolutePath, deleteMediaFiles } from '../media';
import { cancelProjectJobs } from '../worker';
import { scrubProjectGenerations } from './generations';
import { must, newId, now, PERSONAL_PROFILE_ID, read, write, type Db, type Project } from '../store';

function ensureDefault(db: Db) {
  if (!db.projects.length) {
    db.projects.push({
      id: newId(), title: 'Mein Instagram', kind: 'PERSONAL_CONTENT', description: 'Persönlicher Creator-Content', client: null,
      profileId: PERSONAL_PROFILE_ID, status: 'active', createdAt: now(), updatedAt: now(),
    });
  }
}

/**
 * The project kind decides which gates apply (FitCheck + full lint for PERSONAL_CONTENT, client lint for UGC_CLIENT).
 * Once a project has briefs, concepts, scripts, edit plans, publications or self-assessments its kind is fixed, so a kind switch cannot skip the gate.
 */
export const hasContent = (db: Db, projectId: string) =>
  db.briefs.some((x) => x.projectId === projectId) || db.concepts.some((x) => x.projectId === projectId)
  || db.scripts.some((x) => x.projectId === projectId) || db.editPlans.some((x) => x.projectId === projectId)
  || db.publications.some((x) => x.projectId === projectId) || db.selfAssessments.some((x) => x.projectId === projectId);
export const KIND_LOCKED_MESSAGE = 'Der Projekttyp lässt sich nicht mehr ändern: Das Projekt hat schon Briefings, Konzepte, Skripte, Schnittpläne, Veröffentlichungen oder Selbsteinschätzungen. Für den anderen Typ ein neues Projekt anlegen.';

/** Project plus `kindLocked` (derived, not stored): the UI disables the kind select with the reason. */
export type ProjectView = Project & { kindLocked: boolean };
const view = (db: Db, p: Project): ProjectView => ({ ...p, kindLocked: hasContent(db, p.id) });

export const listProjects = () =>
  write((db) => {
    ensureDefault(db);
    return db.projects.filter((p) => p.status === 'active').map((p) => view(db, p));
  });

export async function createProject(raw: unknown): Promise<Project> {
  const input = ProjectInput.parse(raw);
  return write((db) => {
    const p: Project = {
      id: newId(), title: input.title, kind: input.kind, description: input.description,
      client: input.kind === 'UGC_CLIENT' ? input.client ?? ClientBrief.parse({}) : null,
      profileId: PERSONAL_PROFILE_ID, status: 'active', createdAt: now(), updatedAt: now(),
    };
    db.projects.push(p);
    return p;
  });
}

export async function updateProject(id: string, raw: unknown): Promise<ProjectView> {
  const input = ProjectUpdate.parse(raw);
  return write((db) => {
    const p = must(db.projects.find((x) => x.id === id), 'Projekt');
    if (input.kind !== undefined && input.kind !== p.kind && hasContent(db, id)) throw new HttpError(409, KIND_LOCKED_MESSAGE, 'project_kind_locked');
    const { client, ...fields } = input;
    Object.assign(p, fields, { updatedAt: now() });
    if (client !== undefined) p.client = client === null ? null : { ...(p.client ?? ClientBrief.parse({})), ...client };
    if (p.kind === 'PERSONAL_CONTENT') p.client = null;
    return view(db, p);
  });
}

export const getProject = (id: string) => read((db) => view(db, must(db.projects.find((x) => x.id === id), 'Projekt')));

/** Hard delete incl. briefs, concepts, scripts, publications, snapshots, footage files and video jobs (running ones are aborted). */
export async function deleteProject(id: string) {
  await cancelProjectJobs(id);
  // Etappe 11: override reasons and self-check notes live on their records, so they go with the project in one write.
  const { files } = await write((db) => {
    must(db.projects.find((x) => x.id === id), 'Projekt');
    db.selfAssessments = db.selfAssessments.filter((x) => x.projectId !== id);
    const pubs = new Set(db.publications.filter((p) => p.projectId === id).map((p) => p.id));
    db.metricSnapshots = db.metricSnapshots.filter((s) => !pubs.has(s.publicationId));
    db.publications = db.publications.filter((p) => p.projectId !== id);
    db.scripts = db.scripts.filter((s) => s.projectId !== id);
    db.scriptOutputs = db.scriptOutputs.filter((o) => o.projectId !== id);
    db.researchReports = db.researchReports.filter((r) => r.projectId !== id);
    // Growth reports derived from this project's data go with it.
    db.growthReports = db.growthReports.filter((r) => !r.projectIds.includes(id));
    // Model Lab outputs compared on this project's data, too.
    db.evalRuns = db.evalRuns.filter((r) => !r.projectIds?.includes(id) && !r.publicationIds?.some((p) => pubs.has(p)));
    db.concepts = db.concepts.filter((c) => c.projectId !== id);
    db.strategyGates = db.strategyGates.filter((g) => g.projectId !== id);
    db.briefs = db.briefs.filter((b) => b.projectId !== id);
    db.projects = db.projects.filter((p) => p.id !== id);
    const files = db.mediaAssets.filter((a) => a.projectId === id).map((a) => a.storagePath);
    db.transcripts = db.transcripts.filter((t) => t.projectId !== id); // files: whole transcripts/<id> folder below
    db.silenceScans = db.silenceScans.filter((x) => x.projectId !== id);
    db.mediaAssets = db.mediaAssets.filter((a) => a.projectId !== id);
    db.mediaJobs = db.mediaJobs.filter((j) => j.projectId !== id);
    db.editPlans = db.editPlans.filter((p) => p.projectId !== id);
    db.editDrafts = db.editDrafts.filter((d) => d.projectId !== id);
    // the editor's chat history of this project goes with it (Etappe 15)
    const threads = new Set(db.chatThreads.filter((t) => t.projectId === id).map((t) => t.id));
    db.chatMessages = db.chatMessages.filter((m) => !threads.has(m.threadId));
    db.chatThreads = db.chatThreads.filter((t) => t.projectId !== id);
    db.storyPlans = db.storyPlans.filter((x) => x.projectId !== id); // Etappe 16
    db.carousels = db.carousels.filter((x) => x.projectId !== id); // Etappe 18 (their chat threads carry the project id)
    db.carouselVersions = db.carouselVersions.filter((x) => x.projectId !== id);
    db.stories = db.stories.filter((x) => x.projectId !== id); // Etappe 19
    // Etappe 20: board entries of the project stay as her plan, without the link to the deleted material / Rückblick record
    for (const b of db.boardItems) if (b.projectId === id) Object.assign(b, { projectId: null, ref: null, posted: b.posted ? { ...b.posted, publicationId: null } : null });
    files.push(...db.renders.filter((r) => r.projectId === id && r.storagePath).map((r) => r.storagePath!));
    db.renders = db.renders.filter((r) => r.projectId !== id);
    scrubProjectGenerations(db, id);
    return { files };
  });
  await deleteMediaFiles(files);
  // also a render or generated clip that landed after the records were removed (job finishing during the delete)
  await Promise.all(['renders', 'transcripts', 'footage', 'derived', 'carousels', 'stories'].map((d) => rm(absolutePath(`${d}/${id}`), { recursive: true, force: true }).catch(() => undefined)));
  return { deleted: id };
}
