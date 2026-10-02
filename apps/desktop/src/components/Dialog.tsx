/** Accessible modal dialog (Radix): focus trap, Escape to close, labelled. */
import * as RadixDialog from "@radix-ui/react-dialog";
import type { ReactNode } from "react";
import { Icon } from "./Icon";

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="dialog-scrim" />
        <RadixDialog.Content
          className={`dialog${wide ? " dialog-wide" : ""}`}
          // Without a description there is nothing to point to (and Radix would warn).
          {...(description ? {} : { "aria-describedby": undefined })}
        >
          <header className="dialog-head">
            <div>
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
