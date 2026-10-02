/** Data fetching with TanStack Query: caching, loading and error states. */
import { type QueryClient, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { Source } from "../bindings/Source";
import { api, newJobId } from "./api";

export const keys = {
  appInfo: ["appInfo"] as const,
  settings: ["settings"] as const,
  recent: ["recentProjects"] as const,
  sources: ["sources"] as const,
  library: (id: string) => ["library", id] as const,
  item: (sourceId: string, itemId: string) => ["item", sourceId, itemId] as const,
  overview: (projectId: string) => ["overview", projectId] as const,
  history: (projectId: string) => ["history", projectId] as const,
  contributions: ["contributions"] as const,
  contribution: (id: string) => ["contribution", id] as const,
  checkRuns: (projectId: string, itemKey: string) => ["checkRuns", projectId, itemKey] as const,
  skills: ["skills"] as const,
  skill: (id: string) => ["skill", id] as const,
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

/** The fetched libraries' indexes, for views that span all of them. */
export function useLibraries(sources: Source[]) {
  return useQueries({
    queries: sources
      .filter((s) => s.snapshot)
      .map((s) => ({ queryKey: keys.library(s.id), queryFn: () => api.library(s.id) })),
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
  const query = useQuery({
    queryKey: keys.overview(projectId ?? ""),
    enabled: Boolean(projectId),
    staleTime: 60_000,
    queryFn: async () => {
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
      if (jobRef.current) void api.cancelJob(jobRef.current);
    };
  }, []);
  const rescan = () => {
    rescanRef.current = true;
    return query.refetch();
  };
  const cancel = () => {
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
