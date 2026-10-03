/**
 * Typed wrappers around Habi's Tauri commands.
 *
 * Request and response types are generated from Rust (`src/bindings`), so
 * the contract is checked on both sides. Business rules live in Rust; this
 * module only moves data.
 */
import { invoke } from "@tauri-apps/api/core";
import type { AppInfo } from "../bindings/AppInfo";
import type { CatalogEntry } from "../bindings/CatalogEntry";
import type { CatalogFit } from "../bindings/CatalogFit";
import type { CheckPreview } from "../bindings/CheckPreview";
import type { CheckRun } from "../bindings/CheckRun";
import type { ClientId } from "../bindings/ClientId";
import type { ConditionSuggestion } from "../bindings/ConditionSuggestion";
import type { Contribution } from "../bindings/Contribution";
import type { ContributionOrigin } from "../bindings/ContributionOrigin";
import type { Declaration } from "../bindings/Declaration";
import type { DeclaredSubject } from "../bindings/DeclaredSubject";
import type { DiagnosticBundle } from "../bindings/DiagnosticBundle";
import type { ErrorInfo } from "../bindings/ErrorInfo";
import type { Excerpt } from "../bindings/Excerpt";
import type { FileContent } from "../bindings/FileContent";
import type { FileMatch } from "../bindings/FileMatch";
import type { FolderListing } from "../bindings/FolderListing";
import type { GitCopy } from "../bindings/GitCopy";
import type { ImportFrom } from "../bindings/ImportFrom";
import type { ImportInspection } from "../bindings/ImportInspection";
import type { ImportOutcome } from "../bindings/ImportOutcome";
import type { ImportSelection } from "../bindings/ImportSelection";
import type { InstallShadow } from "../bindings/InstallShadow";
import type { InstructionDocument } from "../bindings/InstructionDocument";
import type { ItemDetail } from "../bindings/ItemDetail";
import type { ItemRef } from "../bindings/ItemRef";
import type { LibraryIndex } from "../bindings/LibraryIndex";
import type { LocalChanges } from "../bindings/LocalChanges";
import type { LocalSkill } from "../bindings/LocalSkill";
import type { LocalSkillSummary } from "../bindings/LocalSkillSummary";
import type { MachineSkill } from "../bindings/MachineSkill";
import type { NewSkill } from "../bindings/NewSkill";
import type { NewSource } from "../bindings/NewSource";
import type { OperationSummary } from "../bindings/OperationSummary";
import type { Plan } from "../bindings/Plan";
import type { PreviewRequest } from "../bindings/PreviewRequest";
import type { ProjectKnowledge } from "../bindings/ProjectKnowledge";
import type { ProjectOverview } from "../bindings/ProjectOverview";
import type { ProjectPick } from "../bindings/ProjectPick";
import type { ProjectPlaces } from "../bindings/ProjectPlaces";
import type { ProjectRecord } from "../bindings/ProjectRecord";
import type { PruneReport } from "../bindings/PruneReport";
import type { PublishOutcome } from "../bindings/PublishOutcome";
import type { RefreshOutcome } from "../bindings/RefreshOutcome";
import type { Rehearsal } from "../bindings/Rehearsal";
import type { RepoFacts } from "../bindings/RepoFacts";
import type { Resolution } from "../bindings/Resolution";
import type { SampleWorkspace } from "../bindings/SampleWorkspace";
import type { Settings } from "../bindings/Settings";
import type { ShareForm } from "../bindings/ShareForm";
import type { SkillDocument } from "../bindings/SkillDocument";
import type { SkillFileContent } from "../bindings/SkillFileContent";
import type { SkillPreview } from "../bindings/SkillPreview";
import type { SkillStanding } from "../bindings/SkillStanding";
import type { Source } from "../bindings/Source";
import type { SourceRole } from "../bindings/SourceRole";
import type { SourceUpdate } from "../bindings/SourceUpdate";
import type { TemplateInfo } from "../bindings/TemplateInfo";
import type { UpdateInfo } from "../bindings/UpdateInfo";
import type { UpdateReport } from "../bindings/UpdateReport";
import type { UpstreamChoice } from "../bindings/UpstreamChoice";
import type { UpstreamPlan } from "../bindings/UpstreamPlan";
import type { UpstreamStatus } from "../bindings/UpstreamStatus";

export type Decisions = Record<string, Resolution>;

/** Error thrown by every API call: always has a stable code and a human message. */
export class HabiError extends Error {
  readonly code: string;
  constructor(info: ErrorInfo) {
    super(info.message);
    this.code = info.code;
    this.name = "HabiError";
  }
}

function isErrorInfo(value: unknown): value is ErrorInfo {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ErrorInfo).code === "string" &&
    typeof (value as ErrorInfo).message === "string"
  );
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    if (isErrorInfo(error)) throw new HabiError(error);
    throw new HabiError({ code: "internal", message: String(error) });
  }
}

export function newJobId(): string {
  return crypto.randomUUID();
}

export const api = {
  appInfo: () => call<AppInfo>("app_info"),
  /** Asks GitHub whether a newer Habi exists; null when this is the newest. */
  checkForUpdate: () => call<UpdateInfo | null>("check_for_update"),
  /**
   * Downloads and installs what the last check found (progress arrives as `update-progress`). On
   * Windows it never returns: Habi ends as the installer starts, so write pending edits first.
   */
  installUpdate: () => call<void>("install_update"),
  restartApp: () => call<void>("restart_app"),
  getSettings: () => call<Settings>("get_settings"),
  setSettings: (settings: Settings) => call<Settings>("set_settings", { settings }),
  cancelJob: (jobId: string) => call<boolean>("cancel_job", { jobId }),
  logUiError: (message: string, detail: string | null) => call<void>("log_ui_error", { message, detail }),

  pickProject: () => call<ProjectPick | null>("pick_project"),
  /** A folder `pickProject` held back as a skills folder, opened anyway. */
  openPickedProject: (path: string) => call<ProjectRecord>("open_picked_project", { path }),
  projectPlaces: () => call<ProjectPlaces>("project_places"),
  browseFolder: (path: string) => call<FolderListing>("browse_folder", { path }),
  openBrowsedProject: (path: string) => call<ProjectRecord>("open_browsed_project", { path }),
  openRecentProject: (projectId: string) => call<ProjectRecord>("open_recent_project", { projectId }),
  recentProjects: () => call<ProjectRecord[]>("recent_projects"),
  forgetProject: (projectId: string) => call<void>("forget_project", { projectId }),
  setExclusions: (projectId: string, exclusions: string[]) =>
    call<ProjectRecord>("set_exclusions", { projectId, exclusions }),
  projectOverview: (projectId: string, rescan: boolean, jobId?: string) =>
    call<ProjectOverview>("project_overview", { projectId, rescan, jobId: jobId ?? null }),
  watchProject: (projectId: string) => call<void>("watch_project", { projectId }),
  unwatchProject: (projectId: string) => call<void>("unwatch_project", { projectId }),
  readProjectExcerpt: (projectId: string, path: string, line: number | null) =>
    call<Excerpt>("read_project_excerpt", { projectId, path, line }),
  revealProjectPath: (projectId: string, path: string | null) =>
    call<void>("reveal_project_path", { projectId, path }),
  openExternal: (url: string) => call<void>("open_external", { url }),
  declare: (
    projectId: string,
    module: string,
    subject: DeclaredSubject,
    present: boolean,
    note: string | null,
  ) => call<Declaration>("declare", { projectId, module, subject, present, note }),
  retract: (projectId: string, declarationId: string) => call<void>("retract", { projectId, declarationId }),

  listSources: () => call<Source[]>("list_sources"),
  /** The public libraries Habi suggests, with what is known of each. */
  catalog: () => call<CatalogEntry[]>("catalog"),
  /** What GitHub says about a catalog repository (stars, forks, last push, archived); null when it cannot be had. */
  catalogRepoFacts: (entryId: string) =>
    call<RepoFacts | null>("catalog_repo_facts", { entryId, jobId: null }),
  connectCatalogEntry: (entryId: string, jobId?: string) =>
    call<Source>("connect_catalog_entry", { entryId, jobId: jobId ?? null }),
  /** Skills of already fetched catalog libraries that fit a project. */
  catalogFits: (projectId: string, jobId?: string) =>
    call<CatalogFit[]>("catalog_fits", { projectId, jobId: jobId ?? null }),
  pickLibraryFolder: () => call<string | null>("pick_library_folder"),
  addSource: (source: NewSource) => call<Source>("add_source", { source }),
  removeSource: (sourceId: string) => call<void>("remove_source", { sourceId }),
  setSourceRole: (sourceId: string, role: SourceRole) => call<Source>("set_source_role", { sourceId, role }),
  refreshSource: (sourceId: string, jobId?: string) =>
    call<RefreshOutcome>("refresh_source", { sourceId, jobId: jobId ?? null }),
  /** Asks whether a library's repository has something newer. Downloads and changes nothing. */
  checkSourceUpdate: (sourceId: string) =>
    call<SourceUpdate | null>("check_source_update", { sourceId, jobId: null }),
  sourceUpdates: () => call<SourceUpdate[]>("source_updates"),
  sourceUpdateReport: (sourceId: string) => call<UpdateReport | null>("source_update_report", { sourceId }),
  dismissUpdateReport: (sourceId: string) => call<void>("dismiss_update_report", { sourceId }),
  library: (sourceId: string) => call<LibraryIndex>("library", { sourceId }),
  itemDetail: (sourceId: string, itemId: string) => call<ItemDetail>("item_detail", { sourceId, itemId }),
  itemFile: (sourceId: string, itemId: string, path: string) =>
    call<FileContent>("item_file", { sourceId, itemId, path }),

  planInstall: (
    projectId: string,
    items: ItemRef[],
    clients: ClientId[],
    includeMcp: boolean,
    decisions: Decisions,
  ) => call<Plan>("plan_install", { projectId, items, clients, includeMcp, decisions }),
  planUpdate: (projectId: string, keys: string[], addMcp: boolean, decisions: Decisions) =>
    call<Plan>("plan_update", { projectId, keys, addMcp, decisions }),
  planRemove: (projectId: string, keys: string[], decisions: Decisions) =>
    call<Plan>("plan_remove", { projectId, keys, decisions }),
  planRestore: (projectId: string, operationId: string, decisions: Decisions) =>
    call<Plan>("plan_restore", { projectId, operationId, decisions }),
  /** The same reviewed plans for the person's own skill folders ("this machine"). */
  /** The agents a project (or, with `null`, this machine) already shows signs of using. */
  detectedClients: (projectId: string | null) => call<ClientId[]>("detected_clients", { projectId }),
  planInstallMachine: (items: ItemRef[], clients: ClientId[], decisions: Decisions) =>
    call<Plan>("plan_install_machine", { items, clients, decisions }),
  planUpdateMachine: (keys: string[], decisions: Decisions) =>
    call<Plan>("plan_update_machine", { keys, decisions }),
  planRemoveMachine: (keys: string[], decisions: Decisions) =>
    call<Plan>("plan_remove_machine", { keys, decisions }),
  planRestoreMachine: (operationId: string, decisions: Decisions) =>
    call<Plan>("plan_restore_machine", { operationId, decisions }),
  /** Projects that hold a skill of the same name as each item, and how the copies compare. */
  machineInstallPreview: (items: ItemRef[], clients: ClientId[]) =>
    call<InstallShadow[]>("machine_install_preview", { items, clients }),
  machineHistory: () => call<OperationSummary[]>("machine_history"),
  applyPlan: (planId: string) => call<OperationSummary>("apply_plan", { planId }),
  history: (projectId: string) => call<OperationSummary[]>("history", { projectId }),
  recover: (projectId: string) => call<OperationSummary[]>("recover", { projectId }),

  prepareCheck: (
    projectId: string,
    itemKey: string,
    checkId: string,
    module: string,
    bindings: Record<string, string>,
  ) => call<CheckPreview>("prepare_check", { projectId, itemKey, checkId, module, bindings }),
  runCheck: (projectId: string, previewId: string, jobId: string) =>
    call<CheckRun>("run_check", { projectId, previewId, jobId }),
  checkRuns: (projectId: string, itemKey: string) => call<CheckRun[]>("check_runs", { projectId, itemKey }),

  startContribution: (sourceId: string, origin: ContributionOrigin) =>
    call<Contribution>("start_contribution", { sourceId, origin }),
  contribution: (id: string) => call<Contribution>("contribution", { id }),
  listContributions: () => call<Contribution[]>("list_contributions"),
  updateContribution: (id: string, title: string, message: string, form: ShareForm) =>
    call<Contribution>("update_contribution", { id, title, message, form }),
  /** Leaves changed files (library paths) out of the contribution; the rest are included. */
  selectContributionFiles: (id: string, excluded: string[]) =>
    call<Contribution>("select_contribution_files", { id, excluded }),
  recordContributionLineage: (id: string, record: boolean) =>
    call<Contribution>("record_contribution_lineage", { id, record }),
  commitContribution: (id: string, jobId?: string, buildOnRemote = false) =>
    call<Contribution>("commit_contribution", { id, jobId: jobId ?? null, buildOnRemote }),
  /** Reopens a sent contribution; the next branch and send update the same request. */
  reviseContribution: (id: string, jobId?: string) =>
    call<Contribution>("revise_contribution", { id, jobId: jobId ?? null }),
  /** Undoes Revise: back to the version that was sent. */
  cancelContributionRevision: (id: string) => call<Contribution>("cancel_contribution_revision", { id }),
  /** Where the contribution's rules apply among the author's projects (nothing is sent). */
  contributionRehearsal: (id: string, jobId?: string) =>
    call<Rehearsal>("contribution_rehearsal", { id, jobId: jobId ?? null }),
  /** Reads the request's state and comments from the Git host (only when asked). */
  refreshContributionReview: (id: string, jobId?: string) =>
    call<Contribution>("refresh_contribution_review", { id, jobId: jobId ?? null }),
  exportContribution: (id: string) => call<string | null>("export_contribution", { id }),
  publishContribution: (id: string, openRequest: boolean, jobId?: string) =>
    call<PublishOutcome>("publish_contribution", { id, openRequest, jobId: jobId ?? null }),
  discardContribution: (id: string) => call<void>("discard_contribution", { id }),

  listSkills: () => call<LocalSkillSummary[]>("list_skills"),
  getSkill: (id: string) => call<LocalSkill>("get_skill", { id }),
  createSkill: (skill: NewSkill, projectId: string | null) =>
    call<LocalSkill>("create_skill", { skill, projectId }),
  saveSkillDocument: (id: string, title: string, document: SkillDocument, baseDigest: string | null) =>
    call<LocalSkill>("save_skill_document", { id, title, document, baseDigest }),
  saveSkillApplicability: (id: string, form: ShareForm, baseDigest: string | null) =>
    call<LocalSkill>("save_skill_applicability", { id, form, baseDigest }),
  saveSkillMetadata: (id: string, text: string, baseDigest: string | null) =>
    call<LocalSkill>("save_skill_metadata", { id, text, baseDigest }),
  readSkillFile: (id: string, path: string) => call<SkillFileContent>("read_skill_file", { id, path }),
  writeSkillFile: (id: string, path: string, text: string, baseDigest: string | null) =>
    call<LocalSkill>("write_skill_file", { id, path, text, baseDigest }),
  removeSkillPath: (id: string, path: string) => call<LocalSkill>("remove_skill_path", { id, path }),
  renameSkillPath: (id: string, from: string, to: string) =>
    call<LocalSkill>("rename_skill_path", { id, from, to }),
  setSkillFileExecutable: (id: string, path: string, executable: boolean) =>
    call<LocalSkill>("set_skill_file_executable", { id, path, executable }),
  replaceSkillFile: (id: string, path: string) => call<LocalSkill | null>("replace_skill_file", { id, path }),
  openSkillFile: (id: string, path: string) => call<void>("open_skill_file", { id, path }),
  addSkillFiles: (id: string, folder: string) => call<LocalSkill | null>("add_skill_files", { id, folder }),
  trashSkill: (id: string) => call<void>("trash_skill", { id }),
  restoreSkill: (id: string) => call<LocalSkill>("restore_skill", { id }),
  purgeSkill: (id: string) => call<void>("purge_skill", { id }),
  exportSkill: (id: string) => call<string | null>("export_skill", { id }),
  revealSkill: (id: string) => call<void>("reveal_skill", { id }),
  previewSkill: (request: PreviewRequest, jobId: string) =>
    call<SkillPreview>("preview_skill", { request, jobId }),
  suggestConditions: (projectId: string) => call<ConditionSuggestion[]>("suggest_conditions", { projectId }),
  discoverProject: (projectId: string, jobId?: string) =>
    call<ProjectKnowledge>("discover_project", { projectId, jobId: jobId ?? null }),
  readInstructions: (projectId: string, path: string) =>
    call<InstructionDocument>("read_instructions", { projectId, path }),
  createSkillFromInstructions: (
    projectId: string,
    path: string,
    startLine: number,
    endLine: number,
    title: string,
  ) => call<LocalSkill>("create_skill_from_instructions", { projectId, path, startLine, endLine, title }),
  pickImportFolder: () => call<string | null>("pick_import_folder"),
  inspectImport: (from: ImportFrom, jobId?: string) =>
    call<ImportInspection>("inspect_import", { from, jobId: jobId ?? null }),
  /** Fetches a Git repository to copy from, without connecting it (remote addresses only). */
  openGitCopy: (location: string, jobId?: string) =>
    call<GitCopy>("open_git_copy", { location, jobId: jobId ?? null }),
  /** Discards a repository opened for copying; copies already made keep their original. */
  forgetGitCopy: (sourceId: string) => call<void>("forget_git_copy", { sourceId }),
  importSkills: (from: ImportFrom, selections: ImportSelection[], jobId?: string) =>
    call<ImportOutcome>("import_skills", { from, selections, jobId: jobId ?? null }),
  /** Where each skill is installed and whether its library has a newer version; reads lock files. */
  skillsOverview: () => call<SkillStanding[]>("skills_overview"),
  /** Skills in the person's own folders (`~/.claude/skills` and the like); reads only. */
  machineSkills: () => call<MachineSkill[]>("machine_skills"),
  /** What a copy changed since it was made or last updated; writes nothing. */
  skillLocalChanges: (id: string) => call<LocalChanges>("skill_local_changes", { id }),
  skillTemplates: () => call<TemplateInfo[]>("skill_templates"),
  /** Lines of a skill's text files containing `query`; reads only. */
  searchSkillFiles: (id: string, query: string) => call<FileMatch[]>("search_skill_files", { id, query }),
  /** Copies files dropped onto the window into a folder of the skill; never overwrites. */
  addDroppedSkillFiles: (id: string, folder: string, paths: string[]) =>
    call<LocalSkill>("add_dropped_skill_files", { id, folder, paths }),
  /** For a copy of a library item: has that item changed, been removed, or can it not be compared? */
  skillUpstream: (id: string) => call<UpstreamStatus | null>("skill_upstream", { id }),
  /** File-by-file comparison with the library; writes nothing. */
  planUpstreamSync: (id: string) => call<UpstreamPlan>("plan_upstream_sync", { id }),
  /** Takes the reviewed library changes; every conflict needs a choice in `decisions`. */
  applyUpstreamSync: (id: string, token: string, decisions: Record<string, UpstreamChoice>) =>
    call<LocalSkill>("apply_upstream_sync", { id, token, decisions }),

  diagnosticsPreview: () => call<DiagnosticBundle>("diagnostics_preview"),
  diagnosticsSave: () => call<string | null>("diagnostics_save"),
  createSampleWorkspace: () => call<SampleWorkspace>("create_sample_workspace"),
  /** Removes the sample libraries, the sample projects and their folder; nothing else. */
  removeSampleWorkspace: () => call<void>("remove_sample_workspace"),
  /** Removes old operation records and library snapshots, and stored file versions nothing refers to. */
  freeUpSpace: () => call<PruneReport>("free_up_space"),
};
