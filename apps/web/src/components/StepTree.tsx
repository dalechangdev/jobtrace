import type { ApiTestStepResult } from "@jobtrace/api";
import type { Field as FieldDef, Recording, Step, Target } from "@jobtrace/core";
import { useMutation } from "@tanstack/react-query";
import { api } from "../api.ts";
import {
  describeLocator,
  describeStep,
  moveLocator,
  removeField,
  removeLocator,
  type TargetKey,
  targetsOf,
  updateField,
  updateStep,
  updateTarget,
} from "../lib/definition.ts";
import { duration } from "../lib/format.ts";
import { Badge, Button, ErrorNote, Field, Input, Select } from "../ui.tsx";

interface Editing {
  recording: Recording;
  onChange: (next: Recording) => void;
  /** Testing a step replays the saved recording, so it is unavailable while there are unsaved edits. */
  dirty: boolean;
}

/** The ranked ways of finding one element, with controls to reorder and remove them. */
function Locators({ target, onChange }: { target: Target; onChange: (next: Target) => void }) {
  return (
    <ol className="space-y-1" aria-label="Locators, tried in this order">
      {target.locators.map((locator, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: locators have no identity besides their position
        <li key={index} className="flex items-center gap-2 text-xs">
          <span className="w-4 shrink-0 text-right text-zinc-400">{index + 1}</span>
          <code
            className="min-w-0 flex-1 truncate rounded bg-zinc-100 px-1.5 py-0.5 dark:bg-zinc-800"
            title={describeLocator(locator)}
          >
            {describeLocator(locator)}
          </code>
          <Button
            size="sm"
            variant="ghost"
            aria-label="Try this locator earlier"
            disabled={index === 0}
            onClick={() => onChange(moveLocator(target, index, -1))}
          >
            ↑
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label="Try this locator later"
            disabled={index === target.locators.length - 1}
            onClick={() => onChange(moveLocator(target, index, 1))}
          >
            ↓
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label="Remove this locator"
            disabled={target.locators.length === 1}
            onClick={() => onChange(removeLocator(target, index))}
          >
            ✕
          </Button>
        </li>
      ))}
    </ol>
  );
}

function FieldEditor({
  field,
  index,
  onChange,
  onRemove,
  removable,
}: {
  field: FieldDef;
  index: number;
  onChange: (next: FieldDef) => void;
  onRemove: () => void;
  removable: boolean;
}) {
  return (
    <div
      className="space-y-2 rounded-md border border-zinc-200 p-3 dark:border-zinc-800"
      data-testid={`field-${index}`}
    >
      <div className="grid gap-2 sm:grid-cols-[1fr_9rem_auto]">
        <Field label="Field name">
          <Input
            value={field.name}
            onChange={(event) => onChange({ ...field, name: event.target.value })}
          />
        </Field>
        <Field label="Read">
          <Select
            value={field.read === "attr" ? `attr:${field.attr ?? ""}` : field.read}
            onChange={(event) => {
              const value = event.target.value;
              onChange(
                value.startsWith("attr:")
                  ? { ...field, read: "attr", attr: value.slice(5) || "href" }
                  : { ...field, read: value as "text" | "innerHTML", attr: null },
              );
            }}
          >
            <option value="text">Text</option>
            <option value="innerHTML">HTML</option>
            <option value={`attr:${field.read === "attr" ? (field.attr ?? "href") : "href"}`}>
              Attribute {field.read === "attr" ? (field.attr ?? "href") : "href"}
            </option>
          </Select>
        </Field>
        <div className="flex items-end gap-2 pb-1">
          <label className="flex items-center gap-1.5 text-xs">
            <Input
              type="checkbox"
              checked={field.required}
              onChange={(event) => onChange({ ...field, required: event.target.checked })}
            />
            Required
          </label>
          <Button size="sm" variant="ghost" disabled={!removable} onClick={onRemove}>
            Remove
          </Button>
        </div>
      </div>
      <Locators target={field.target} onChange={(target) => onChange({ ...field, target })} />
    </div>
  );
}

function TestResult({ result }: { result: ApiTestStepResult }) {
  return (
    <div className="space-y-1 text-xs" data-testid="test-result">
      <p className="flex items-center gap-2">
        <Badge tone={result.ok ? "green" : "red"}>
          {result.ok ? "Worked" : result.reached ? "Failed" : "Not reached"}
        </Badge>
        <span className="text-zinc-500">{duration(result.durationMs)}</span>
      </p>
      {result.error && <p className="text-red-700 dark:text-red-400">{result.error.message}</p>}
      {result.fields && (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3">
          {Object.entries(result.fields).map(([name, value]) => (
            <div key={name} className="contents">
              <dt className="text-zinc-500">{name}</dt>
              <dd className="truncate">{value ?? "(nothing found)"}</dd>
            </div>
          ))}
        </dl>
      )}
      {result.events
        .filter((event) => event.level === "warn")
        .map((event) => (
          <p key={event.ts + event.message} className="text-amber-700 dark:text-amber-400">
            {event.message}
          </p>
        ))}
    </div>
  );
}

function StepNode({ step, editing }: { step: Step; editing: Editing }) {
  const { recording, onChange, dirty } = editing;
  const test = useMutation({ mutationFn: () => api.recordings.testStep(recording.id, step.id) });
  const set = (change: (current: Step) => Step) => onChange(updateStep(recording, step.id, change));
  const setTarget = (key: TargetKey) => (target: Target) =>
    onChange(updateTarget(recording, step.id, key, () => target));
  const summary = describeStep(step);

  return (
    <li>
      <details
        className="group rounded-md border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
        data-testid={`step-${step.id}`}
      >
        <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm">
          <span className="font-mono text-xs text-zinc-400">{step.id}</span>
          <span className="font-medium">{step.type}</span>
          <span className="min-w-0 truncate text-zinc-500">{summary}</span>
        </summary>
        <div className="space-y-3 border-t border-zinc-200 p-3 dark:border-zinc-800">
          {step.type === "navigate" && (
            <Field label="Address" hint="May contain {{params.name}} placeholders.">
              <Input
                value={step.url}
                onChange={(event) =>
                  set((current) => ({ ...current, url: event.target.value }) as Step)
                }
              />
            </Field>
          )}
          {(step.type === "fill" || step.type === "select") && (
            <Field label={step.type === "fill" ? "Text to type" : "Option to choose"}>
              <Input
                value={step.value}
                onChange={(event) =>
                  set((current) => ({ ...current, value: event.target.value }) as Step)
                }
              />
            </Field>
          )}
          {step.type === "press" && (
            <Field label="Key">
              <Input
                value={step.key}
                onChange={(event) =>
                  set((current) => ({ ...current, key: event.target.value }) as Step)
                }
              />
            </Field>
          )}
          {step.type === "waitFor" && step.urlPattern !== undefined && (
            <Field
              label="Wait until the address matches"
              hint="* matches one path segment, ** matches anything."
            >
              <Input
                value={step.urlPattern}
                onChange={(event) =>
                  set((current) => ({ ...current, urlPattern: event.target.value }) as Step)
                }
              />
            </Field>
          )}
          {step.type === "openDetail" && (
            <Field label="Open each job's page">
              <Select
                value={step.strategy}
                onChange={(event) =>
                  set((current) => ({ ...current, strategy: event.target.value }) as Step)
                }
              >
                <option value="newTab">In a new tab (keeps the list as it is)</option>
                <option value="sameTab">In the same tab, then go back</option>
              </Select>
            </Field>
          )}
          {targetsOf(step).map(({ key, label, target }) => (
            <div key={key}>
              <p className="mb-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">
                {label}: tried in this order
              </p>
              <Locators target={target} onChange={setTarget(key)} />
            </div>
          ))}
          {step.type === "extract" && (
            <div className="space-y-2">
              {step.fields.map((field, index) => (
                <FieldEditor
                  // biome-ignore lint/suspicious/noArrayIndexKey: a field's name is being edited, so it cannot be the key
                  key={index}
                  index={index}
                  field={field}
                  removable={step.fields.length > 1}
                  onChange={(next) => onChange(updateField(recording, step.id, index, () => next))}
                  onRemove={() => onChange(removeField(recording, step.id, index))}
                />
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              size="sm"
              disabled={dirty || test.isPending}
              title={dirty ? "Save your changes first" : undefined}
              onClick={() => test.mutate()}
            >
              {test.isPending ? "Testing…" : "Test step"}
            </Button>
            {dirty && (
              <span className="text-xs text-zinc-500">Save your changes to test this step.</span>
            )}
          </div>
          {test.data && <TestResult result={test.data} />}
          <ErrorNote error={test.error} />
          {"body" in step && <StepList steps={step.body} editing={editing} />}
        </div>
      </details>
    </li>
  );
}

export function StepList({ steps, editing }: { steps: readonly Step[]; editing: Editing }) {
  if (steps.length === 0) return <p className="text-xs text-zinc-500">No steps.</p>;
  return (
    <ol className="space-y-2">
      {steps.map((step) => (
        <StepNode key={step.id} step={step} editing={editing} />
      ))}
    </ol>
  );
}
