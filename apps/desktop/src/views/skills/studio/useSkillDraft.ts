/**
 * One skill, being edited: what is on screen, how it is saved, and how the
 * screen and the files on disk are reconciled.
 *
 * Three autosaves write three parts — SKILL.md (title, identifier, purpose,
 * instructions), and the rules as either the builder's form or the YAML as
 * typed. They live here, above every mode of the Studio, so switching modes
 * never unmounts a save that is still pending. Each save names the digest it
 * started from; a file changed outside Habi stops saving until the author
 * chooses a version, so neither is lost.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LocalSkill } from "../../../bindings/LocalSkill";
import type { LocalSkillSummary } from "../../../bindings/LocalSkillSummary";
import type { PreviewRequest } from "../../../bindings/PreviewRequest";
import type { ShareForm } from "../../../bindings/ShareForm";
import type { SkillDocument } from "../../../bindings/SkillDocument";
import { api } from "../../../lib/api";
import { invalidateSkills, keys } from "../../../lib/queries";
import { type SaveState, useAutosave } from "../../../lib/useAutosave";

export const NOT_SAVED =
  "Nothing was done: your latest edits are not saved. Resolve that above, then try again.";

type DocValue = { title: string; document: SkillDocument };

const docKey = (v: DocValue) =>
  JSON.stringify([v.title, v.document.name, v.document.description, v.document.body]);
const formKey = (f: ShareForm) => JSON.stringify(f);

const RANK: SaveState[] = ["clean", "saved", "pending", "saving", "error", "conflict"];
function worst(...states: SaveState[]): SaveState {
  return states.reduce((a, b) => (RANK.indexOf(b) > RANK.indexOf(a) ? b : a), "clean");
}

export function useSkillDraft(initial: LocalSkill) {
  const id = initial.summary.id;
  const client = useQueryClient();
  const [skill, setSkill] = useState(initial);
  const [title, setTitle] = useState(initial.summary.title);
  const [document, setDocument] = useState(initial.document);
  const [form, setForm] = useState<ShareForm>({ ...initial.form, title: initial.summary.title });
  const [yaml, setYaml] = useState(initial.metadataText ?? "");
  const [yamlMode, setYamlMode] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  const docDigest = useRef(initial.documentDigest);
  const metaDigest = useRef(initial.metadataDigest);

  const trashed = skill.summary.deletedAt !== null;
  const broken = skill.documentError !== null;

  const docValue = useMemo(() => ({ title, document }), [title, document]);
  const formValue = useMemo(() => ({ ...form, title }), [form, title]);

  // Saves land in the cache as they are: this skill, and its row in My skills.
  // Everything that reads every project (where it is installed, what a project
  // has) is asked again only when its identifier changes, or once on leaving.
  const live = useRef(true);
  const changed = useRef(false);
  const lastName = useRef(initial.summary.name);
  const remember = useCallback(
    (fresh: LocalSkill) => {
      client.setQueryData<LocalSkill>(keys.skill(id), (old) => (old ? fresh : old));
      client.setQueryData<LocalSkillSummary[]>(keys.skills, (list) =>
        list?.map((s) => (s.id === fresh.summary.id ? fresh.summary : s)),
      );
      if (fresh.summary.name !== lastName.current || !live.current) {
        lastName.current = fresh.summary.name;
        changed.current = false;
        invalidateSkills(client);
      } else {
        changed.current = true;
      }
    },
    [client, id],
  );
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      if (changed.current) invalidateSkills(client);
      changed.current = false;
    };
  }, [client]);

  const saved = useCallback(
    (fresh: LocalSkill) => {
      setSkill(fresh);
      remember(fresh);
    },
    [remember],
  );

  // A save runs only for the mode on screen. Leaving the window or the screen
  // flushes every autosave, and the rules form must not overwrite the YAML
  // typed in its place (nor the other way round).
  const docOn = !trashed && !broken;
  const formOn = !trashed && !yamlMode;
  const yamlOn = !trashed && yamlMode;
  const modes = useRef({ doc: docOn, form: formOn, yaml: yamlOn });
  modes.current = { doc: docOn, form: formOn, yaml: yamlOn };

  // What SKILL.md last saved as, to tell (as soon as something is typed, not a
  // pause later) whether the skill on screen is the one the diagnostics are for.
  const docSavedKey = useRef(docKey({ title: initial.summary.title, document: initial.document }));

  const docSave = useAutosave<DocValue>({
    value: docValue,
    keyOf: docKey,
    enabled: docOn,
    save: async (v) => {
      if (!modes.current.doc) return;
      const fresh = await api.saveSkillDocument(id, v.title, v.document, docDigest.current);
      docDigest.current = fresh.documentDigest;
      docSavedKey.current = docKey(v);
      saved(fresh);
    },
  });
  const formSave = useAutosave<ShareForm>({
    value: formValue,
    keyOf: formKey,
    enabled: formOn,
    save: async (v) => {
      if (!modes.current.form) return;
      const fresh = await api.saveSkillApplicability(id, v, metaDigest.current);
      metaDigest.current = fresh.metadataDigest;
      saved(fresh);
    },
  });
  const yamlSave = useAutosave<string>({
    value: yaml,
    keyOf: (v) => v,
    enabled: yamlOn,
    save: async (v) => {
      if (!modes.current.yaml) return;
      const fresh = await api.saveSkillMetadata(id, v, metaDigest.current);
      metaDigest.current = fresh.metadataDigest;
      saved(fresh);
    },
  });
  /** Whether the title, identifier and purpose on screen are the ones last saved (and checked). */
  const settled = docKey(docValue) === docSavedKey.current && docSave.state !== "saving";
  const saveState = worst(docSave.state, yamlMode ? yamlSave.state : formSave.state);

  const titleRef = useRef(title);
  titleRef.current = title;
  const resetDoc = docSave.reset;
  const resetForm = formSave.reset;
  const resetYaml = yamlSave.reset;

  /** Takes the version on disk as the truth for the named parts of the screen. */
  const adopt = useCallback(
    (fresh: LocalSkill, parts: { document: boolean; metadata: boolean }) => {
      setSkill(fresh);
      remember(fresh);
      if (parts.document) {
        docDigest.current = fresh.documentDigest;
        setTitle(fresh.summary.title);
        setDocument(fresh.document);
        docSavedKey.current = docKey({ title: fresh.summary.title, document: fresh.document });
        resetDoc(docSavedKey.current);
      }
      if (parts.metadata) {
        metaDigest.current = fresh.metadataDigest;
        const next = { ...fresh.form, title: parts.document ? fresh.summary.title : titleRef.current };
        setForm(next);
        resetForm(formKey(next));
        setYaml(fresh.metadataText ?? "");
        resetYaml(fresh.metadataText ?? "");
      }
    },
    [resetDoc, resetForm, resetYaml, remember],
  );

  const flushDoc = docSave.flush;
  const flushForm = formSave.flush;
  const flushYaml = yamlSave.flush;

  /** Writes pending edits; true when everything on screen is saved. */
  const flushAll = useCallback(async () => {
    const results = await Promise.all([flushDoc(), yamlMode ? flushYaml() : flushForm()]);
    return results.every(Boolean);
  }, [flushDoc, flushForm, flushYaml, yamlMode]);

  /** Before acting on what is on disk: stops (and says why) when edits are not saved. */
  const saveFirst = useCallback(async () => {
    const ok = await flushAll();
    if (!ok) setActionError(new Error(NOT_SAVED));
    return ok;
  }, [flushAll]);

  const reloadFromDisk = useCallback(async () => {
    try {
      adopt(await api.getSkill(id), { document: true, metadata: true });
    } catch (e) {
      setActionError(e);
    }
  }, [adopt, id]);

  const keepMine = async () => {
    try {
      const fresh = await api.getSkill(id);
      docDigest.current = fresh.documentDigest;
      metaDigest.current = fresh.metadataDigest;
      docSave.retry();
      formSave.retry();
      yamlSave.retry();
    } catch (e) {
      setActionError(e);
    }
  };

  const switchYaml = async (on: boolean) => {
    setActionError(null);
    try {
      // The rules on screen are written first; if they cannot be, the switch
      // would replace them with the version on disk, so it waits.
      if (!(await (on ? formSave.flush() : yamlSave.flush()))) {
        setActionError(new Error(NOT_SAVED));
        return;
      }
      const fresh = await api.getSkill(id);
      adopt(fresh, { document: false, metadata: true });
      setYamlMode(on);
    } catch (e) {
      setActionError(e);
    }
  };

  // ⌘S reassures: it writes immediately instead of waiting for the pause.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void flushAll();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flushAll]);

  const conflict =
    docSave.state === "conflict" || formSave.state === "conflict" || yamlSave.state === "conflict";
  const ruleSave = yamlMode ? yamlSave : formSave;
  const saveError =
    docSave.state === "error" ? docSave.error : ruleSave.state === "error" ? ruleSave.error : null;

  /** The rules on screen (saved or not), as the preview evaluates them. */
  const previewRequest = (projectId: string | null): PreviewRequest | null =>
    trashed
      ? null
      : yamlMode
        ? { skillId: id, form: null, metadataText: yaml, projectId: projectId ?? undefined }
        : { skillId: id, form: formValue, metadataText: null, projectId: projectId ?? undefined };
  const rulesKey = yamlMode
    ? `yaml:${yaml}`
    : JSON.stringify([
        form.matchMode,
        form.appliesTags,
        form.appliesDependencies,
        form.appliesFiles,
        form.excludeTags,
        form.excludeDependencies,
        form.repositoryScope,
        form.tools,
        form.conditionsEditable ? "" : skill.metadataDigest,
      ]);

  return {
    id,
    skill,
    title,
    setTitle,
    document,
    setDocument,
    form,
    setForm,
    yaml,
    setYaml,
    yamlMode,
    switchYaml,
    trashed,
    broken,
    saveState,
    settled,
    conflict,
    saveError,
    actionError,
    setActionError,
    adopt,
    flushAll,
    saveFirst,
    reloadFromDisk,
    keepMine,
    previewRequest,
    rulesKey,
  };
}

export type SkillDraft = ReturnType<typeof useSkillDraft>;
