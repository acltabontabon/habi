import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { flushAutosaves, useAutosave } from "./useAutosave";

/** A save the test settles by hand. */
function gate() {
  const writes: { value: string; done: () => void }[] = [];
  const save = vi.fn(
    (value: string) =>
      new Promise<void>((resolve) => {
        writes.push({ value, done: resolve });
      }),
  );
  return { save, writes };
}

const tick = () => act(async () => {});

describe("useAutosave", () => {
  it("never writes the same snapshot twice when flushes overlap", async () => {
    const { save, writes } = gate();
    const { result, rerender } = renderHook(
      ({ value }) => useAutosave({ value, keyOf: (v) => v, save, delay: 60_000 }),
      { initialProps: { value: "a" } },
    );
    rerender({ value: "b" });
    let first: Promise<boolean> = Promise.resolve(false);
    act(() => {
      first = result.current.flush();
    });
    expect(save).toHaveBeenCalledTimes(1);
    // Edited while "b" is being written; two more flushes wait behind it.
    rerender({ value: "c" });
    let second: Promise<boolean> = Promise.resolve(false);
    let third: Promise<boolean> = Promise.resolve(false);
    act(() => {
      second = result.current.flush();
      third = result.current.flush();
    });
    await act(async () => writes[0]?.done());
    await tick();
    expect(save).toHaveBeenCalledTimes(2);
    expect(writes[1]?.value).toBe("c");
    await act(async () => writes[1]?.done());
    expect(await Promise.all([first, second, third])).toEqual([true, true, true]);
    expect(save.mock.calls.map(([v]) => v)).toEqual(["b", "c"]);
  });

  it("holds flushAutosaves until the write of an editor that just closed has settled", async () => {
    const { save, writes } = gate();
    const { rerender, unmount } = renderHook(
      ({ value }) => useAutosave({ value, keyOf: (v) => v, save, delay: 60_000 }),
      { initialProps: { value: "a" } },
    );
    rerender({ value: "b" });
    unmount();
    expect(save).toHaveBeenCalledTimes(1);
    let settled = false;
    const all = flushAutosaves().then((ok) => {
      settled = true;
      return ok;
    });
    await tick();
    expect(settled).toBe(false);
    await act(async () => writes[0]?.done());
    expect(await all).toBe(true);
  });
});
