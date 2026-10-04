/** Settings choices in the app's own language: a few ordered options as knots on a thread. */
import { useId } from "react";

/** Every thread has the same four places, so threads line up one under another: the first and last option sit at the ends. */
const PLACES = 4;
const place = (i: number, n: number) => (n < 2 ? 1 : Math.round(1 + (i * (PLACES - 1)) / (n - 1)));

/** A few ordered choices on one thread; the chosen knot is lit. A radio group underneath, so arrows and Tab work. */
export function ThreadChoice<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; description?: string }[];
  onChange: (value: T) => void;
}) {
  const name = useId();
  return (
    <div className="thread-choice" role="radiogroup" aria-label={label}>
      {options.map((o, i) => (
        <label
          key={o.value}
          className={o.value === value ? "is-on" : undefined}
          title={o.description}
          style={{ gridColumn: place(i, options.length) }}
        >
          <input
            type="radio"
            name={name}
            checked={o.value === value}
            onChange={() => onChange(o.value)}
            aria-describedby={o.description ? `${name}-${i}` : undefined}
          />
          <span className="tc-knot" aria-hidden="true" />
          <span className="tc-label">{o.label}</span>
          {o.description && (
            <span id={`${name}-${i}`} hidden>
              {o.description}
            </span>
          )}
        </label>
      ))}
    </div>
  );
}
