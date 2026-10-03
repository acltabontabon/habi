/** Accessible modal dialog (Radix): focus trap, Escape to close, labelled. */
import * as RadixDialog from "@radix-ui/react-dialog";
import type { ReactNode } from "react";
import { Icon } from "./Icon";
import { keepOpenForToasts } from "./Toasts";

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  mark,
  children,
  footer,
  wide,
  steady,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  /** A small identity (a woven swatch) shown before the title. */
  mark?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  /** Hangs from a fixed top edge, so a change in height moves only the bottom and never shifts the top. */
  steady?: boolean;
}) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="dialog-scrim" />
        <RadixDialog.Content
          className={`dialog${wide ? " dialog-wide" : ""}${steady ? " dialog-steady" : ""}`}
          // Without a description there is nothing to point to (and Radix would warn).
          {...(description ? {} : { "aria-describedby": undefined })}
          onPointerDownOutside={keepOpenForToasts}
        >
          <header className="dialog-head">
            {mark ? <div className="dialog-mark">{mark}</div> : null}
            <div className="dialog-heading">
              <RadixDialog.Title className="dialog-title">{title}</RadixDialog.Title>
              {description ? (
                <RadixDialog.Description className="dialog-description">
                  {description}
                </RadixDialog.Description>
              ) : null}
            </div>
            <RadixDialog.Close className="icon-btn" aria-label="Close">
              <Icon name="close" />
            </RadixDialog.Close>
          </header>
          <div className="dialog-body">{children}</div>
          {footer ? <footer className="dialog-foot">{footer}</footer> : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
