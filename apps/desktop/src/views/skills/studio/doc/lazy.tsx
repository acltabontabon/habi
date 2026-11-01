/** The page arrives with the Studio's other heavy code, the first time a skill is opened. */
import { type ComponentProps, lazy, Suspense } from "react";
import { Loading } from "../../../../components/lazy";
import type { DocEditorHandle } from "./DocEditor";

const DocEditorImpl = lazy(() => import("./DocEditor").then((m) => ({ default: m.DocEditor })));

export function DocEditor(props: ComponentProps<typeof DocEditorImpl>) {
  return (
    <Suspense fallback={<Loading />}>
      <DocEditorImpl {...props} />
    </Suspense>
  );
}

export type { DocEditorHandle };
