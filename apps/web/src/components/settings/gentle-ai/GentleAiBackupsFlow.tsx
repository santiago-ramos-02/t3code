import type { GentleAiBackup } from "@t3tools/contracts";
import { EllipsisIcon, PinIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../ui/menu";
import { Spinner } from "../../ui/spinner";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsRow } from "../settingsLayout";
import { GentleAiConfirm } from "./GentleAiConfirm";
import { GentleAiFlowHeader } from "./GentleAiFlow";
import type { GentleAiSectionProps } from "./GentleAiSettingsPage";
import { useGentleAiQuery } from "./useGentleAi";

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function backupDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : dateFormat.format(date);
}

/** Gentle AI's backups, in place of the page: taken before installs, syncs, upgrades, and uninstalls. */
export function GentleAiBackupsFlow({
  environmentId,
  disabled,
  startJob,
  onError,
  onClose,
}: GentleAiSectionProps & { readonly onClose: () => void }) {
  const backups = useGentleAiQuery(environmentId, "backups.list", {});
  const [confirm, setConfirm] = useState<{
    kind: "restore" | "delete";
    backup: GentleAiBackup;
  } | null>(null);
  const [renaming, setRenaming] = useState<{ backup: GentleAiBackup; value: string } | null>(null);
  const list = backups.data?.backups ?? [];

  const run = (promise: Promise<string | null>) =>
    void promise.then((error) => {
      if (error) onError(error);
    });

  return (
    <section className="space-y-4">
      <GentleAiFlowHeader
        title="Backups"
        description="Gentle AI backs up agent files before it installs, syncs, upgrades, or uninstalls. Restoring puts those files back as they were."
        onBack={onClose}
      />
      <SettingsGroup>
        {backups.error ? (
          <SettingsRow title="Backups unavailable" description={backups.error} />
        ) : backups.data === null ? (
          <SettingsRow title="Reading backups" control={<Spinner className="size-3.5" />} />
        ) : list.length === 0 ? (
          <SettingsRow title="No backups yet" />
        ) : (
          list.map((backup) => (
            <BackupRow
              key={backup.id}
              backup={backup}
              disabled={disabled}
              onRestore={() => setConfirm({ kind: "restore", backup })}
              onDelete={() => setConfirm({ kind: "delete", backup })}
              renaming={renaming?.backup.id === backup.id ? renaming.value : null}
              onRename={() => setRenaming({ backup, value: backup.description })}
              onRenameChange={(value) => setRenaming({ backup, value })}
              onRenameCancel={() => setRenaming(null)}
              onRenameSave={() => {
                if (renaming === null || renaming.value.trim() === "") return;
                run(
                  startJob("backups.rename", {
                    id: renaming.backup.id,
                    description: renaming.value.trim(),
                  }),
                );
                setRenaming(null);
              }}
              onTogglePin={() =>
                run(startJob("backups.pin", { id: backup.id, pinned: !backup.pinned }))
              }
            />
          ))
        )}
      </SettingsGroup>
      <GentleAiConfirm
        open={confirm !== null}
        onOpenChange={(open) => (open ? undefined : setConfirm(null))}
        title={confirm?.kind === "delete" ? "Delete this backup?" : "Restore this backup?"}
        description={
          confirm?.kind === "delete"
            ? "It is removed from disk and cannot be restored afterward."
            : "Agent files it covers go back to how they were when it was taken. Changes made since then to those files are replaced."
        }
        confirmLabel={confirm?.kind === "delete" ? "Delete" : "Restore"}
        destructive={confirm?.kind === "delete"}
        onConfirm={() => {
          if (confirm === null) return;
          run(
            confirm.kind === "delete"
              ? startJob("backups.delete", { id: confirm.backup.id })
              : startJob("backups.restore", { id: confirm.backup.id }),
          );
        }}
      />
    </section>
  );
}

function BackupRow({
  backup,
  disabled,
  onRestore,
  onDelete,
  onRename,
  onTogglePin,
  renaming,
  onRenameChange,
  onRenameCancel,
  onRenameSave,
}: {
  readonly backup: GentleAiBackup;
  readonly disabled: boolean;
  readonly onRestore: () => void;
  readonly onDelete: () => void;
  readonly onRename: () => void;
  readonly onTogglePin: () => void;
  /** The description being edited in place, or null when not renaming. */
  readonly renaming: string | null;
  readonly onRenameChange: (value: string) => void;
  readonly onRenameCancel: () => void;
  readonly onRenameSave: () => void;
}) {
  if (renaming !== null)
    return (
      <SettingsRow
        title={
          <Input
            size="sm"
            aria-label="Backup description"
            value={renaming}
            onChange={(event) => onRenameChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onRenameSave();
              if (event.key === "Escape") onRenameCancel();
            }}
            autoFocus
          />
        }
        control={
          <div className="flex items-center gap-1">
            <Button size="sm" variant="ghost" onClick={onRenameCancel}>
              Cancel
            </Button>
            <Button size="sm" disabled={renaming.trim() === ""} onClick={onRenameSave}>
              Save
            </Button>
          </div>
        }
      />
    );
  return (
    <SettingsRow
      title={
        <span className="flex min-w-0 items-center gap-1.5">
          {backup.pinned ? <PinIcon className="size-3.5 shrink-0" aria-label="Pinned" /> : null}
          <span className="truncate">{backup.description || backup.source}</span>
        </span>
      }
      description={[
        backupDate(backup.createdAt),
        backup.source,
        `${backup.fileCount} ${backup.fileCount === 1 ? "file" : "files"}`,
        backup.createdByVersion ? `v${backup.createdByVersion}` : null,
      ]
        .filter((part) => part !== null && part !== "")
        .join(" · ")}
      control={
        <div className="flex items-center gap-1">
          <Button size="sm" variant="outline" disabled={disabled} onClick={onRestore}>
            Restore
          </Button>
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="More backup actions"
                  disabled={disabled}
                />
              }
            >
              <EllipsisIcon aria-hidden />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onClick={onTogglePin}>{backup.pinned ? "Unpin" : "Pin"}</MenuItem>
              <MenuItem onClick={onRename}>Rename</MenuItem>
              <MenuItem variant="destructive" onClick={onDelete}>
                Delete
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      }
    />
  );
}
