/**
 * Heavy components loaded on first use, so the first screen does not wait
 * for the Markdown renderer or the CodeMirror editor. Same props as the
 * originals; a quiet line shows while the code arrives.
 */
import { type ComponentProps, lazy, Suspense } from "react";

const MarkdownImpl = lazy(() => import("./Markdown").then((m) => ({ default: m.Markdown })));
const MarkdownEditorImpl = lazy(() =>
  import("./MarkdownEditor").then((m) => ({ default: m.MarkdownEditor })),
);

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

export function MarkdownEditor(props: ComponentProps<typeof MarkdownEditorImpl>) {
  return (
    <Suspense fallback={<Loading />}>
      <MarkdownEditorImpl {...props} />
    </Suspense>
  );
}
