import {
  CLI_PROXY_MODEL_CHANNELS,
  cliProxyGroups,
  cliProxyModelLabels,
  cliProxyModels,
  cliProxyPools,
  cliProxyWithPools,
  type CliProxyModel,
  type CliProxyPool,
} from "@t3tools/client-runtime/cli-proxy";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Spinner } from "../../ui/spinner";
import { SettingsRow, SettingsSection } from "../settingsLayout";
import { useManaged, useManagedAll, type ModelProxyManage } from "./useModelProxy";

const DEFINITION_PATHS = CLI_PROXY_MODEL_CHANNELS.map(
  (channel) => `/v8/management/routing/model-definitions/${channel}`,
);

const slugify = (label: string) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);

/** The first client key in a v8 config, which pools use to call the proxy itself. */
function firstClientKey(config: unknown): string | null {
  const access =
    typeof config === "object" && config !== null
      ? (config as Record<string, unknown>).access
      : null;
  const keys =
    typeof access === "object" && access !== null
      ? (access as Record<string, unknown>)["api-keys"]
      : null;
  const key = Array.isArray(keys) ? keys.find((entry) => typeof entry === "string") : null;
  return typeof key === "string" ? key : null;
}

/**
 * The models the proxy serves and its failover pools: one model name backed by an ordered
 * list, where the next model serves when the one before it is at its limit.
 */
export function ModelProxyModels({
  manage,
  proxyUrl,
  disabled,
  onChanged,
}: {
  readonly manage: ModelProxyManage;
  readonly proxyUrl: string;
  readonly disabled: boolean;
  /** After pools change, so T3 Code's provider lists them. */
  readonly onChanged: () => void;
}) {
  const models = useManaged(manage, "/v1/models");
  const config = useManaged(manage, "/v8/management/config");
  const [editing, setEditing] = useState<CliProxyPool | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const definitions = useManagedAll(manage, DEFINITION_PATHS);
  const groups = config.data === null ? {} : cliProxyGroups(config.data);
  const list = cliProxyModels(models.data, cliProxyModelLabels(definitions ?? [], groups));
  const pools = cliProxyPools(groups);
  const poolAliases = new Set(pools.map((pool) => pool.alias));
  const choices = list.filter((model) => !poolAliases.has(model.id));

  const save = (next: ReadonlyArray<CliProxyPool>) => {
    const clientKey = firstClientKey(config.data);
    if (clientKey === null) {
      setError("The proxy has no client key for pools to call it with. Add one under Keys.");
      return;
    }
    setSaving(true);
    setError(null);
    const groups = cliProxyWithPools(cliProxyGroups(config.data), next, { proxyUrl, clientKey });
    void manage("PUT", "/v8/management/config/api-keys/openai-compatibility", groups).then(
      (result) => {
        setSaving(false);
        if ("error" in result) return setError(result.error);
        setEditing(null);
        config.reload();
        models.reload();
        onChanged();
      },
    );
  };

  return (
    <>
      <SettingsSection
        title="Failover pools"
        headerAction={
          <Button
            size="xs"
            variant="outline"
            disabled={disabled || config.data === null}
            onClick={() => setEditing("new")}
          >
            <PlusIcon className="size-3" aria-hidden />
            New pool
          </Button>
        }
      >
        {error ? <SettingsRow title={<span className="text-destructive">{error}</span>} /> : null}
        {editing !== null ? (
          <PoolEditor
            initial={editing === "new" ? null : editing}
            models={choices}
            taken={new Set([...list.map((model) => model.id), ...poolAliases])}
            saving={saving}
            onCancel={() => setEditing(null)}
            onSave={(pool) =>
              save([
                ...pools.filter(
                  (existing) => editing === "new" || existing.alias !== editing.alias,
                ),
                pool,
              ])
            }
          />
        ) : null}
        {config.data === null ? (
          <SettingsRow
            title={config.error ?? "Reading pools…"}
            control={config.error ? null : <Spinner className="size-3.5" />}
          />
        ) : pools.length === 0 ? (
          <SettingsRow
            title="No pools"
            description="A pool is one model name that tries its models in order: when one is at its usage limit, the next one answers."
          />
        ) : (
          pools.map((pool) => (
            <SettingsRow
              key={pool.alias}
              title={pool.label}
              description={pool.members
                .map((member) => list.find((model) => model.id === member)?.label ?? member)
                .join(" → ")}
              control={
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={disabled || saving}
                    onClick={() => {
                      if (window.confirm(`Delete the pool ${pool.label}?`)) {
                        save(pools.filter((existing) => existing.alias !== pool.alias));
                      }
                    }}
                  >
                    Delete
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={disabled || saving}
                    onClick={() => setEditing(pool)}
                  >
                    Edit
                  </Button>
                </div>
              }
            />
          ))
        )}
      </SettingsSection>
      <SettingsSection title="Models">
        {models.data === null ? (
          <SettingsRow
            title={models.error ?? "Reading models…"}
            control={models.error ? null : <Spinner className="size-3.5" />}
          />
        ) : list.length === 0 ? (
          <SettingsRow
            title="No models"
            description="Models appear once an account or API-key provider is added and available."
          />
        ) : (
          <SettingsRow
            title={`${list.length} models`}
            description={list.map((model) => model.label).join(" · ")}
          />
        )}
      </SettingsSection>
    </>
  );
}

function PoolEditor({
  initial,
  models,
  taken,
  saving,
  onCancel,
  onSave,
}: {
  readonly initial: CliProxyPool | null;
  readonly models: ReadonlyArray<CliProxyModel>;
  readonly taken: ReadonlySet<string>;
  readonly saving: boolean;
  readonly onCancel: () => void;
  readonly onSave: (pool: CliProxyPool) => void;
}) {
  const [label, setLabel] = useState(initial?.label ?? "");
  const [members, setMembers] = useState<ReadonlyArray<string>>(initial?.members ?? []);
  const alias = initial?.alias ?? slugify(label);
  const nameTaken = initial === null && taken.has(alias);
  const canSave =
    !saving && label.trim() !== "" && alias !== "" && !nameTaken && members.length >= 2;
  const nameOf = (id: string) => models.find((model) => model.id === id)?.label ?? id;
  const move = (index: number, by: -1 | 1) => {
    const next = [...members];
    const [item] = next.splice(index, 1);
    if (item !== undefined) next.splice(index + by, 0, item);
    setMembers(next);
  };

  return (
    <SettingsRow
      title={initial === null ? "New pool" : `Edit ${initial.label}`}
      description={
        nameTaken
          ? "A model or pool already has that name."
          : "First choice first. Two or more models."
      }
      control={
        <div className="flex w-full min-w-72 flex-col gap-2">
          <Input
            size="sm"
            aria-label="Pool name"
            placeholder="Name, e.g. Luna, else Muse"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
          {members.map((member, index) => (
            <div key={member} className="flex items-center gap-1">
              <span className="w-5 text-muted-foreground text-xs">{index + 1}.</span>
              <span className="min-w-0 flex-1 truncate text-sm">{nameOf(member)}</span>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Move ${nameOf(member)} up`}
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                <ArrowUpIcon />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Move ${nameOf(member)} down`}
                disabled={index === members.length - 1}
                onClick={() => move(index, 1)}
              >
                <ArrowDownIcon />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Remove ${nameOf(member)}`}
                onClick={() => setMembers(members.filter((entry) => entry !== member))}
              >
                <XIcon />
              </Button>
            </div>
          ))}
          <Select value="" onValueChange={(next) => next && setMembers([...members, next])}>
            <SelectTrigger size="sm" aria-label="Add a model to the pool">
              <SelectValue>
                {members.length === 0 ? "Add the first model" : "Add a fallback"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {models
                .filter((model) => !members.includes(model.id))
                .map((model) => (
                  <SelectItem key={model.id} value={model.id}>
                    {model.label}
                  </SelectItem>
                ))}
            </SelectPopup>
          </Select>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!canSave}
              onClick={() => onSave({ alias, label: label.trim(), members })}
            >
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      }
    />
  );
}
