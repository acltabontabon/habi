/** Data fetching with TanStack Query: caching, loading and error states. */
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { api, HabiError, newJobId } from "./api";

export const keys = {
  appInfo: ["appInfo"] as const,
  settings: ["settings"] as const,
  recent: ["recentProjects"] as const,
  sources: ["sources"] as const,
  catalog: ["catalog"] as const,
  sourceUpdates: ["sourceUpdates"] as const,
  updateReport: (sourceId: string) => ["updateReport", sourceId] as const,
  catalogFits: (projectId: string) => ["catalogFits", projectId] as const,
  library: (id: string) => ["library", id] as const,
  item: (sourceId: string, itemId: string) => ["item", sourceId, itemId] as const,
  overview: (projectId: string) => ["overview", projectId] as const,
  history: (projectId: string) => ["history", projectId] as const,
  contributions: ["contributions"] as const,
  contribution: (id: string) => ["contribution", id] as const,
  checkRuns: (projectId: string, itemKey: string) => ["checkRuns", projectId, itemKey] as const,
  skills: ["skills"] as const,
  skill: (id: string) => ["skill", id] as const,
  skillsOverview: ["skillsOverview"] as const,
  skillTemplates: ["skillTemplates"] as const,
  knowledge: (projectId: string) => ["knowledge", projectId] as const,
};

export function useAppInfo() {
  return useQuery({ queryKey: keys.appInfo, queryFn: api.appInfo, staleTime: Number.POSITIVE_INFINITY });
}

export function useSettings() {
  return useQuery({ queryKey: keys.settings, queryFn: api.getSettings });
}

export function useRecentProjects() {
  return useQuery({ queryKey: keys.recent, queryFn: api.recentProjects });
}

export function useSources() {
  return useQuery({ queryKey: keys.sources, queryFn: api.listSources });
}

/** The catalog of public libraries, with what is known of each. Local data only. */
export function useCatalog() {
  return useQuery({ queryKey: keys.catalog, queryFn: api.catalog });
}

/**
 * What the last checks found: which libraries have something newer than what
 * they read. Local data only; a check is a separate, explicit request.
 */
export function useSourceUpdates() {
  return useQuery({ queryKey: keys.sourceUpdates, queryFn: api.sourceUpdates });
}

/** What the last update changed in a library, until the user has read it. */
export function useUpdateReport(sourceId: string | undefined) {
  return useQuery({
    queryKey: keys.updateReport(sourceId ?? ""),
    queryFn: () => api.sourceUpdateReport(sourceId ?? ""),
    enabled: Boolean(sourceId),
  });
}

/** Asks whether a library has something newer. Downloads nothing, changes nothing. */
export function useCheckUpdate() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (sourceId: string) => api.checkSourceUpdate(sourceId),
    onSettled: () => void client.invalidateQueries({ queryKey: keys.sourceUpdates }),
  });
}

/** What GitHub says about a catalog repository. Optional context: never an error, absent when unavailable. */
export function useRepoFacts(entryId: string | undefined) {
  return useQuery({
    queryKey: ["repoFacts", entryId ?? ""],
    queryFn: () => api.catalogRepoFacts(entryId ?? "").catch(() => null),
    enabled: Boolean(entryId),
    staleTime: 60 * 60 * 1000,
  });
}

/** Skills of fetched catalog libraries that fit a project (nothing is downloaded). */
export function useCatalogFits(projectId: string | undefined) {
  return useQuery({
    queryKey: keys.catalogFits(projectId ?? ""),
    queryFn: () => api.catalogFits(projectId ?? ""),
    enabled: Boolean(projectId),
    staleTime: 60_000,
  });
}

export function useLibrary(sourceId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: keys.library(sourceId ?? ""),
    queryFn: () => api.library(sourceId ?? ""),
    enabled: Boolean(sourceId) && enabled,
  });
}

export function useItemDetail(sourceId: string | undefined, itemId: string | undefined) {
  return useQuery({
    queryKey: keys.item(sourceId ?? "", itemId ?? ""),
    queryFn: () => api.itemDetail(sourceId ?? "", itemId ?? ""),
    enabled: Boolean(sourceId && itemId),
  });
}

/**
 * The project overview (inspection + recommendations). Inspection runs in a
 * cancellable background job; leaving the project cancels it.
 */
export function useOverview(projectId: string | undefined) {
  const client = useQueryClient();
  const jobRef = useRef<string | null>(null);
  const rescanRef = useRef(false);
  // Only a Cancel the person pressed shows as cancelled.
  const stoppedRef = useRef(false);
  const query = useQuery({
    queryKey: keys.overview(projectId ?? ""),
    enabled: Boolean(projectId),
    staleTime: 60_000,
    // An inspection stopped by anything else (a remount racing its own cancel)
    // is simply started again, once.
    retry: (failures, error) =>
      failures < 1 && !stoppedRef.current && error instanceof HabiError && error.code === "cancelled",
    retryDelay: 0,
    queryFn: async () => {
      stoppedRef.current = false;
      const job = newJobId();
      jobRef.current = job;
      const rescan = rescanRef.current;
      rescanRef.current = false;
      try {
        const overview = await api.projectOverview(projectId ?? "", rescan, job);
        // The project's summary (what fits) was just recorded; lists show it.
        void client.invalidateQueries({ queryKey: keys.recent });
        return overview;
      } finally {
        if (jobRef.current === job) jobRef.current = null;
      }
    },
  });
  useEffect(() => {
    return () => {
      if (!jobRef.current) return;
      // Leaving stops the inspection, and the query goes back to not loaded
      // rather than failed: coming back (or StrictMode's remount, which can
      // race this cancel) inspects again instead of showing "cancelled".
      void client.cancelQueries({ queryKey: keys.overview(projectId ?? "") });
      void api.cancelJob(jobRef.current);
    };
  }, [client, projectId]);
  const rescan = () => {
    // The inspection already running is superseded; stop it rather than let it finish unseen.
    if (jobRef.current) void api.cancelJob(jobRef.current);
    rescanRef.current = true;
    return query.refetch();
  };
  const cancel = () => {
    stoppedRef.current = true;
    if (jobRef.current) void api.cancelJob(jobRef.current);
  };
  return { ...query, rescan, cancel };
}

export function useHistory(projectId: string | undefined) {
  return useQuery({
    queryKey: keys.history(projectId ?? ""),
    queryFn: () => api.history(projectId ?? ""),
    enabled: Boolean(projectId),
  });
}

export function useContributions() {
  return useQuery({ queryKey: keys.contributions, queryFn: api.listContributions });
}

export function useContribution(id: string | undefined) {
  return useQuery({
    queryKey: keys.contribution(id ?? ""),
    queryFn: () => api.contribution(id ?? ""),
    enabled: Boolean(id),
  });
}

export function useSkills() {
  return useQuery({ queryKey: keys.skills, queryFn: api.listSkills });
}

/**
 * Where each skill is installed and whether its library moved on. Reads every
 * project's lock file, so it is shared and kept for a while rather than
 * refetched with every list.
 */
export function useSkillsOverview(enabled = true) {
  return useQuery({
    queryKey: keys.skillsOverview,
    queryFn: api.skillsOverview,
    staleTime: 30_000,
    enabled,
  });
}

/** The starters the editor offers; they ship with Habi. */
export function useSkillTemplates() {
  return useQuery({
    queryKey: keys.skillTemplates,
    queryFn: api.skillTemplates,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** Skills and instruction files already in a project (read-only discovery). */
export function useKnowledge(projectId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: keys.knowledge(projectId ?? ""),
    queryFn: () => api.discoverProject(projectId ?? ""),
    enabled: Boolean(projectId) && enabled,
    staleTime: 30_000,
  });
}

/** After local skills change: lists, and anything matched against projects. */
export function invalidateSkills(client: QueryClient) {
  void client.invalidateQueries({ queryKey: keys.skills });
  void client.invalidateQueries({ queryKey: keys.skillsOverview });
  void client.invalidateQueries({ queryKey: ["knowledge"] });
  void client.invalidateQueries({ queryKey: ["overview"] });
}

export function useCheckRuns(projectId: string, itemKey: string) {
  return useQuery({
    queryKey: keys.checkRuns(projectId, itemKey),
    queryFn: () => api.checkRuns(projectId, itemKey),
  });
}

/** After anything that may change recommendations, refresh the dependent views. */
export function invalidateProjectData(client: QueryClient, projectId?: string) {
  void client.invalidateQueries({ queryKey: keys.sources });
  void client.invalidateQueries({ queryKey: keys.catalog });
  void client.invalidateQueries({ queryKey: keys.sourceUpdates });
  void client.invalidateQueries({ queryKey: ["updateReport"] });
  void client.invalidateQueries({ queryKey: ["catalogFits"] });
  void client.invalidateQueries({ queryKey: ["library"] });
  void client.invalidateQueries({ queryKey: ["item"] });
  if (projectId) {
    void client.invalidateQueries({ queryKey: keys.overview(projectId) });
    void client.invalidateQueries({ queryKey: keys.history(projectId) });
    void client.invalidateQueries({ queryKey: keys.knowledge(projectId) });
  } else {
    void client.invalidateQueries({ queryKey: ["overview"] });
    void client.invalidateQueries({ queryKey: ["history"] });
  }
}

export function useRefreshSource() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (sourceId: string) => api.refreshSource(sourceId, newJobId()),
    onSettled: () => invalidateProjectData(client),
  });
}
