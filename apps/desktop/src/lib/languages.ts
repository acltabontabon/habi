/** Languages of files in a skill package, for highlighting. */
export type SourceLanguage =
  | "markdown"
  | "yaml"
  | "json"
  | "javascript"
  | "typescript"
  | "python"
  | "shell"
  | "ruby"
  | "plain";

/** The language of a package file, by its name. */
export function languageFor(path: string): SourceLanguage {
  const name = path.toLowerCase();
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  switch (ext) {
    case "md":
    case "markdown":
      return "markdown";
    case "yaml":
    case "yml":
      return "yaml";
    case "json":
      return "json";
    case "js":
    case "mjs":
    case "cjs":
    case "jsx":
      return "javascript";
    case "ts":
    case "tsx":
    case "mts":
      return "typescript";
    case "py":
      return "python";
    case "sh":
    case "bash":
    case "zsh":
      return "shell";
    case "rb":
      return "ruby";
    default:
      return "plain";
  }
}
