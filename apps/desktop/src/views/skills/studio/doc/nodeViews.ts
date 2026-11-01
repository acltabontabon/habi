/**
 * The parts of the page that are objects, not text. Written in plain DOM because
 * each one lives inside ProseMirror's own tree. Nothing here runs or fetches what
 * a skill contains: raw blocks stay literal text, and images are read only from
 * the skill's own folder.
 */
import type { Node as PMNode } from "prosemirror-model";
import { NodeSelection } from "prosemirror-state";
import type { EditorView, NodeViewConstructor } from "prosemirror-view";

export type SkillLook = {
  /** How the name reads to a person. */
  title: string;
  /** Deliberately linked, or only named in the words. */
  explicit: boolean;
  /** Found somewhere Habi can see, or not. */
  status: "found" | "unsure" | "missing";
};

export type ViewContext = {
  /** What's known about a named skill. */
  skillLook?: (name: string, role: string | null) => SkillLook;
  onSkillClick?: (name: string, pos: number, rect: DOMRect) => void;
  /** A sentence that uses a skill was picked up by its knot. */
  onLiftUse?: (pos: number, event: PointerEvent) => void;
  onLinkSkill?: (query: string) => void;
  /** The skill's own files, for the tray to offer. */
  files?: () => { path: string; name: string; referenced: boolean }[];
  /** A piece from the tray needs a choice: which skill, or a new file to bring in. */
  onChoosePiece?: (what: "skill" | "file") => void;
  /** A file named in the words was clicked. */
  onFileClick?: (path: string, rect: DOMRect, absent: boolean) => void;
  /** A package file's bytes as a data: URL, if it's an image inside the package. */
  imageData?: (path: string) => Promise<string | null>;
  openExternal?: (href: string) => void;
};

const LABELS: Record<string, string> = {
  html: "HTML, kept as written",
  definition: "Link definition, kept as written",
  footnote: "Footnote, kept as written",
  other: "Kept as written",
};

/** What the editor can't show as rich text: on the page as itself, and still editable. */
export function opaqueView(_ctx: () => ViewContext): NodeViewConstructor {
  return (node: PMNode, view: EditorView, getPos) => {
    const dom = document.createElement("figure");
    dom.className = "doc-opaque";
    dom.setAttribute("data-opaque", node.attrs.kind as string);
    dom.contentEditable = "false";
    const caption = document.createElement("figcaption");
    caption.textContent = LABELS[node.attrs.kind as string] ?? LABELS.other ?? "";
    const pre = document.createElement("pre");
    pre.textContent = node.attrs.raw as string;
    dom.append(caption, pre);

    let current = node;
    let area: HTMLTextAreaElement | null = null;
    const commit = () => {
      if (!area) return;
      const raw = area.value;
      area.remove();
      area = null;
      pre.hidden = false;
      const pos = getPos();
      if (pos === undefined || raw === (current.attrs.raw as string)) return;
      view.dispatch(view.state.tr.setNodeMarkup(pos, null, { ...current.attrs, raw }));
    };
    const edit = () => {
      if (area || !view.editable) return;
      area = document.createElement("textarea");
      area.className = "doc-opaque-edit";
      area.value = current.attrs.raw as string;
      area.setAttribute("aria-label", "Edit this block as written");
      area.rows = Math.min(24, (current.attrs.raw as string).split("\n").length + 1);
      area.spellcheck = false;
      pre.hidden = true;
      dom.append(area);
      area.focus();
      area.addEventListener("blur", commit);
      area.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) {
          e.preventDefault();
          commit();
          view.focus();
        }
      });
      area.addEventListener("input", () => {
        if (area) area.rows = Math.min(24, area.value.split("\n").length + 1);
      });
    };
    dom.addEventListener("dblclick", (e) => {
      e.preventDefault();
      edit();
    });
    pre.addEventListener("click", () => {
      const pos = getPos();
      if (pos !== undefined && !area) {
        view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)));
      }
    });

    return {
      dom,
      update(next) {
        if (next.type !== current.type) return false;
        current = next;
        dom.setAttribute("data-opaque", next.attrs.kind as string);
        if (!area) pre.textContent = next.attrs.raw as string;
        return true;
      },
      selectNode() {
        dom.classList.add("is-selected");
      },
      deselectNode() {
        dom.classList.remove("is-selected");
      },
      stopEvent(event) {
        return event.target instanceof HTMLTextAreaElement;
      },
      ignoreMutation: () => true,
    };
  };
}

function isInside(path: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("//") || path.startsWith("/")) return false;
  return !path.split(/[\\/]/).includes("..");
}

/** An image from the skill's own folder shows itself. Anything else says where it would have come from. */
export function imageView(ctx: () => ViewContext): NodeViewConstructor {
  return (node: PMNode) => {
    const dom = document.createElement("span");
    dom.className = "doc-image";
    dom.contentEditable = "false";
    const fill = (n: PMNode) => {
      dom.textContent = "";
      const src = n.attrs.src as string;
      const alt = n.attrs.alt as string;
      if (!isInside(src)) {
        let host = src;
        try {
          host = new URL(src).host || src;
        } catch {
          // Not a URL: say it as written.
        }
        dom.classList.add("is-remote");
        dom.textContent = `${alt || "Image"} · from ${host}, not loaded`;
        dom.title = "Habi doesn't fetch images from the web.";
        return;
      }
      dom.classList.remove("is-remote");
      const img = document.createElement("img");
      img.alt = alt;
      img.draggable = false;
      dom.append(img);
      void ctx()
        .imageData?.(src)
        .then((data) => {
          if (data) img.src = data;
          else {
            dom.classList.add("is-missing");
            dom.textContent = `${alt || src} · not in this skill`;
          }
        });
    };
    fill(node);
    let current = node;
    return {
      dom,
      update(next) {
        if (next.type !== current.type) return false;
        if (next.attrs.src !== current.attrs.src || next.attrs.alt !== current.attrs.alt) fill(next);
        current = next;
        return true;
      },
      ignoreMutation: () => true,
    };
  };
}

function capitalise(name: string): string {
  return name
    .split("-")
    .map((w) => (w ? (w[0]?.toUpperCase() ?? "") + w.slice(1) : w))
    .join(" ");
}

/** A skill named in the text. It reads as words in the sentence, and acts as one thing. */
export function skillRefView(ctx: () => ViewContext): NodeViewConstructor {
  return (node: PMNode, view: EditorView, getPos) => {
    const dom = document.createElement("span");
    dom.contentEditable = "false";
    dom.setAttribute("role", "button");
    dom.tabIndex = -1;
    const paint = (n: PMNode) => {
      const name = n.attrs.name as string;
      const look = ctx().skillLook?.(name, n.attrs.role as string | null) ?? {
        title: capitalise(name),
        explicit: n.attrs.role !== null,
        status: "unsure" as const,
      };
      dom.className = `doc-skill is-${look.explicit ? "composed" : "mentioned"} is-${look.status}`;
      dom.dataset.skillRef = name;
      dom.textContent = "";
      const word = document.createElement("span");
      word.className = "doc-skill-name";
      word.textContent = n.attrs.plugin ? `${n.attrs.plugin as string}: ${look.title}` : look.title;
      if (look.explicit) {
        const knot = document.createElement("span");
        knot.className = "doc-skill-knot";
        knot.setAttribute("aria-hidden", "true");
        dom.append(knot);
      }
      dom.append(word);
      // The file says "the x skill". A composed one is an object, and needs no noun to say so.
      if (!n.attrs.plugin && !look.explicit) dom.append(document.createTextNode(" skill"));
      if (look.explicit && look.status === "missing") {
        const note = document.createElement("span");
        note.className = "doc-skill-note";
        note.textContent = "not found here";
        dom.append(note);
      }
      const says = look.explicit ? "Linked" : "Mentioned";
      dom.title = look.explicit
        ? "Press to see where it's found and how it's used"
        : "Only named in the words. Press to link it";
      const where = look.status === "missing" ? ", not found here" : "";
      dom.setAttribute("aria-label", `${look.title} skill. ${says}${where}.`);
    };
    paint(node);
    dom.addEventListener("click", (e) => {
      const pos = getPos();
      if (pos === undefined) return;
      e.preventDefault();
      ctx().onSkillClick?.(node.attrs.name as string, pos, dom.getBoundingClientRect());
    });
    let current = node;
    // What's known about skills arrives after the page opens, and changes as libraries do.
    const repaint = () => paint(current);
    view.dom.addEventListener(LOOKS_CHANGED, repaint);
    return {
      dom,
      update(next) {
        if (next.type !== current.type) return false;
        current = next;
        paint(next);
        return true;
      },
      destroy() {
        view.dom.removeEventListener(LOOKS_CHANGED, repaint);
      },
      ignoreMutation: () => true,
    };
  };
}

export const LOOKS_CHANGED = "habi-skill-looks";
export { capitalise };
