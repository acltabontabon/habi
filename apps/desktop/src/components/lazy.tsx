/**
 * Heavy components loaded on first use, so the first screen does not wait
 * for the Markdown renderer or the CodeMirror editor. Same props as the
 * originals; a quiet line shows while the code arrives.
 */
import { type ComponentProps, lazy, Suspense } from "react";

const MarkdownImpl = lazy(() => import("./Markdown").then((m) => ({ default: m.Markdown })));
const SourceEditorImpl = lazy(() => import("./SourceEditor").then((m) => ({ default: m.SourceEditor })));

function Loading() {
  return <p className="muted lazy-loading">Loading…</p>;
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
