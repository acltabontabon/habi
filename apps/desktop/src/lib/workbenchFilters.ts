/** Local display preferences, stored separately for each project. */
export type WorkbenchFilters = {
  query: string;
  module: string;
  library: string;
  agent: string;
  attention: string;
};

export const emptyWorkbenchFilters: WorkbenchFilters = {
  query: "",
  module: "",
  library: "",
  agent: "",
  attention: "",
};

export function readWorkbenchFilters(projectId: string): WorkbenchFilters {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(`habi.workbench.${projectId}`) ?? "null");
    if (!saved || typeof saved !== "object") return { ...emptyWorkbenchFilters };
    return Object.fromEntries(
      Object.keys(emptyWorkbenchFilters).map((key) => {
        const value = (saved as Record<string, unknown>)[key];
        return [key, typeof value === "string" && value.length <= 2000 ? value : ""];
      }),
    ) as WorkbenchFilters;
  } catch {
    return { ...emptyWorkbenchFilters };
  }
}

export function saveWorkbenchFilters(projectId: string, filters: WorkbenchFilters) {
  try {
    localStorage.setItem(`habi.workbench.${projectId}`, JSON.stringify(filters));
  } catch {
    // Filtering still works when browser storage is unavailable.
  }
}
