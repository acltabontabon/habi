/**
 * Heavy components loaded on first use, so the first screen does not wait
 * for the Markdown renderer or the CodeMirror editor. Same props as the
 * originals; the loom weaves while the code arrives.
 */
import { type ComponentProps, lazy, Suspense } from "react";
import { Working } from "./ui";

const MarkdownImpl = lazy(() => import("./Markdown").then((m) => ({ default: m.Markdown })));
const SourceEditorImpl = lazy(() => import("./SourceEditor").then((m) => ({ default: m.SourceEditor })));

/**
 * While a piece of the app's code arrives: the same weaving loom as every other wait, after the
 * same short pause, so a fast load shows nothing. `stage` holds a whole page's place.
 */
export function Loading({ stage = false }: { stage?: boolean }) {
  return <Working stage={stage}>Loading…</Working>;
}

export function Markdown(props: ComponentProps<typeof MarkdownImpl>) {
  return (
    <Suspense fallback={<Loading />}>
      <MarkdownImpl {...props} />
    </Suspense>
  );
}

export function SourceEditor(props: ComponentProps<typeof SourceEditorImpl>) {
  return (
    <Suspense fallback={<Loading />}>
      <SourceEditorImpl {...props} />
    </Suspense>
  );
}
