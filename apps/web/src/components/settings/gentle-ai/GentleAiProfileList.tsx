import { ChevronRightIcon, PlusIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "../../../lib/utils";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Spinner } from "../../ui/spinner";
import { SettingsRow, SettingsSection } from "../settingsLayout";

const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

export interface GentleAiProfileListItem {
  readonly name: string;
  /** What the profile runs, in a line. */
  readonly summary: string;
}

/**
 * An agent's model profiles as one list: each row says what the profile runs, the one in use
 * is marked, the others have Use, and a row opens its editor in place. Pi and Claude Code share
 * it, so switching and editing profiles work the same for both.
 */
export function GentleAiProfileList({
  title,
  profiles,
  active,
  loading,
  error,
  emptyText,
  disabled,
  builtIn,
  onUse,
  onCreate,
  renderEditor,
}: {
  readonly title: string;
  readonly profiles: ReadonlyArray<GentleAiProfileListItem>;
  readonly active: string | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly emptyText: string;
  readonly disabled: boolean;
  /** A first row for the agent's own models, used when no profile is; `summary` says what runs then. */
  readonly builtIn?: {
    readonly label: string;
    readonly summary: string;
    readonly onUse: () => void;
  };
  readonly onUse: (name: string) => void;
  /** Creates a profile, a copy of the one in use; resolves once it exists. */
  readonly onCreate: (name: string) => Promise<boolean>;
  readonly renderEditor: (name: string) => ReactNode;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [naming, setNaming] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const newName = naming?.trim() ?? "";
  const nameTaken = profiles.some((profile) => profile.name === newName);
  const canCreate = !creating && PROFILE_NAME.test(newName) && !nameTaken;
  const create = () => {
    if (!canCreate) return;
    setCreating(true);
    void onCreate(newName).then((created) => {
      setCreating(false);
      if (!created) return;
      setNaming(null);
      setOpen(newName);
    });
  };

  return (
    <SettingsSection
      title={title}
      headerAction={
        naming === null ? (
          <Button
            size="xs"
            variant="outline"
            disabled={disabled || loading}
            onClick={() => setNaming("")}
          >
            <PlusIcon className="size-3" aria-hidden />
            New
          </Button>
        ) : null
      }
    >
      {naming === null ? null : (
        <SettingsRow
          title="New profile"
          description={
            nameTaken
              ? "A profile already has that name."
              : active === null
                ? "Starts empty."
                : `Starts as a copy of ${active}.`
          }
          control={
            <div className="flex items-center gap-2">
              <Input
                size="sm"
                autoFocus
                aria-label="New profile name"
                placeholder="Name"
                value={naming}
                disabled={creating}
                onChange={(event) => setNaming(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") create();
                  if (event.key === "Escape") setNaming(null);
                }}
              />
              <Button size="sm" disabled={!canCreate} onClick={create}>
                {creating ? <Spinner className="size-3.5" /> : null}
                Create
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setNaming(null)}>
                Cancel
              </Button>
            </div>
          }
        />
      )}
      {loading || error ? (
        <SettingsRow
          title={error ?? "Reading profiles…"}
          control={error ? null : <Spinner className="size-3.5" />}
        />
      ) : profiles.length === 0 ? (
        <SettingsRow title="No profiles yet" description={emptyText} />
      ) : (
        <>
          {builtIn === undefined ? null : (
            <SettingsRow
              // Indented past the chevron the profile rows have.
              title={<span className="pl-5">{builtIn.label}</span>}
              description={builtIn.summary}
              control={
                active === null ? (
                  <span className="text-sm text-success">In use</span>
                ) : (
                  <Button size="sm" variant="outline" disabled={disabled} onClick={builtIn.onUse}>
                    Use
                  </Button>
                )
              }
            />
          )}
          {profiles.map((profile) => {
            const isOpen = open === profile.name;
            const isActive = profile.name === active;
            return (
              <SettingsRow
                key={profile.name}
                title={
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    onClick={() => setOpen(isOpen ? null : profile.name)}
                    className="flex min-w-0 items-center gap-1.5 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <ChevronRightIcon
                      aria-hidden
                      className={cn(
                        "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none",
                        isOpen && "rotate-90",
                      )}
                    />
                    <span className="truncate">{profile.name}</span>
                  </button>
                }
                description={profile.summary}
                control={
                  isActive ? (
                    <span className="text-sm text-success">In use</span>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={disabled}
                      onClick={() => onUse(profile.name)}
                    >
                      Use
                    </Button>
                  )
                }
              >
                {isOpen ? <div className="pt-3 pb-1">{renderEditor(profile.name)}</div> : null}
              </SettingsRow>
            );
          })}
        </>
      )}
    </SettingsSection>
  );
}
